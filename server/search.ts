/**
 * `server/search.ts` — the FTS5 engine behind `GET /api/search`
 * (design-server.md §7 "Search", design-ux.md §3 Search).
 *
 * Ported from `kalam/server/retrieval.py::_keyword_search`, with the two things
 * that make it safe on a 3.57M-بيت index:
 *
 *  1. **The query is never syntax.** `ftsQuery()` in `shared/arabic.ts` is the
 *     ONLY builder: it normalises exactly the way the index was normalised and
 *     wraps every term in double quotes, so `AND`, `OR`, `NOT`, `NEAR(a b)`,
 *     `*`, `^`, `:`, `-`, unbalanced quotes and parens all arrive at SQLite as
 *     literal words. There is no code path here that concatenates user text
 *     into SQL, and an empty query never reaches SQLite at all (an empty MATCH
 *     expression is an FTS5 *error*, not an empty result).
 *  2. **A bounded inner scan.** Each of the three FTS tables is scanned in one
 *     `hits` CTE capped at `SEARCH_SCAN_CAP` rows by `bm25()`, and only those
 *     survivors are joined out to poems/poets/meters/eras and filtered. The
 *     joins therefore see ≤400 rows no matter how common the word is — this is
 *     the same "sort narrow, join the survivors" rule `listPoems` and
 *     `/api/baits` follow (CLAUDE.md invariant), applied to a ranked scan.
 *
 * Consequences of (2) worth knowing before you read `total`: the counts this
 * module returns are counts *within the bounded scan*, i.e. `min(matches, 400)`
 * before filters and ≤400 after them. An exact corpus-wide count is available
 * cheaply (`SELECT COUNT(*) FROM baits_fts WHERE baits_fts MATCH ?` — 18 ms for
 * a term matching 757,141 أبيات) and is deliberately NOT what is reported: it
 * would tell the client to offer 37,857 pages of a result set that stops at
 * 400. `total` is the number of hits this route can actually hand over, which
 * is the number pagination has to agree with.
 *
 * Three more decisions, all visible on the wire:
 *
 *  • **`highlight` is a snippet of the NORMALISED column**, sent ALONGSIDE the
 *    original `sadr`/`ajuz`. `»…«` marks the matched words; design-ux.md §3 +
 *    amendment 14 have the client map those words back onto the original text
 *    through `foldedIndex` and render them as a lapis underline. The server
 *    never sends the normalised text as the thing to display — it has no
 *    tashkeel.
 *  • **`score` is `-bm25()`**, so bigger is better and the number is positive.
 *    Raw bm25 is negative-and-smaller-is-better, which is a trap on the wire.
 *  • **The poets list ignores `meter` and `rhyme`.** Those are poem-level
 *    dimensions; a شاعر does not have a بحر. `era` and `poet` do apply. The
 *    baits list reads `rhyme` as the بيت's own روي (`baits.rawiyy`, matching
 *    `/api/baits`), the poems list as the قصيدة's modal روي (`poems.rhyme`).
 */

import { ftsQuery, ftsTerms } from "../shared/arabic.ts"
import type { BaitHit, PoemHit, PoetHit, SearchMode, SearchQuery, SearchScope } from "../shared/schema.ts"
import type { Db } from "./db.ts"
import {
  BAIT_COLS,
  BAIT_CONTEXT_COLS,
  BAIT_JOINS,
  POEM_COLS,
  POEM_JOINS,
  POET_COLS,
  POET_JOINS,
  baitDto,
  num,
  poemSummary,
  poetSummary,
  strOrNull,
  type Row,
} from "./dto.ts"
import { offsetOf, poetIdBySlug, slugMaps } from "./query.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Tunables (exported so the tests assert the documented numbers, not literals)
// ─────────────────────────────────────────────────────────────────────────────

/** design-server.md §7 + §12: "filtered FTS degenerates → 400-row inner cap". */
export const SEARCH_SCAN_CAP = 400

/** amendment 14 — the client parses these two into `<mark>`. */
export const SNIPPET_OPEN = "»"
export const SNIPPET_CLOSE = "«"
const SNIPPET_ELLIPSIS = " … "
const SNIPPET_TOKENS = 24

/** `snippet(<table>, <col>, …)`; −1 lets FTS5 pick the column that matched. */
function snippetOf(table: string, column: number, idExpr: string): string {
  return `(SELECT snippet(${table}, ${column}, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '${SNIPPET_ELLIPSIS}', ${SNIPPET_TOKENS})
           FROM ${table} WHERE ${table} MATCH ? AND rowid = ${idExpr})`
}

/**
 * The bounded scan of one FTS table. `MATERIALIZED` is deliberate: the whole
 * point is that the 400-row cap is paid ONCE and the outer joins never see the
 * full match set.
 *
 * `ranked = false` drops the `ORDER BY bm25()` — see `highDfTerms` for when and
 * why. The cap bounds the JOINS either way; only the ORDER BY makes SQLite
 * visit every posting before it can answer.
 */
function hitsCte(table: string, ranked: boolean): string {
  const order = ranked ? "ORDER BY score ASC, rowid ASC " : ""
  return `WITH hits AS MATERIALIZED (
            SELECT rowid AS ref, bm25(${table}) AS score
            FROM ${table} WHERE ${table} MATCH ?
            ${order}LIMIT ${SEARCH_SCAN_CAP})`
}

/**
 * The terms so common that ranking them costs more than the answer is worth.
 *
 * `SEARCH_SCAN_CAP` caps the rows RETURNED, not the rows SCORED: `ORDER BY
 * bm25()` cannot answer until every posting in the term's list has a score, so
 * the cost is linear in document frequency and the cap never bites. Measured on
 * data/qarid.db: «من» (757,141 أبيات) 287 ms ranked against 13 ms unranked,
 * «في» (721,320) 255 ms, «ما» (323,236) 122 ms — and «من» and «في» are complete
 * words a reader types, and also the prefix of «منزل»/«فيها» at any pause. Over
 * HTTP with the omnibox's own shape that was p50 328 ms, 2.2× the 150 ms budget
 * and 328 ms of a blocked event loop for every other visitor.
 *
 * `scripts/ingest/build.ts` derives the set from `fts5vocab` over `baits_fts`
 * at ingest (`HIGH_DF_MIN` documents, 38 terms on the real corpus) and writes it
 * to `meta.high_df_terms`; an artefact built before that key simply ranks
 * everything, exactly as it used to.
 *
 * When the whole query lands in that set there is nothing for bm25 to separate
 * — every hit contains the same near-universal word — so the first 400 by rowid
 * are as good an answer as the first 400 by score, and 25× cheaper. The rule
 * differs by mode because the cost does: an AND (or a phrase) is as cheap as
 * its RAREST term, so one uncommon word makes ranking affordable again; an OR
 * walks every posting of every term, so a single common one is enough to hurt.
 */
const HIGH_DF = new WeakMap<object, ReadonlySet<string>>()

function highDfTerms(db: Db): ReadonlySet<string> {
  const cached = HIGH_DF.get(db as object)
  if (cached !== undefined) return cached
  const row = db.q("SELECT value FROM meta WHERE key = 'high_df_terms'").get() as { value: string } | undefined
  let set: ReadonlySet<string> = new Set()
  try {
    const parsed = row === undefined ? null : JSON.parse(row.value)
    if (Array.isArray(parsed)) set = new Set(parsed.filter((t): t is string => typeof t === "string"))
  } catch {
    set = new Set()
  }
  HIGH_DF.set(db as object, set)
  return set
}

/** Is ranking this query affordable? See `highDfTerms`. */
export function shouldRank(db: Db, terms: readonly string[], mode: SearchMode): boolean {
  return rankDecision(highDfTerms(db), terms, mode)
}

/** The rule itself, artefact-free so a test can state it in one line. */
export function rankDecision(high: ReadonlySet<string>, terms: readonly string[], mode: SearchMode): boolean {
  if (terms.length === 0 || high.size === 0) return true
  const words = terms.flatMap((t) => t.split(" ")).filter((t) => t !== "")
  if (words.length === 0) return true
  return mode === "or" ? !words.some((t) => high.has(t)) : !words.every((t) => high.has(t))
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchFilters {
  era?: string
  meter?: string
  poet?: string
  rhyme?: string
}

interface SqlFilter {
  where: string
  params: Array<string | number>
  /** a slug named nothing in the artefact — provably empty, never a 400 */
  impossible: boolean
  /** the WHERE mentions `baits b` (the count query joins it only then) */
  needsBaits: boolean
  /** the WHERE mentions `poems p` */
  needsPoems: boolean
}

function finish(where: string[], params: Array<string | number>, impossible: boolean, needsBaits: boolean, needsPoems: boolean): SqlFilter {
  return { where: where.length === 0 ? "1 = 1" : where.join(" AND "), params, impossible, needsBaits, needsPoems }
}

/** Filter for a بيت hit: روي off the بيت itself, the rest off its قصيدة. */
function baitFilter(db: Db, q: SearchFilters): SqlFilter {
  const maps = slugMaps(db)
  const where: string[] = []
  const params: Array<string | number> = []
  let impossible = false
  let needsBaits = false
  let needsPoems = false

  if (q.rhyme !== undefined) {
    where.push("b.rawiyy = ?")
    params.push(q.rhyme)
    needsBaits = true
  }
  const poemCol = (slug: string | undefined, map: Map<string, number>, column: string) => {
    if (slug === undefined) return
    const id = map.get(slug)
    if (id === undefined) {
      impossible = true
      return
    }
    where.push(`${column} = ?`)
    params.push(id)
    needsBaits = true
    needsPoems = true
  }
  poemCol(q.era, maps.era, "p.era_id")
  poemCol(q.meter, maps.meter, "p.meter_id")
  if (q.poet !== undefined) {
    const id = poetIdBySlug(db, q.poet)
    if (id === null) impossible = true
    else {
      where.push("p.poet_id = ?")
      params.push(id)
      needsBaits = true
      needsPoems = true
    }
  }
  return finish(where, params, impossible, needsBaits, needsPoems)
}

/** Filter for a قصيدة hit — every dimension lives on `poems` itself. */
function poemHitFilter(db: Db, q: SearchFilters): SqlFilter {
  const maps = slugMaps(db)
  const where: string[] = []
  const params: Array<string | number> = []
  let impossible = false
  let needsPoems = false

  const col = (slug: string | undefined, map: Map<string, number>, column: string) => {
    if (slug === undefined) return
    const id = map.get(slug)
    if (id === undefined) {
      impossible = true
      return
    }
    where.push(`${column} = ?`)
    params.push(id)
    needsPoems = true
  }
  col(q.era, maps.era, "p.era_id")
  col(q.meter, maps.meter, "p.meter_id")
  if (q.rhyme !== undefined) {
    where.push("p.rhyme = ?")
    params.push(q.rhyme)
    needsPoems = true
  }
  if (q.poet !== undefined) {
    const id = poetIdBySlug(db, q.poet)
    if (id === null) impossible = true
    else {
      where.push("p.poet_id = ?")
      params.push(id)
      needsPoems = true
    }
  }
  return finish(where, params, impossible, false, needsPoems)
}

/**
 * Filter for a شاعر hit. `meter`/`rhyme` are poem-level and are deliberately
 * NOT applied — see the module header.
 */
function poetHitFilter(db: Db, q: SearchFilters): SqlFilter {
  const maps = slugMaps(db)
  const where: string[] = []
  const params: Array<string | number> = []
  let impossible = false

  if (q.era !== undefined) {
    const id = maps.era.get(q.era)
    if (id === undefined) impossible = true
    else {
      where.push("po.era_id = ?")
      params.push(id)
    }
  }
  if (q.poet !== undefined) {
    const id = poetIdBySlug(db, q.poet)
    if (id === null) impossible = true
    else {
      where.push("po.id = ?")
      params.push(id)
    }
  }
  return finish(where, params, impossible, false, false)
}

// ─────────────────────────────────────────────────────────────────────────────
// One page of one scope — two queries, ONE ranked scan
// ─────────────────────────────────────────────────────────────────────────────
//
// The obvious shape (count query + page query, both wrapping the `hits` CTE)
// pays the ranked scan TWICE, and the ranked scan is the whole cost: the worst
// realistic term, «من» (757,141 أبيات on the real corpus), takes 280 ms to rank
// and 0.3 ms to snippet twenty rows. So the scan runs once, narrow — ids and
// scores only — and the ≤`limit` survivors are joined out by primary key in a
// second, trivial query. Measured on data/qarid.db: 280 ms → 285 ms total for
// «من», against 660 ms for the two-CTE version.

interface Page<T> {
  items: T[]
  total: number
}

const NONE: Page<never> = { items: [], total: 0 }

/** One ranked hit: a rowid in the base table and its `-bm25()` score. */
interface Ranked {
  ref: number
  /** `-bm25()`: positive, and bigger means a better match */
  score: number
}

/**
 * The bounded ranked scan, filtered. Returns at most `SEARCH_SCAN_CAP` rows in
 * rank order — which is also why `total` is "within the bounded scan".
 */
function rankedRefs(db: Db, table: string, joins: string, filter: SqlFilter, match: string, ranked = true): Ranked[] {
  const rows = db
    .q(`${hitsCte(table, ranked)} SELECT h.ref AS ref, h.score AS score FROM hits h ${joins} WHERE ${filter.where} ORDER BY h.score ASC, h.ref ASC`)
    .all(match, ...filter.params) as Row[]
  return rows.map((r) => ({ ref: num(r.ref), score: -num(r.score) }))
}

/**
 * `rankedRefs` for `poets_fts`, ordered the way `searchPoets` documents: a NAME
 * hit first, then fame, then bm25. `poets` is always joined (the filter may not
 * need it, but fame does) and the column-filtered MATCH runs as a subquery, so
 * the whole ranking is still one statement and one prepared-statement shape.
 */
function rankedPoetRefs(db: Db, filter: SqlFilter, match: string): Ranked[] {
  const rows = db
    .q(
      `${hitsCte("poets_fts", true)}
       SELECT h.ref AS ref, h.score AS score
       FROM hits h JOIN poets po ON po.id = h.ref
       WHERE ${filter.where}
       ORDER BY (h.ref IN (SELECT rowid FROM poets_fts WHERE poets_fts MATCH ?)) DESC,
                po.fame DESC, h.score ASC, h.ref ASC`,
    )
    // `?` parameters are numbered by their position in the SQL TEXT: the CTE's
    // MATCH, then the WHERE's filter params, and only then the ORDER BY's
    // column-filtered MATCH.
    .all(match, ...filter.params, `{norm_name} : (${match})`) as Row[]
  return rows.map((r) => ({ ref: num(r.ref), score: -num(r.score) }))
}

/** `IN (?, ?, …)` for a page of ids — at most `limit` (≤40) placeholders. */
function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ")
}

/**
 * Fetch the wide rows for one page of ranked ids and put them back in rank
 * order. SQLite returns them in whatever order the index walk produced, so the
 * ranking is re-applied here rather than trusted — the `hits` order is the
 * product, and a primary-key join has no opinion about it.
 */
function joinOut<T>(
  db: Db,
  sql: string,
  match: string,
  slice: Ranked[],
  idOf: (row: Row) => number,
  shape: (row: Row, score: number) => T,
): T[] {
  const rows = db.q(sql).all(match, ...slice.map((r) => r.ref)) as Row[]
  const byId = new Map<number, Row>()
  for (const row of rows) byId.set(idOf(row), row)
  const out: T[] = []
  for (const hit of slice) {
    const row = byId.get(hit.ref)
    if (row !== undefined) out.push(shape(row, hit.score))
  }
  return out
}

function highlightOf(row: Row): string | null {
  return strOrNull(row.h_highlight)
}

/** The page of ranked hits this request asked for. */
function pageOf(refs: Ranked[], page: number, limit: number): Ranked[] {
  const from = offsetOf(page, limit)
  return from >= refs.length ? [] : refs.slice(from, from + limit)
}

function searchBaits(
  db: Db,
  match: string,
  q: SearchFilters,
  page: number,
  limit: number,
  ranked = true,
): Page<BaitHit> {
  const filter = baitFilter(db, q)
  if (filter.impossible) return NONE

  const joins = filter.needsPoems
    ? "JOIN baits b ON b.id = h.ref JOIN poems p ON p.id = b.poem_id"
    : filter.needsBaits
      ? "JOIN baits b ON b.id = h.ref"
      : ""
  const refs = rankedRefs(db, "baits_fts", joins, filter, match, ranked)
  const slice = pageOf(refs, page, limit)
  if (slice.length === 0) return { items: [], total: refs.length }

  const items = joinOut(
    db,
    `SELECT ${BAIT_COLS}, ${BAIT_CONTEXT_COLS}, ${snippetOf("baits_fts", 0, "b.id")} AS h_highlight
     FROM baits b ${BAIT_JOINS} WHERE b.id IN (${placeholders(slice.length)})`,
    match,
    slice,
    (row) => num(row.b_id),
    (row, score) => ({ ...baitDto(row), highlight: highlightOf(row), score }),
  )
  return { items, total: refs.length }
}

function searchPoems(db: Db, match: string, q: SearchFilters, page: number, limit: number): Page<PoemHit> {
  const filter = poemHitFilter(db, q)
  if (filter.impossible) return NONE

  const joins = filter.needsPoems ? "JOIN poems p ON p.id = h.ref" : ""
  const refs = rankedRefs(db, "poems_fts", joins, filter, match)
  const slice = pageOf(refs, page, limit)
  if (slice.length === 0) return { items: [], total: refs.length }

  const items = joinOut(
    db,
    `SELECT ${POEM_COLS}, ${snippetOf("poems_fts", -1, "p.id")} AS h_highlight
     FROM poems p ${POEM_JOINS} WHERE p.id IN (${placeholders(slice.length)})`,
    match,
    slice,
    (row) => num(row.p_id),
    (row, score) => ({ ...poemSummary(row), highlight: highlightOf(row), score }),
  )
  return { items, total: refs.length }
}

/**
 * The شعراء list is the one place bm25 alone answers the wrong question.
 *
 * `poets_fts` is `(norm_name, norm_desc)` and bm25 normalises by the length of
 * the WHOLE row, so a شاعر with a long ترجمة is penalised for having one. On
 * the real corpus «المتنبي» — 364 قصيدة, a 2,000-character bio — scored 4.99
 * against 8.47 for «المشوق الشامي صديق المتنبي», six قصائد and no bio at all,
 * and the same shape buried «البحتري» under «يحيى ابن البحتري». A reader who
 * types a شاعر's name and is handed his obscure namesake has been answered
 * correctly and served badly.
 *
 * So the poets ranking is stated in the order a reader means it:
 *   1. matched in the NAME before matched only in someone's ترجمة,
 *   2. then `poets.fame` — the curated canon (`shared/famousPoets.ts`), which
 *      is the only "which one did they mean" signal the artefact carries,
 *   3. then bm25, then id, so it stays deterministic.
 *
 * The name-hit set is one extra MATCH over a 6,941-row index (`{norm_name} :`
 * is FTS5's own column filter, and `match` is already `ftsQuery`'s quoted
 * output, so nothing user-typed becomes syntax). AND is the default pass, so a
 * multi-token query still has to match every token before fame can reorder
 * anything.
 */
function searchPoets(db: Db, match: string, q: SearchFilters, page: number, limit: number): Page<PoetHit> {
  const filter = poetHitFilter(db, q)
  if (filter.impossible) return NONE

  const refs = rankedPoetRefs(db, filter, match)
  const slice = pageOf(refs, page, limit)
  if (slice.length === 0) return { items: [], total: refs.length }

  const items = joinOut(
    db,
    `SELECT ${POET_COLS}, ${snippetOf("poets_fts", -1, "po.id")} AS h_highlight
     FROM poets po ${POET_JOINS} WHERE po.id IN (${placeholders(slice.length)})`,
    match,
    slice,
    (row) => num(row.po_id),
    (row, score) => ({ ...poetSummary(row), highlight: highlightOf(row), score }),
  )
  return { items, total: refs.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// The pass
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchResult {
  /** which pass actually produced these rows */
  mode: SearchMode
  baits: BaitHit[]
  poems: PoemHit[]
  poets: PoetHit[]
  /** sum of the per-list counts for the lists this scope includes */
  total: number
}

const EMPTY_RESULT = (mode: SearchMode): SearchResult => ({ mode, baits: [], poems: [], poets: [], total: 0 })

function wants(scope: SearchScope, list: "baits" | "poems" | "poets"): boolean {
  return scope === "all" || scope === list
}

function onePass(db: Db, q: SearchQuery, mode: SearchMode): SearchResult {
  // v2.md §2: a trailing `*` is the one piece of FTS5 syntax a reader may have,
  // and `PREFIX_MIN_LENGTH` is what keeps it affordable — a starred term of
  // four characters or more measured 5–41 ms ranked on the real corpus, while
  // «ال»* measured 2,058 ms and is therefore searched as the word «ال».
  const match = ftsQuery(q.q, mode, { stars: true })
  if (match === "") return EMPTY_RESULT(mode)

  // Only `baits_fts` gets the guard: it is the 3.57M-row index, and the other
  // two are 245,675 and 6,997 rows — a whole ranked scan of either is under a
  // millisecond.
  const ranked = shouldRank(db, ftsTerms(q.q), mode)
  const baits = wants(q.scope, "baits") ? searchBaits(db, match, q, q.page, q.limit, ranked) : NONE
  const poems = wants(q.scope, "poems") ? searchPoems(db, match, q, q.page, q.limit) : NONE
  const poets = wants(q.scope, "poets") ? searchPoets(db, match, q, q.page, q.limit) : NONE

  return {
    mode,
    baits: baits.items as BaitHit[],
    poems: poems.items as PoemHit[],
    poets: poets.items as PoetHit[],
    total: baits.total + poems.total + poets.total,
  }
}

/**
 * Run the search. AND first, and if AND found nothing at all — and the query
 * actually had more than one term to AND — retry as a ranked OR and report
 * `mode: 'or'`, which is what makes design-ux.md §3's «لا نتيجة بكل الكلمات —
 * هذه نتائج بعضها» note appear.
 *
 * `q.mode` (the `كلمات`/`أي كلمة` segmented control) pins the pass and disables
 * the fallback: an explicit choice is not second-guessed.
 *
 * An empty query returns without touching SQLite (design-server.md §2).
 */
export function runSearch(db: Db, q: SearchQuery): SearchResult {
  const terms = ftsTerms(q.q)
  if (terms.length === 0) return EMPTY_RESULT(q.mode ?? "and")

  if (q.mode !== undefined) return onePass(db, q, q.mode)

  const and = onePass(db, q, "and")
  if (and.total > 0 || terms.length < 2) return and
  // The fallback only counts if it actually widened the result: a zero caused
  // by a FILTER (or by a slug that names nothing) must not report 'or' and make
  // the client claim «لا نتيجة بكل الكلمات» about a query that had none either way.
  const or = onePass(db, q, "or")
  return or.total > 0 ? or : and
}
