/**
 * `/api/anthologies` — المختارات المنظومة, resolved against the live artefact.
 *
 *   GET /api/anthologies          the shelves + how much of each one resolved
 *   GET /api/anthologies/:slug    one shelf, every curated entry in order
 *
 * The curated tables live in `shared/anthologies.ts`; this file is only the
 * lookup. Two things about it are load-bearing.
 *
 * **It is a pure function of an immutable database, so it is memoised** — on
 * the DB HANDLE, in a WeakMap, the shape `server/query.ts`'s slug maps and
 * `facets.ts`'s facet memo already use. A shelf costs one FTS5 phrase query per
 * entry — 167 ms cold for all 110 on the real corpus — and nothing after that;
 * the alternative, resolving at ingest into a table of ids, would rot on the
 * next rebuild, because `public_id` moves for the 73 % of قصائد keyed `q<row
 * id>`. `warmAnthologies` pays the cold cost at boot, because the HOME screen
 * asks for the shelf counts on first paint; see its own comment.
 *
 * **An unresolved entry is still an item.** The route never drops one — see
 * the header of `shared/anthologies.ts`. `poem`/`bait` come back null and the
 * client prints «ليست في الديوان» beside the anthology's own مطلع.
 */

import { Hono } from "hono"

import { normalizeArabic } from "../../shared/arabic.ts"
import {
  ANTHOLOGIES,
  anthologyBySlug,
  entryAnchor,
  type Anthology,
  type AnthologyEntry,
} from "../../shared/anthologies.ts"
import { canonicalNameKey } from "../../shared/poetAliases.ts"
import {
  type AnthologiesResponse,
  type AnthologyItem,
  type AnthologyResponse,
  type AnthologyShelf,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import {
  BAIT_COLS,
  POEM_COLS,
  POEM_JOINS,
  baitDto,
  poemSummary,
  type Row,
} from "../dto.ts"
import { notFound } from "../query.ts"

/**
 * How many rows one anchor may pull back before the shaping runs.
 *
 * The anchor is a phrase of three to six words, so a hit list is normally one
 * or two rows — but «قفا نبك من ذكرى حبيب ومنزل» is quoted by twenty-three
 * later poets, and the cap is what stops a famous مطلع from turning one entry
 * into a scan. Sixty is comfortably above the widest measured anchor (25).
 */
const ANCHOR_HIT_CAP = 60

export function anthologyRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const body: AnthologiesResponse = { shelves: ANTHOLOGIES.map((a) => shelfOf(db, a)) }
    return c.json(body)
  })

  app.get("/:slug", (c) => {
    const shelf = anthologyBySlug(c.req.param("slug"))
    // An unknown slug is a missing page, not a client bug — it arrives from a
    // hash-router deep link exactly like an unknown `:publicId` does.
    if (!shelf) return notFound(c, "anthology")
    const body: AnthologyResponse = { shelf: shelfOf(db, shelf), items: resolveAnthology(db, shelf) }
    return c.json(body)
  })

  return app
}

export function shelfOf(db: Db, a: Anthology): AnthologyShelf {
  const items = resolveAnthology(db, a)
  return {
    slug: a.slug,
    title: a.title,
    tagline: a.tagline,
    blurb: a.blurb,
    kind: a.kind,
    total: a.entries.length,
    resolved: items.filter((i) => (a.kind === "poems" ? i.poem : i.bait) !== null).length,
    // The spines: what is actually ON the shelf, so its card is a shelf and
    // not a paragraph about one. One rule for both kinds — the OPENING LINE of
    // each entry, which for a معلقة is its مطلع and not «معلقة زهير»: the ode's
    // name identifies it, its مطلع is what makes a reader open it. The curated
    // مطلع stands in when the corpus answered nothing.
    preview: items
      .slice(0, SHELF_PREVIEW)
      .map((i) => i.poem?.previewSadr ?? i.bait?.sadr ?? i.matla),
  }
}

/** How many spines a shelf card shows. Three fits the card without scrolling. */
const SHELF_PREVIEW = 3

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `slug:index` → the resolved item, per DB handle.
 *
 * The memo is per ENTRY, not per shelf, for one reason: `warmAnthologies`
 * below has to yield to the event loop BETWEEN entries, and a shelf-shaped
 * cache would make the whole hundred one indivisible turn. The map lives on the
 * handle like `facets.ts`'s does, so a caller with no `Hono` can fill it.
 */
const MEMO = new WeakMap<Db, Map<string, AnthologyItem>>()

function memoOf(db: Db): Map<string, AnthologyItem> {
  let byHandle = MEMO.get(db)
  if (!byHandle) {
    byHandle = new Map()
    MEMO.set(db, byHandle)
  }
  return byHandle
}

function resolveEntry(db: Db, a: Anthology, index: number): AnthologyItem {
  const memo = memoOf(db)
  const key = `${a.slug}:${index}`
  const hit = memo.get(key)
  if (hit) return hit
  const entry = a.entries[index]!
  const item = a.kind === "poems" ? resolvePoemEntry(db, entry, index) : resolveBaitEntry(db, entry, index)
  memo.set(key, item)
  return item
}

export function resolveAnthology(db: Db, a: Anthology): AnthologyItem[] {
  return a.entries.map((_entry, index) => resolveEntry(db, a, index))
}

/**
 * Fire-and-forget pre-warm, the shape `warmFacets` already established.
 *
 * The home screen's shelf strip asks for `/api/anthologies` on first paint, and
 * that route reports how many entries RESOLVED — which it can only know by
 * resolving them. Measured cold on the real artefact: 20 ms for المعلقات and
 * 147 ms for the hundred, i.e. one 167 ms synchronous turn in front of the
 * first visitor of every boot, on a server whose whole latency budget is 150 ms
 * (every `node:sqlite` call blocks the one loop — CLAUDE.md). Warmed, that turn
 * is 110 turns of ~1.5 ms and the first request is a map lookup.
 *
 * Like the facet warm it awaits a `setImmediate` before EVERY entry, so the
 * socket is accepting from the first millisecond, and it is guarded so a
 * pre-warm failure is a log line rather than a dead boot.
 */
export async function warmAnthologies(db: Db): Promise<number> {
  let warmed = 0
  for (const a of ANTHOLOGIES) {
    for (let index = 0; index < a.entries.length; index++) {
      await new Promise((resolve) => setImmediate(resolve))
      try {
        resolveEntry(db, a, index)
        warmed += 1
      } catch (err) {
        console.error(
          `[qarid] anthology pre-warm failed on ${a.slug}:${index}: ${err instanceof Error ? err.message : err}`,
        )
        return warmed
      }
    }
  }
  return warmed
}

/**
 * Rows whose بيت begins on the curated anchor, by that شاعر, best copy first.
 *
 * Two filters the SQL cannot do and one that it must not. FTS5 matches the
 * phrase anywhere in `baits_fts.norm` — which is `sadr + " " + ajuz` — so a
 * مطلع that another poet quotes in his عجز comes back too, and the
 * `startsWith` re-check in JS is what makes the anchor an OPENING. The شاعر is
 * matched on `name_key` folded through `poetAliases`, so «أبو الطيب المتنبي»
 * and «المتنبي» are the one row they became at ingest. And the ordering stays
 * in JS because the candidate list is tiny and the tie-break has to read a
 * subquery (`game_baits` membership) that would cost an index scan in SQL.
 */
function anchorRows(db: Db, entry: AnthologyEntry, cols: string, joins: string, position1: boolean): Row[] {
  const anchor = entryAnchor(entry.matla)
  if (anchor === "") return []
  const key = canonicalNameKey(normalizeArabic(entry.poet))
  const rows = db
    .q(
      `SELECT ${cols}, b.sadr AS anchor_sadr, b.id AS anchor_bait_id, p.aldiwan_id AS anchor_aldiwan,
              p.bait_count AS anchor_bait_count, b.is_partial AS anchor_partial,
              (SELECT 1 FROM game_baits g WHERE g.bait_id = b.id) AS anchor_playable
       FROM baits_fts f
       JOIN baits b ON b.id = f.rowid
       JOIN poems p ON p.id = b.poem_id
       ${joins}
       WHERE baits_fts MATCH ?${position1 ? " AND b.position = 1" : ""} AND po.name_key = ?
       LIMIT ${ANCHOR_HIT_CAP}`,
    )
    .all(`"${anchor}"`, key) as Row[]
  return rows.filter((r) => normalizeArabic(String(r.anchor_sadr)).startsWith(anchor))
}

/**
 * A معلقة: the قصيدة whose FIRST بيت opens on the anchor.
 *
 * The corpus keeps several copies of the same ode — طرفة's is in twice, under
 * two punctuations of the same مطلع, so `dedup_key` (nameKey|مطلع) saw two
 * different keys and kept both. Which copy the shelf wants is decided by
 * `pickDedupWinner`'s own order (`scripts/ingest/transform.ts`), and
 * deliberately not by a new one: most أبيات, then a named بحر, then
 * aldiwan.net, then the lowest id so a rebuild answers the same way.
 *
 * `has_tashkeel` is NOT promoted above length, and the corpus is why. It is a
 * 3 % density threshold, not a quality signal: طرفة's vocalized copy carries
 * the scraper's split marks — «لِخَولة َ أطْلالٌ بِبُرقَة ِ ثَهمَدِ،», with a
 * space before every ة and a comma glued to the قافية — while the 120-بيت copy
 * it would have displaced is clean, if bare. Ranked on تشكيل the shelf's second
 * ode renders with floating diacritics; ranked on length it renders correctly.
 * Four of the ten odes have no بحر at all (39.8 % of قصائد do not, CLAUDE.md
 * §Corpus quirks), so that rule separates nothing on those and length decides.
 */
function resolvePoemEntry(db: Db, entry: AnthologyEntry, index: number): AnthologyItem {
  const rows = anchorRows(db, entry, `${POEM_COLS}, p.meter_id AS anchor_meter`, POEM_JOINS, true)
  rows.sort(
    (x, y) =>
      Number(y.anchor_bait_count ?? 0) - Number(x.anchor_bait_count ?? 0) ||
      (y.anchor_meter === null ? 0 : 1) - (x.anchor_meter === null ? 0 : 1) ||
      (y.anchor_aldiwan === null ? 0 : 1) - (x.anchor_aldiwan === null ? 0 : 1) ||
      Number(x.p_id) - Number(y.p_id),
  )
  const row = rows[0]
  return {
    index,
    poet: entry.poet,
    matla: entry.matla,
    name: entry.name ?? null,
    poem: row ? poemSummary(row) : null,
    bait: null,
  }
}

/**
 * A بيت سائر: the شاعر's own copy of the line, wherever it sits in his ديوان.
 *
 * Ranked so the shelf's ♥ / بطاقة / ساجِلني all work on it: a complete بيت
 * before a hemistich the scrape cut, then one the duel can actually serve
 * (`game_baits` — a قصيدة with no بحر is unplayable, CLAUDE.md §Tier pools),
 * then aldiwan.net, then the lowest id.
 */
function resolveBaitEntry(db: Db, entry: AnthologyEntry, index: number): AnthologyItem {
  const rows = anchorRows(db, entry, `${BAIT_COLS}, ${POEM_COLS}`, POEM_JOINS, false)
  rows.sort(
    (x, y) =>
      Number(x.anchor_partial ?? 0) - Number(y.anchor_partial ?? 0) ||
      Number(y.anchor_playable ?? 0) - Number(x.anchor_playable ?? 0) ||
      (y.anchor_aldiwan === null ? 0 : 1) - (x.anchor_aldiwan === null ? 0 : 1) ||
      Number(x.anchor_bait_id) - Number(y.anchor_bait_id),
  )
  const row = rows[0]
  return {
    index,
    poet: entry.poet,
    matla: entry.matla,
    name: entry.name ?? null,
    poem: null,
    bait: row ? baitDto(row) : null,
  }
}
