/**
 * `server/game.ts` — the strict مساجلة engine (design-server.md §8, amendments
 * 1, 2, 5, 6, 7, 8, 16).
 *
 * The routes in `server/routes/game.ts` are thin; everything that decides
 * anything lives here, because the duel has exactly two hard jobs and both are
 * easy to get subtly wrong:
 *
 *  1. **Deciding whether a human's typed بيت is in the ديوان.** People type from
 *     memory. They drop the tashkeel, they write ألف instead of همزة, they give
 *     you the صدر only, they misremember one word. A hash lookup answers "no" to
 *     all four. So the verifier is a LADDER: two exact hashes over the
 *     normalized form (free, and right for the 60% who paste), then FTS5 + a
 *     token jaccard for the rest, and below that two *shaped* rejections —
 *     `near_miss` (amendment 7: one suggestion and a −25 «اقبل هذا البيت»
 *     button) and `not_found` (≤3 «هل تقصد؟» chips). A duel where a correct بيت
 *     is called wrong is not a game, it is an insult, and every threshold below
 *     is tilted toward accepting.
 *
 *  2. **Answering with a بيت that starts on the right letter, is not one already
 *     played, and matches the tier.** That is a sampling problem over 1.76M rows
 *     and the two CLAUDE.md invariants apply with full force: never
 *     `ORDER BY RANDOM()` (sample a wrap-around window over `gb.bucket`), and
 *     never sort joined rows (sort a narrow `game_baits`-only subquery and join
 *     the ≤40 survivors out). `combo_counts` (amendment 2) turns "is this
 *     combination exhausted?" into a single point lookup on a WITHOUT ROWID
 *     primary key, so the common dead-end costs no scan at all.
 *
 * Nothing here spells a column name that `server/dto.ts` already spells, and
 * nothing here re-implements normalization — `shared/arabic.ts` is the only
 * text layer (CLAUDE.md invariant).
 */

import { COMBO_ANY, COMBO_NONE, TIER_PREDICATES } from "../scripts/ingest/ddl.ts"
import {
  cleanText,
  firstLetterOf,
  fnv1a64Signed,
  ftsQuery,
  ftsTerms,
  normalizeArabic,
} from "../shared/arabic.ts"
import { VERIFY } from "../shared/constants.ts"
import { RARE_RAWIYY_WIDE } from "../shared/letters.ts"
import { rngFrom } from "../shared/rng.ts"
import { HINT_COSTS } from "../shared/schema.ts"
import type {
  ArabicLetter,
  BaitDto,
  ChainMode,
  ChainState,
  Difficulty,
  GameFilters,
  GameVerifyRequest,
  GameVerifyResponse,
  MatchKind,
  PoemSummary,
  PoetSummary,
  TailBias,
} from "../shared/schema.ts"
import type { Db } from "./db.ts"
import {
  BAIT_COLS,
  POEM_COLS,
  POEM_JOINS,
  POET_EXTRA_COLS,
  baitDto,
  num,
  poemSummary,
  poetSummary,
  str,
  strOrNull,
  letterOrNull,
  type Row,
} from "./dto.ts"
import { poetIdBySlug, seedBucket, slugMaps } from "./query.ts"

// ─────────────────────────────────────────────────────────────────────────────
// SQL shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `game_baits` widened to everything a served بيت needs: the بيت, a full
 * `PoemSummary` and a full `PoetSummary` off one row. Identical in shape to
 * `GB_FROM_WIDE` in routes/baits.ts (which /api/baits/daily uses) — assembled
 * from the same `server/dto.ts` fragments rather than imported, so the two
 * files do not have to agree on anything but those fragments.
 *
 * `POET_EXTRA_COLS`, not `POET_COLS`: `POEM_COLS` already carries the poet ref,
 * and selecting both would emit `po_slug` twice.
 */
const SERVED_COLS = `${BAIT_COLS}, ${POEM_COLS}, ${POET_EXTRA_COLS}`

/** From a `sel` subquery of bait ids out to the full context. */
const SERVED_JOINS = `JOIN baits b ON b.id = sel.bid JOIN poems p ON p.id = b.poem_id ${POEM_JOINS}`

/** Straight from `baits` (verify's exact-hash and candidate lookups). */
const BAIT_FROM = `FROM baits b JOIN poems p ON p.id = b.poem_id ${POEM_JOINS}`

/** amendment 5's rare set, as a SQL literal list. Constant — never a parameter. */
const RARE_LIST = RARE_RAWIYY_WIDE.map((l) => `'${l}'`).join(",")

// ─────────────────────────────────────────────────────────────────────────────
// Difficulty tiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each tier as the set of `fame` values it admits, plus whatever else it asks
 * for — NOT as the range predicate `scripts/ingest/ddl.ts` spells.
 *
 * The two are the same set (`poets.fame` is an integer 0..3, so `fame >= 2` IS
 * `fame IN (3, 2)`), and the rewrite is the single biggest performance decision
 * in this file. `gb_pick` is `(first_letter, fame, bucket)`: with `fame = ?`
 * SQLite walks the index in bucket order and stops at the 40th row; with
 * `fame >= ?` it cannot, so it reads every بيت on the letter and sorts them.
 * Measured on data/qarid.db, letter ألف, tier normal: 38.3 ms → 0.8 ms.
 *
 * `TIER_PREDICATES` stays the source of truth for what a tier MEANS — the
 * assertion below fails the process at import time if the two ever drift.
 */
const TIERS: Readonly<Record<Difficulty, { fame: readonly number[]; extra: string | null }>> = {
  easy: { fame: [3], extra: "gb.position <= 2" },
  normal: { fame: [3, 2], extra: "gb.position <= 12" },
  hard: { fame: [2, 1, 0], extra: null },
  brutal: { fame: [3, 2, 1, 0], extra: null },
}

/**
 * Proof that the fame sets above are exactly the DDL's range predicates, run
 * once at import over all four values of `fame`. A tier edited in one place and
 * not the other would silently change who the duel can quote, and no test that
 * only asserts "a بيت came back" would notice.
 */
for (const [tier, sql] of TIER_PREDICATES) {
  const spec = TIERS[tier as Difficulty]
  if (spec === undefined) throw new Error(`game.ts: no tier spec for ${tier}`)
  for (const fame of [0, 1, 2, 3]) {
    const byRange = evalTierPredicate(sql, fame)
    const bySet = spec.fame.includes(fame)
    if (byRange !== bySet) throw new Error(`game.ts: tier ${tier} disagrees with TIER_PREDICATES at fame=${fame}`)
  }
}

/** The tiny subset of SQL `TIER_PREDICATES` uses, evaluated over `gb.fame`. */
function evalTierPredicate(sql: string, fame: number): boolean {
  if (sql === "1 = 1") return true
  const m = /^gb\.fame\s*(=|>=|<=)\s*(\d)/.exec(sql)
  if (m === null) throw new Error(`game.ts: cannot read tier predicate ${sql}`)
  const n = Number(m[2])
  return m[1] === "=" ? fame === n : m[1] === ">=" ? fame >= n : fame <= n
}

/**
 * The pool a tier can fall back to when its own is exhausted (design-server.md
 * §8: "relax one tier once"). Every arrow points at a strictly LARGER pool,
 * which `hard` (fame ≤ 2) makes non-obvious: it is not a superset of `normal`
 * (fame ≥ 2), so relaxing it means going all the way to `brutal`.
 */
const RELAX: Readonly<Record<Difficulty, Difficulty | null>> = {
  easy: "normal",
  normal: "brutal",
  hard: "brutal",
  brutal: null,
}

/** The relax map, for `/api/game/pool`'s «العدد المتاح» — see `effectiveTotal`. */
export { RELAX as RELAX_TIER }

/**
 * The tail bias a difficulty implies when the client did not set one.
 * design-server.md §8 makes this part of the tier ("`easy` also avoids replying
 * with a bait whose rawiyy ∈ rare set"); amendment 5 promotes it to a separate
 * lever. Both hold: an explicit `tailBias` wins, `'none'` means "ask the tier".
 */
export function effectiveTailBias(difficulty: Difficulty, tailBias: TailBias): TailBias {
  if (tailBias !== "none") return tailBias
  if (difficulty === "easy") return "easy"
  if (difficulty === "hard" || difficulty === "brutal") return "hard"
  return "none"
}

// ─────────────────────────────────────────────────────────────────────────────
// The game_baits filter
// ─────────────────────────────────────────────────────────────────────────────

export interface GbCond {
  where: string
  params: Array<string | number>
  /** a slug named nothing in the artefact — provably no rows (never a 400) */
  impossible: boolean
  /** the filter touches `poems`, so even the narrow subquery must join it */
  needsPoem: boolean
  /** era/meter as `combo_counts` sentinels, or null when it cannot be consulted */
  combo: { eraId: number; meterId: number } | null
}

/**
 * The «القيود» the player set on the setup screen, as SQL over `game_baits`.
 *
 * `era` and `meter` are denormalised onto `game_baits` itself (§5), so the
 * common case never joins. `theme`, `poet` and `lang` live on `poems` and set
 * `needsPoem`. An unknown slug is `impossible`, i.e. an empty result — never a
 * 400 (server/query.ts's convention, and the client cannot emit one anyway).
 */
export function gameFilter(db: Db, filters: GameFilters | undefined): GbCond {
  const maps = slugMaps(db)
  const where: string[] = []
  const params: Array<string | number> = []
  let impossible = false
  let needsPoem = false
  let eraId = COMBO_ANY
  let meterId = COMBO_ANY

  const f = filters ?? {}

  if (f.era !== undefined) {
    const id = maps.era.get(f.era)
    if (id === undefined) impossible = true
    else {
      where.push("gb.era_id = ?")
      params.push(id)
      eraId = id
    }
  }
  if (f.meter !== undefined) {
    const id = maps.meter.get(f.meter)
    if (id === undefined) impossible = true
    else {
      where.push("gb.meter_id = ?")
      params.push(id)
      meterId = id
    }
  }
  if (f.theme !== undefined) {
    const id = maps.theme.get(f.theme)
    if (id === undefined) impossible = true
    else {
      where.push("p.theme_id = ?")
      params.push(id)
      needsPoem = true
    }
  }
  if (f.poet !== undefined) {
    const id = poetIdBySlug(db, f.poet)
    if (id === null) impossible = true
    else {
      where.push("p.poet_id = ?")
      params.push(id)
      needsPoem = true
    }
  }
  if (f.lang !== undefined) {
    where.push("p.lang_type = ?")
    params.push(f.lang)
    needsPoem = true
  }

  return {
    where: where.length === 0 ? "1 = 1" : where.join(" AND "),
    params,
    impossible,
    needsPoem,
    combo: { eraId, meterId },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// combo_counts — amendment 2
// ─────────────────────────────────────────────────────────────────────────────

let comboTablePresent: WeakMap<object, boolean> | null = null

/** Does this artefact carry `combo_counts`? Asked once per database handle. */
export function hasComboCounts(db: Db): boolean {
  comboTablePresent ??= new WeakMap<object, boolean>()
  const cached = comboTablePresent.get(db as object)
  if (cached !== undefined) return cached
  const row = db
    .q("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'combo_counts'")
    .get() as { name: string } | undefined
  const present = row !== undefined
  comboTablePresent.set(db as object, present)
  return present
}

/**
 * How many playable أبيات start on `letter` under this era/metre/tier — one
 * point lookup on a WITHOUT ROWID primary key, or `null` when the table is not
 * there (an artefact built before amendment 2).
 *
 * `theme`, `poet` and `lang` are NOT in the key, and that is fine for the one
 * thing this is used for: they can only ever NARROW the set, so a zero here is
 * a zero there too. It is a sound short-circuit, never a sound count.
 */
export function comboCount(
  db: Db,
  letter: string,
  cond: GbCond,
  tier: Difficulty,
): number | null {
  if (cond.combo === null || !hasComboCounts(db)) return null
  const row = db
    .q("SELECT n FROM combo_counts WHERE first_letter = ? AND era_id = ? AND meter_id = ? AND tier = ?")
    .get(letter, cond.combo.eraId, cond.combo.meterId, tier) as { n: number } | undefined
  // A missing row IS a zero: writeComboCounts only emits combinations that
  // exist, so "no row" and "n = 0" mean the same thing.
  return row === undefined ? 0 : Number(row.n)
}

/** Per-letter counts for the setup screen (`GET /api/game/pool`). */
export function comboByLetter(db: Db, cond: GbCond, tier: Difficulty): Map<string, number> | null {
  if (cond.combo === null || !hasComboCounts(db)) return null
  const rows = db
    .q("SELECT first_letter AS l, n FROM combo_counts WHERE era_id = ? AND meter_id = ? AND tier = ?")
    .all(cond.combo.eraId, cond.combo.meterId, tier) as Row[]
  const out = new Map<string, number>()
  for (const r of rows) out.set(str(r.l), num(r.n))
  return out
}

/** `combo_counts` sentinels, re-exported so the routes do not import the DDL. */
export { COMBO_ANY, COMBO_NONE }

// ─────────────────────────────────────────────────────────────────────────────
// Chain state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The letters the NEXT answer must open on, read off a served بيت.
 *
 * amendment 1 is the whole of it: the artefact stores both the peeled الروي and
 * the literal final letter, and the game mode picks which one rules.
 *  • `rhyme`   — classical. Required letter is the روي; the literal letter is
 *                accepted too, because half the players learned «القافية» as
 *                "the letter you hear" and rejecting كِتابُهُ → ه when the روي is
 *                ب would be pedantry, not strictness.
 *  • `literal` — street rules. Only the literal final letter, nothing accepted
 *                alongside it.
 *
 * `requiredLetterSource` describes where the REQUIRED letter came from, so
 * `literal` mode always reports `'rawiyy'`: nothing was peeled to produce it.
 * (design-server.md §8 defines the field only for `rhyme` mode, which had no
 * `literal` mode when it was written.)
 */
/**
 * The one place a chain mode turns two stored letters into the letter the next
 * answer must open on. `chainState` reads it off a served row; the hint route
 * reads it off a bare `baits` row (it has no join to spare). Two spellings of
 * this expression is how `/api/game/hint` ended up describing a بيت on the روي
 * while `verifyAnswer` demanded the literal ending.
 *
 * The fallback matters as much as the choice: a بيت whose عجز the source never
 * had has neither letter, and `'ا'` keeps the duel moving rather than throwing.
 */
export function requiredLetterOf(
  rawiyy: ArabicLetter | null,
  lastLetter: ArabicLetter | null,
  mode: ChainMode,
): ArabicLetter {
  return ((mode === "literal" ? lastLetter ?? rawiyy : rawiyy ?? lastLetter) ?? "ا") as ArabicLetter
}

export function chainState(row: Row, mode: ChainMode): ChainState {
  const rawiyy = letterOrNull(row.b_rawiyy)
  const lastLetter = letterOrNull(row.b_last_letter)
  const fame = num(row.po_fame)
  const position = num(row.b_position)

  const primary = requiredLetterOf(rawiyy, lastLetter, mode)
  const peeled = mode === "rhyme" && lastLetter !== null && rawiyy !== null && lastLetter !== rawiyy

  return {
    requiredLetter: primary as ArabicLetter,
    requiredLetterSource: peeled ? "peeled" : "rawiyy",
    alsoAccepted: peeled ? [lastLetter as ArabicLetter] : [],
    mode,
    obscurity: obscurityOf(fame, position),
  }
}

/** design-server.md §8: `clamp(1 − fame/3 + (position > 8 ? 0.15 : 0), 0, 1)`. */
export function obscurityOf(fame: number, position: number): number {
  const raw = 1 - fame / 3 + (position > 8 ? 0.15 : 0)
  return Math.min(1, Math.max(0, Number(raw.toFixed(4))))
}

export interface ServedBait {
  bait: BaitDto
  poem: PoemSummary
  poet: PoetSummary
  requiredLetter: ArabicLetter
  requiredLetterSource: ChainState["requiredLetterSource"]
  alsoAccepted: ArabicLetter[]
  mode: ChainMode
  obscurity: number
}

/** One `SERVED_COLS` row → the payload start / reply / a passing verify share. */
export function servedBait(row: Row, mode: ChainMode): ServedBait {
  return {
    bait: baitDto(row),
    poem: poemSummary(row),
    poet: poetSummary(row),
    ...chainState(row, mode),
  }
}

/** The letters an answer to `row` may open on, in `mode`. */
export function acceptedLetters(row: Row, mode: ChainMode): string[] {
  const state = chainState(row, mode)
  return [state.requiredLetter, ...state.alsoAccepted]
}

// ─────────────────────────────────────────────────────────────────────────────
// Sampling — the opponent's بيت
// ─────────────────────────────────────────────────────────────────────────────

/** design-server.md §8: `bucket sampling LIMIT 40 (+wrap)`. */
export const SAMPLE_WINDOW = 40

export interface PickOptions {
  /** the letter the reply must START on; `undefined` on /api/game/start */
  letter?: string
  difficulty: Difficulty
  tailBias: TailBias
  filters?: GameFilters
  excludeBaitIds?: number[]
  excludePoemIds?: number[]
  seed?: string
  /** `switch_letter` needs a بيت whose روي is NOT the letter being abandoned */
  avoidRawiyy?: string
  /**
   * Drop the «القيود» rather than concede — `/api/game/reply` only.
   *
   * A conceded reply is «أفحمتَ الخصم»: +500 and the duel ends won. But the
   * opponent draws from the FILTERED pool while the player answers out of the
   * whole 3.57M-بيت corpus, so a thin combination (80 of the 12×16 عصر×بحر pairs
   * hold fewer than 400 أبيات at مبتدئ; جاهلي+هزج holds 2) turns that bonus into
   * a one-move farm: pick the thin pair, answer with any بيت whose روي the pair
   * does not carry, collect 500. Applying the filters to the player instead
   * would be the other half of the asymmetry and would make those combinations
   * unplayable in the opposite direction — with 165 أبيات to choose from, no
   * human can answer. So the corner where the corpus cannot answer INSIDE the
   * القيود is answered outside them, and «أفحمتَ الخصم» goes back to meaning
   * what it says: the ديوان itself has nothing left on this letter.
   */
  relaxFilters?: boolean
}

export interface PickResult {
  row: Row
  /** the tier actually used — different from `difficulty` after a relax */
  tier: Difficulty
  /** the «القيود» had to be dropped to answer at all (`relaxFilters` only) */
  relaxed: boolean
}

type Bias = "rare" | "no_conj" | "avoid_rare" | "none"

/** One `fame = ?` branch of a sample: its WHERE body and its bound values. */
interface Branch {
  cond: string
  params: Array<string | number>
}

/** Assemble one attempt's branches — one per `fame` value the tier admits. */
function branchesFor(
  base: GbCond,
  tier: Difficulty,
  letter: string | undefined,
  bias: Bias,
  avoidRawiyy: string | undefined,
): Branch[] {
  const spec = TIERS[tier]
  const shared: string[] = [base.where]
  const sharedParams: Array<string | number> = [...base.params]

  // `first_letter` first: it is the leading column of `gb_pick`, and the whole
  // sample is an index walk or it is a table scan.
  if (letter !== undefined) {
    shared.push("gb.first_letter = ?")
    sharedParams.push(letter)
  }
  if (spec.extra !== null) shared.push(spec.extra)
  if (avoidRawiyy !== undefined) {
    shared.push("gb.rawiyy <> ?")
    sharedParams.push(avoidRawiyy)
  }
  if (bias === "rare") shared.push(`gb.rawiyy IN (${RARE_LIST}) AND gb.opens_conj = 0`)
  else if (bias === "no_conj") shared.push("gb.opens_conj = 0")
  else if (bias === "avoid_rare") shared.push(`gb.rawiyy NOT IN (${RARE_LIST})`)

  return spec.fame.map((fame) => ({
    cond: [...shared, "gb.fame = ?"].join(" AND "),
    params: [...sharedParams, fame],
  }))
}

/**
 * One wrap-around window over `gb.bucket`, sorted inside subqueries that read
 * `game_baits` and nothing else.
 *
 * Three things are load-bearing and each was measured:
 *  • `ORDER BY RANDOM()` over 1.76M rows sorts 1.76M rows; the `bucket` column
 *    turns the same job into an index range scan of 40 (CLAUDE.md invariant).
 *  • Sorting the JOINED rows — the obvious way to write this — cost 2.6 seconds
 *    on the unfiltered pool, because SQLite materialises every join before the
 *    LIMIT can bite. So the sort happens over a narrow `(bait_id, bucket, rand)`
 *    projection and only the ≤40 survivors are joined out.
 *  • One branch per `fame` value, merged with UNION ALL, so every branch is an
 *    equality on `gb_pick`'s second column and can be walked in bucket order.
 *    Each branch's own top-40 necessarily contains the merged top-40, so the
 *    result is identical to the range predicate's — 48× faster.
 */
function sampleWindow(db: Db, branches: Branch[], needsPoem: boolean, start: number): Row[] {
  const narrowJoin = needsPoem ? "JOIN poems p ON p.id = gb.poem_id" : ""
  const run = (op: ">=" | "<") => {
    const leg = (b: Branch) =>
      `SELECT * FROM (SELECT gb.bait_id AS bid, gb.bucket AS bk, gb.rand AS rd
                      FROM game_baits gb ${narrowJoin}
                      WHERE ${b.cond} AND gb.bucket ${op} ?
                      ORDER BY gb.bucket ASC, gb.rand ASC, gb.bait_id ASC
                      LIMIT ${SAMPLE_WINDOW})`
    const merged =
      branches.length === 1
        ? `${leg(branches[0]!)} ORDER BY bk ASC, rd ASC, bid ASC LIMIT ${SAMPLE_WINDOW}`
        : `SELECT * FROM (${branches.map(leg).join(" UNION ALL ")})
           ORDER BY bk ASC, rd ASC, bid ASC LIMIT ${SAMPLE_WINDOW}`
    const params: Array<string | number> = []
    for (const b of branches) params.push(...b.params, start)
    return db
      .q(
        `SELECT ${SERVED_COLS}
         FROM (${merged}) sel
         ${SERVED_JOINS}
         ORDER BY sel.bk ASC, sel.rd ASC, sel.bid ASC`,
      )
      .all(...params) as Row[]
  }

  const forward = run(">=")
  // The wrap: a thin filter whose rows all sit below `start` would otherwise
  // report an empty pool that is not empty.
  if (forward.length >= SAMPLE_WINDOW) return forward
  return [...forward, ...run("<")]
}

/**
 * The bias passes, in order of preference. Each is a filter; the last is always
 * the unbiased one, because a *preference* that empties a thin pool is a bug —
 * «فحل» wanting a قافية على الظاء must not turn into «لا يوجد بيت».
 */
function biasPasses(tailBias: TailBias): Bias[] {
  if (tailBias === "hard") return ["rare", "no_conj", "none"]
  if (tailBias === "easy") return ["avoid_rare", "none"]
  return ["none"]
}

/**
 * How many letters an unconstrained pick (`/api/game/start`, «بدّل الحرف») will
 * try before giving up on `combo_counts` and scanning.
 */
const LETTER_TRIES = 8

/**
 * Letters to try when the caller named none, drawn WITHOUT replacement in
 * proportion to how much of the pool each holds.
 *
 * This is not a nicety, it is the same index problem again: `gb_pick` leads on
 * `first_letter`, so a query that does not fix it cannot walk the index at all —
 * an unfiltered `/api/game/start` on the easy tier scanned for 113 ms. Choosing
 * the letter first, weighted by `combo_counts`, makes the query letter-shaped
 * and therefore an index walk (0.8 ms), and weighting by count keeps the result
 * uniform over أبيات rather than uniform over letters.
 *
 * `null` when `combo_counts` is absent — the caller then scans, correctly but
 * slowly, which is the right failure for an artefact built before amendment 2.
 */
function weightedLetters(db: Db, base: GbCond, tier: Difficulty, rng: () => number): string[] | null {
  const counts = comboByLetter(db, base, tier)
  if (counts === null) return null
  const pool = [...counts.entries()].filter(([, n]) => n > 0)
  if (pool.length === 0) return []
  const out: string[] = []
  let total = pool.reduce((sum, [, n]) => sum + n, 0)
  while (out.length < LETTER_TRIES && pool.length > 0) {
    let target = rng() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      target -= pool[i]![1]
      if (target <= 0) {
        idx = i
        break
      }
    }
    const [letter, n] = pool[idx]!
    out.push(letter)
    total -= n
    pool.splice(idx, 1)
  }
  return out
}

/**
 * Pick the opponent's بيت: tier → bias passes → wrap-around window → drop the
 * أبيات (and the قصائد) already played → seeded choice. If every pass comes up
 * empty, relax exactly one tier and do it again; then give up, which the client
 * turns into «أفحمتَ الخصم» (+500, amendment 16).
 */
export function pickBait(db: Db, opts: PickOptions): PickResult | null {
  const excludeBaits = new Set(opts.excludeBaitIds ?? [])
  const excludePoems = new Set(opts.excludePoemIds ?? [])
  // `seedBucket(undefined)` is genuinely random — that is the unseeded path.
  const start = seedBucket(opts.seed)
  const rng = opts.seed === undefined ? Math.random : rngFrom(`pick:${opts.seed}`)

  const tiers: Difficulty[] = [opts.difficulty]
  const relaxed = RELAX[opts.difficulty]
  if (relaxed !== null) tiers.push(relaxed)

  const attempt = (base: GbCond): PickResult | null => {
    if (base.impossible) return null
    for (const tier of tiers) {
      // When the caller named a letter, `combo_counts` answers "is this
      // combination exhausted?" with one point lookup instead of a scan
      // (amendment 2). When it did not, the same table picks a letter to aim at.
      const letters =
        opts.letter !== undefined ? [opts.letter] : (weightedLetters(db, base, tier, rng) ?? [undefined])

      for (const letter of letters) {
        if (letter !== undefined && opts.letter !== undefined && comboCount(db, letter, base, tier) === 0) continue
        for (const bias of biasPasses(opts.tailBias)) {
          const branches = branchesFor(base, tier, letter, bias, opts.avoidRawiyy)
          const rows = sampleWindow(db, branches, base.needsPoem, start)
          const usable = rows.filter((r) => !excludeBaits.has(num(r.b_id)) && !excludePoems.has(num(r.p_id)))
          if (usable.length === 0) continue
          const idx = Math.min(usable.length - 1, Math.floor(rng() * usable.length))
          return { row: usable[idx]!, tier, relaxed: false }
        }
      }
    }
    return null
  }

  const filtered = attempt(gameFilter(db, opts.filters))
  if (filtered !== null) return filtered
  // Every tier is dry inside the «القيود». See `relaxFilters` above for why the
  // answer to that is the whole ديوان and not a +500 bonus.
  const hasFilters = Object.keys(opts.filters ?? {}).length > 0
  if (opts.relaxFilters !== true || !hasFilters) return null
  const wide = attempt(gameFilter(db, undefined))
  return wide === null ? null : { ...wide, relaxed: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify — the ladder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The separators a player might put between صدر and عجز. Two-or-more spaces and
 * the tab have to be found BEFORE `cleanText` runs, because `cleanText`'s job is
 * to collapse exactly those into one space — split first, clean the halves.
 * (design-server.md §8 lists the split after the clean; the order there is not
 * implementable as written.)
 */
const SPLIT_RE = /\s*(?:\*{1,3}|…|\.{3}|-{3}|\|{1,2}|\/{1,2}|[\n\r\t]|…| {2,})\s*/

export interface SplitText {
  /** the whole answer, normalized — the exact-`h_full` key and the echo */
  normFull: string
  /** the صدر alone, normalized — the exact-`h_sadr` key */
  normSadr: string
  /** did the player actually give two hemistichs? */
  split: boolean
  /** the cleaned display form, whitespace collapsed */
  clean: string
  words: number
}

/** cleanText + the صدر/عجز split, as the verifier needs them. */
export function splitAnswer(text: string): SplitText {
  const parts = text
    .split(SPLIT_RE)
    .map((p) => cleanText(p))
    .filter((p) => p !== "")

  if (parts.length === 0) return { normFull: "", normSadr: "", split: false, clean: "", words: 0 }

  const clean = parts.join(" ")
  const normFull = normalizeArabic(clean)
  // Three or more pieces means the player pasted a whole مقطوعة or used a
  // separator mid-صدر; the first piece is still the صدر.
  const split = parts.length >= 2
  const normSadr = split ? normalizeArabic(parts[0]!) : normFull
  return { normFull, normSadr, split, clean, words: normFull === "" ? 0 : normFull.split(" ").length }
}

/** Token set of an already-normalized string. */
function tokensOf(norm: string): Set<string> {
  const out = new Set<string>()
  for (const t of norm.split(" ")) if (t !== "") out.add(t)
  return out
}

/** |A ∩ B| / |A ∪ B| over word tokens. 1 when both are empty-ish. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** design-server.md §8's second gate: 0.6 ≤ |query| / |bait| ≤ 1.6. */
function lengthOk(queryLen: number, targetLen: number): boolean {
  if (targetLen === 0) return false
  const ratio = queryLen / targetLen
  return ratio >= VERIFY.minLenRatio && ratio <= VERIFY.maxLenRatio
}

export interface Scored {
  row: Row
  score: number
  /** which half of the بيت produced the score */
  against: "full" | "sadr"
  /** the candidate's own normalized full text — the identity two قصائد share */
  norm: string
}

/**
 * Score one candidate against the answer, best-of-two: the whole بيت and its
 * صدر alone. The صدر target is what makes «accepts صدر only» work without a
 * separate code path — a صدر-only answer scores ~0 against the full بيت (the
 * length gate rejects it outright) and ~1 against the صدر.
 */
function scoreCandidate(row: Row, q: SplitText): Scored {
  const sadr = str(row.b_sadr)
  const ajuz = strOrNull(row.b_ajuz)
  const normBaitFull = ajuz === null ? normalizeArabic(sadr) : normalizeArabic(`${sadr} ${ajuz}`)
  const normBaitSadr = normalizeArabic(sadr)
  const qTokens = tokensOf(q.normFull)
  const qLen = q.normFull.length

  let best: Scored = { row, score: 0, against: "full", norm: normBaitFull }
  const consider = (target: string, against: "full" | "sadr") => {
    if (!lengthOk(qLen, target.length)) return
    const s = jaccard(qTokens, tokensOf(target))
    if (s > best.score) best = { row, score: s, against, norm: normBaitFull }
  }
  consider(normBaitFull, "full")
  if (normBaitSadr !== normBaitFull) consider(normBaitSadr, "sadr")
  return best
}

/** Load the full context row for a bait id. One primary-key lookup. */
function baitRowById(db: Db, id: number): Row | undefined {
  return db.q(`SELECT ${SERVED_COLS} ${BAIT_FROM} WHERE b.id = ?`).get(id) as Row | undefined
}

/**
 * The OR fallback's MATCH expression, built from the SPARSEST terms only.
 *
 * `bm25()` has to score every row a MATCH touches, and an OR over «في» touches
 * 721,320 أبيات. Measured on data/qarid.db, «إذا غامرت في شرف مروم…»: the
 * complete OR took 411 ms and the same query over its four-letters-or-longer
 * terms took 3.2 ms — and returned the same three top hits, because bm25 already
 * gives a term matching a fifth of the corpus almost no weight. Length is a
 * free proxy for rarity in Arabic: the short tokens are the particles.
 *
 * The floor drops rather than emit a useless query, so a بيت made entirely of
 * short words still gets its OR pass, just slowly. Quoting stays where it
 * belongs — the selected terms are handed back to `ftsQuery`, never quoted here
 * (shared/arabic.ts is the only text layer, CLAUDE.md invariant).
 */
export const OR_TERM_MIN_LENGTH = 4
export const OR_TERM_CAP = 8

export function sparseOrQuery(norm: string): string {
  const all = [...new Set(ftsTerms(norm))].filter((t) => !t.includes(" "))
  const bySize = [...all].sort((a, b) => [...b].length - [...a].length)
  for (const floor of [OR_TERM_MIN_LENGTH, OR_TERM_MIN_LENGTH - 1, 0]) {
    const kept = bySize.filter((t) => [...t].length >= floor).slice(0, OR_TERM_CAP)
    if (kept.length >= 2 || (kept.length === all.length && kept.length > 0)) {
      return ftsQuery(kept.join(" "), "or")
    }
  }
  return ftsQuery(norm, "or")
}

/** The top-`n` FTS5 hits for an already-built MATCH expression, best first. */
function ftsCandidates(db: Db, match: string, n: number): number[] {
  if (match === "") return []
  const rows = db
    .q(`SELECT rowid AS bid FROM baits_fts WHERE baits_fts MATCH ? ORDER BY bm25(baits_fts) ASC LIMIT ${n}`)
    .all(match) as Row[]
  return rows.map((r) => num(r.bid))
}

/**
 * How close two passing candidates have to be before the verifier refuses to
 * choose between them.
 *
 * Deliberately tight. An exact hash hit never reaches this code, so the
 * duplicate-قصيدة case (byte-identical text under two ids — the corpus has
 * plenty) is already accepted upstream; what is left is two genuinely different
 * أبيات that a fuzzy score cannot separate, and asking the player which one they
 * meant is the only honest answer. A wide band here would turn "I recognise your
 * بيت" into "pick one of four", which reads as a rejection.
 */
export const AMBIGUOUS_BAND = 0.02

/**
 * The candidates the verifier cannot choose between, best first — empty or
 * length-1 when there is a clear winner.
 *
 * design-server.md §8's rule is "≥2 candidates pass with near-equal score and
 * DIFFERENT poems", and both halves matter:
 *  • one entry per قصيدة, because the same بيت indexed at two positions of one
 *    ديوان (the corpus does this) is one answer, not two;
 *  • and never two entries carrying the same normalized text, because a قصيدة
 *    scraped twice under two ids is also one answer — offering the player an
 *    identical pair to choose from is the worst possible reading of "ambiguous".
 */
export function rivalsOf(passing: readonly Scored[], band = AMBIGUOUS_BAND, max = 4): Scored[] {
  if (passing.length === 0) return []
  const sorted = [...passing].sort((a, b) => b.score - a.score)
  const best = sorted[0]!
  const poems = new Set<number>([num(best.row.p_id)])
  const texts = new Set<string>([best.norm])
  const rivals: Scored[] = [best]
  for (const cand of sorted.slice(1)) {
    if (best.score - cand.score > band) break
    const poemId = num(cand.row.p_id)
    if (poems.has(poemId) || texts.has(cand.norm)) continue
    poems.add(poemId)
    texts.add(cand.norm)
    rivals.push(cand)
    if (rivals.length === max) break
  }
  return rivals
}

/**
 * The verifier. Order is design-server.md §8's, with amendment 7's `near_miss`
 * spliced in between the fuzzy gate and `not_found`:
 *
 *   too_short → wrong_letter → exact h_full → exact h_sadr (ranked, never rowid)
 *             → FTS AND (jaccard ≥ 0.60) → FTS OR (jaccard ≥ 0.75)
 *             → ambiguous → already_used → incomplete_bait
 *             → near_miss (best ≥ 0.35) → not_found (≤3 suggestions)
 */
export function verifyAnswer(db: Db, req: GameVerifyRequest): GameVerifyResponse {
  const mode = req.mode
  const q = splitAnswer(req.text)

  // 1. Under two words nothing can be identified and nothing reaches SQLite.
  if (q.words < 2) return { ok: false, reason: "too_short", words: q.words }

  // 2. The chain letter. `prevBaitId` is authoritative; `requiredLetter` is the
  //    fallback after «بدّل الحرف», when there is no previous بيت to read.
  const prev = req.prevBaitId === undefined ? undefined : baitRowById(db, req.prevBaitId)
  let expected: ArabicLetter | null = null
  let alsoAccepted: ArabicLetter[] = []
  if (prev !== undefined) {
    const state = chainState(prev, mode)
    expected = state.requiredLetter
    alsoAccepted = state.alsoAccepted
  } else if (req.requiredLetter !== undefined) {
    expected = req.requiredLetter
  }

  const got = firstLetterOf(q.normFull) as ArabicLetter | null
  if (expected !== null && got !== expected && !alsoAccepted.includes(got as ArabicLetter)) {
    return { ok: false, reason: "wrong_letter", expected, alsoAccepted, got, normalized: q.normFull }
  }

  const usedBaits = new Set(req.usedBaitIds)
  const usedPoems = new Set(req.usedPoemIds)

  // 3. The exact ladder. `h_full`/`h_sadr` are fnv1a64 over the SAME normalized
  //    string `scripts/ingest/transform.ts` hashed, which is why this works at
  //    all — one normalizer, one hash, no drift (CLAUDE.md invariant).
  //
  //    Both rungs return every copy the corpus holds, RANKED (see `exactCopies`)
  //    — never "whichever id is lowest". The صدر rung then gets two more passes:
  //    the عجز the player supplied re-ranks it, and copies that would chain on
  //    different letters are asked about instead of guessed at.
  let rows = exactCopies(db, "h_full", q.normFull)
  let kind: MatchKind = "exact"
  if (rows.length === 0) {
    rows = exactCopies(db, "h_sadr", q.normSadr)
    kind = "sadr"
  }
  if (rows.length > 0) {
    if (kind === "sadr") {
      rows = rankByAjuz(rows, q)
      const clash = chainClash(rows, mode, q)
      if (clash !== null) {
        return { ok: false, reason: "ambiguous", normalized: q.normFull, candidates: clash.map((r) => baitDto(r)) }
      }
    }
    return settle(db, rows, kind, 1, q, mode, usedBaits, usedPoems)
  }

  // 4. Fuzzy. AND first at the loose gate, then OR at the strict one — an OR
  //    query matches on any single word, so it needs a higher bar to mean
  //    anything (design-server.md §8).
  const scored = new Map<number, Scored>()
  const collect = (ids: number[]) => {
    for (const id of ids) {
      if (scored.has(id)) continue
      const row = baitRowById(db, id)
      if (row !== undefined) scored.set(id, scoreCandidate(row, q))
    }
  }

  collect(ftsCandidates(db, ftsQuery(q.normFull, "and"), VERIFY.candidates))
  let passing = [...scored.values()].filter((s) => s.score >= VERIFY.andJaccard)
  if (passing.length === 0) {
    collect(ftsCandidates(db, sparseOrQuery(q.normFull), VERIFY.candidates))
    passing = [...scored.values()].filter((s) => s.score >= VERIFY.orJaccard)
    if (passing.length === 0) passing = uncontestedMatch([...scored.values()])
  }

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score)

  if (passing.length > 0) {
    const rivals = rivalsOf(passing)
    const best = rivals[0]!
    // 5. ambiguous — two different قصائد the score cannot separate.
    if (rivals.length >= 2) {
      return {
        ok: false,
        reason: "ambiguous",
        normalized: q.normFull,
        candidates: rivals.map((r) => baitDto(r.row)),
      }
    }
    // A fuzzy match is allowed to differ from what was typed — that is its
    // whole job — but it is NOT allowed to move the chain letter. «وقفا نبكِ»
    // is one و away from «قِفا نبكِ», and the corpus بيت begins on ق: accepting
    // it on a و turn would let anyone prefix a letter onto any بيت and satisfy
    // any روي. The letter rule is about the بيت as the ديوان has it, so the
    // بيت we actually matched has to start on the letter too.
    if (expected !== null) {
      const found = letterOrNull(best.row.b_first_letter)
      if (found !== null && found !== expected && !alsoAccepted.includes(found as ArabicLetter)) {
        return { ok: false, reason: "wrong_letter", expected, alsoAccepted, got: found as ArabicLetter, normalized: q.normFull }
      }
    }
    return settle(db, [best.row], "fuzzy", best.score, q, mode, usedBaits, usedPoems)
  }

  // 6. amendment 7: anything recognisable enough to name gets a suggestion and
  //    an «اقبل هذا البيت» button, not a flat "no". The doc's band is
  //    0.35–0.60 because 0.60 is the AND gate; stated as "≥ 0.35 and not
  //    accepted" it stays right when the OR gate (0.75) is the one that bit.
  const best = ranked[0]
  if (best !== undefined && best.score >= VERIFY.nearMissBand[0]) {
    return {
      ok: false,
      reason: "near_miss",
      normalized: q.normFull,
      suggestion: baitDto(best.row),
      score: Number(best.score.toFixed(4)),
      acceptCost: HINT_COSTS.accept_near_miss,
    }
  }

  return {
    ok: false,
    reason: "not_found",
    normalized: q.normFull,
    suggestions: ranked.slice(0, 3).map((s) => baitDto(s.row)),
  }
}

/**
 * How far ahead of the field a sub-0.75 OR candidate must be to be accepted
 * anyway. See `uncontestedMatch`.
 */
export const UNIQUE_MARGIN = 0.1

/**
 * The third rung of the fuzzy ladder, and the one measured play forced.
 *
 * design-server.md §8 gates the OR retry at jaccard 0.75, which is right for
 * what OR is: a query that matches on any single word and therefore drags in
 * noise. But the AND pass — gated at the far gentler 0.60 — needs EVERY term to
 * be present, so one misremembered word drops an answer straight from the 0.60
 * gate to the 0.75 one. That is the wrong shape: misremembering a word is the
 * single most common thing a person does when quoting poetry from memory.
 *
 * Measured against data/qarid.db: «جزى الله الشدائد كل خير / عرفت بها عدوّي من
 * صديقي» — a بيت any reader knows — is in the corpus as the variant «جزى الله
 * المغنّي…عرفت به…». Two tokens differ out of twelve, jaccard 0.667, and the
 * strict gate called it a near_miss. It is not a near miss; it is the بيت.
 *
 * So: between 0.60 and 0.75 an answer is accepted only if it is UNCONTESTED —
 * the best-scoring قصيدة is at least `UNIQUE_MARGIN` clear of the next distinct
 * one. That is precisely the noise the 0.75 gate exists to catch: OR noise
 * arrives as a cluster of mediocre look-alikes, never as one lone بيت that
 * happens to share two thirds of your words inside the length band. When the
 * field IS contested the answer falls through to `near_miss`, which offers the
 * suggestion and charges 25 points to accept it — the player still gets there,
 * they just pay for the doubt.
 */
export function uncontestedMatch(all: readonly Scored[]): Scored[] {
  const lenient = all.filter((s) => s.score >= VERIFY.andJaccard).sort((a, b) => b.score - a.score)
  const best = lenient[0]
  if (best === undefined) return []
  const contender = lenient
    .slice(1)
    .find((s) => num(s.row.p_id) !== num(best.row.p_id) && s.norm !== best.norm)
  if (contender === undefined) return [best]
  // Rounded, so a gap of exactly UNIQUE_MARGIN counts as clear: 0.7 − 0.6 is
  // 0.09999999999999998 in binary floating point, and "just barely uncontested"
  // must not turn on that.
  const gap = Number((best.score - contender.score).toFixed(6))
  return gap < UNIQUE_MARGIN ? [] : [best]
}

/**
 * How many copies of one exact hash the verifier ranks. The corpus holds the
 * same بيت under up to 51 ids (`h_full`) and the same صدر under up to 295
 * (`h_sadr`), so a cap is needed; eight is enough to see every distinct روي a
 * famous صدر carries, and `alreadyUsed` no longer depends on the cap at all.
 */
export const EXACT_CANDIDATES = 8

/**
 * Every copy of an exact hash, BEST FIRST — the rung the whole blocker lived on.
 *
 * `ORDER BY b.id` (what this used to be) resolves «قفا نبك من ذكرى حبيب ومنزل»
 * to whichever of its copies SQLite inserted first: id 50954, أبو العباس
 * الجراوي, روي ب — not امرؤ القيس, روي ل. That is not a display detail: the
 * chain letter, the poet, the obscurity and therefore the score are all read
 * off the row this query returns first. The corpus has 21,739 صدر groups whose
 * copies carry DIFFERENT روي (69,139 أبيات), so rowid order decides the game on
 * a large slice of exactly the أبيات people quote.
 *
 * `po.fame DESC, b.position ASC, b.id ASC`: the canonical شاعر first, then the
 * copy where the بيت sits nearest the مطلع, then the deterministic tiebreak.
 * Every copy is joined out anyway (≤295 rows), so the sort is free.
 */
function exactCopies(db: Db, column: "h_full" | "h_sadr", norm: string): Row[] {
  if (norm === "") return []
  return db
    .q(
      `SELECT ${SERVED_COLS} ${BAIT_FROM} WHERE b.${column} = ?
       ORDER BY po.fame DESC, b.position ASC, b.id ASC LIMIT ${EXACT_CANDIDATES}`,
    )
    .all(fnv1a64Signed(norm)) as Row[]
}

/**
 * The صدر rung, re-ranked by the عجز the player actually typed.
 *
 * When the answer was «جزى الله الشدائد كل خير / عرفت بها عدوي من صديقي» and
 * the exact `h_full` missed by one word, the صدر rung matches every copy of
 * «جزى الله الشدائد كل خير» — including copies whose عجز is a different بيت
 * entirely («وان جرعننى غصصى بريقى», روي ق, against «عَرَفْتُ بها الصَّديْقَ مِنَ
 * الْأعَادِي», روي د). Throwing the supplied عجز away and taking the famest copy
 * would be the same bug in a new coat, so the half the player DID give is what
 * decides — fame order survives as the tiebreak (a stable sort on ties).
 */
function rankByAjuz(rows: Row[], q: SplitText): Row[] {
  if (!q.split || rows.length < 2) return rows
  const qTokens = tokensOf(q.normFull)
  return rows
    .map((row, i) => ({ row, i, score: jaccard(qTokens, tokensOf(fullNormOf(row))) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.row)
}

/** A candidate row's own normalized full text — the identity two قصائد share. */
function fullNormOf(row: Row): string {
  const sadr = str(row.b_sadr)
  const ajuz = strOrNull(row.b_ajuz)
  return ajuz === null ? normalizeArabic(sadr) : normalizeArabic(`${sadr} ${ajuz}`)
}

/**
 * The copies of one صدر that would send the duel down DIFFERENT letters, or
 * `null` when the answer is not in doubt.
 *
 * A صدر-only answer («يُقبل الصدر وحده» is printed under the answer box) names
 * a بيت only as far as its first hemistich, and 21,739 صدر groups in the corpus
 * disagree about the روي of the second. Picking one and demanding its letter
 * makes the game unplayable in the most public way possible: the player answers
 * «قفا نبك من ذكرى حبيب ومنزل» and is then told the chain is on ب.
 *
 * Fame still settles what fame can settle — امرؤ القيس outranks أبو العباس
 * الجراوي and the duel simply moves on — so this fires only when the copies the
 * verifier cannot separate would chain differently. Then the client's existing
 * `ambiguous` branch asks («وجدتُ أكثر من بيت»), which costs the player nothing.
 */
function chainClash(rows: Row[], mode: ChainMode, q: SplitText): Row[] | null {
  if (q.split) return null
  const complete = rows.filter((r) => strOrNull(r.b_ajuz) !== null)
  const best = complete[0]
  if (best === undefined) return null
  const bestFame = num(best.po_fame)
  const letters = new Set<string>([chainState(best, mode).requiredLetter])
  const rivals: Row[] = [best]
  for (const row of complete.slice(1)) {
    if (num(row.po_fame) < bestFame) continue
    const letter = chainState(row, mode).requiredLetter
    if (letters.has(letter)) continue
    letters.add(letter)
    rivals.push(row)
    if (rivals.length === 4) break
  }
  return rivals.length >= 2 ? rivals : null
}

/**
 * Has any copy of this بيت already been played?
 *
 * The candidate list is capped (`EXACT_CANDIDATES`), so testing it alone lets a
 * بيت held under more copies than the cap be replayed verbatim for a full award
 * — 953 `h_full` groups (5,919 أبيات) are over the old cap of four. The whole
 * group is therefore asked for by hash, narrow (`baits_hfull`, two columns), and
 * only when the duel has actually played something.
 *
 * The hash is recomputed from the row's own text with the one normalizer rather
 * than read back out of the column: `server/` never spells a hash twice.
 */
function alreadyUsed(db: Db, row: Row, usedBaits: Set<number>, usedPoems: Set<number>): Row | undefined {
  if (usedBaits.size === 0 && usedPoems.size === 0) return undefined
  const copies = db
    .q("SELECT b.id AS id, b.poem_id AS pid FROM baits b WHERE b.h_full = ?")
    .all(fnv1a64Signed(fullNormOf(row))) as Row[]
  for (const copy of copies) {
    if (usedBaits.has(num(copy.id)) || usedPoems.has(num(copy.pid))) return baitRowById(db, num(copy.id))
  }
  return undefined
}

/**
 * A complete copy of the same صدر, when every candidate we ranked is missing its
 * عجز. One index lookup on `baits_hsadr`, and it is the difference between
 * «هذا البيت ناقص العجز» (which costs the player a life) and simply serving the
 * copy that has the whole بيت — the corpus stores 24,378 قصائد with an odd
 * verse count, and which copy of a بيت got truncated is not the player's fault.
 */
function completeCopy(db: Db, row: Row): Row | undefined {
  return db
    .q(
      `SELECT ${SERVED_COLS} ${BAIT_FROM} WHERE b.h_sadr = ? AND b.ajuz IS NOT NULL
       ORDER BY po.fame DESC, b.position ASC, b.id ASC LIMIT 1`,
    )
    .get(fnv1a64Signed(normalizeArabic(str(row.b_sadr)))) as Row | undefined
}

/**
 * The last three rungs, shared by every path that found a بيت: was it already
 * played, is it one of the 24,378 قصائد whose last بيت has no عجز, and
 * otherwise — accept.
 *
 * `already_used` is checked across ALL exact matches AND across every copy the
 * corpus holds of the بيت about to be served (`alreadyUsed`), not just the ones
 * that fit under the candidate cap: the corpus carries the same بيت under up to
 * 51 ids, and "answer it again with the other copy" is not a legal move.
 */
function settle(
  db: Db,
  rows: Row[],
  kind: MatchKind,
  confidence: number,
  q: SplitText,
  mode: ChainMode,
  usedBaits: Set<number>,
  usedPoems: Set<number>,
): GameVerifyResponse {
  const used = rows.find((r) => usedBaits.has(num(r.b_id)) || usedPoems.has(num(r.p_id)))
  if (used !== undefined) return { ok: false, reason: "already_used", bait: baitDto(used) }

  const complete = rows.find((r) => strOrNull(r.b_ajuz) !== null) ?? completeCopy(db, rows[0]!)
  if (complete === undefined) return { ok: false, reason: "incomplete_bait", bait: baitDto(rows[0]!) }

  const elsewhere = alreadyUsed(db, complete, usedBaits, usedPoems)
  if (elsewhere !== undefined) return { ok: false, reason: "already_used", bait: baitDto(elsewhere) }

  return {
    ok: true,
    matchKind: kind,
    confidence: Number(Math.min(1, Math.max(0, confidence)).toFixed(4)),
    normalized: q.normFull,
    ...servedBait(complete, mode),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hints — design-ux.md §4 + amendment 8
// ─────────────────────────────────────────────────────────────────────────────

export { HINT_COSTS }

/**
 * The candidate the three cheap hints describe.
 *
 * They are hints about an ANSWER, not about the بيت on screen — «أول كلمة» is
 * meaningless otherwise (the opponent's first word is already visible), and
 * design-ux.md §4 says as much: "consumed against server-held candidate". So the
 * server picks a بيت that would legally answer the required letter and reveals
 * one fact about it.
 *
 * The pick is seeded WITHOUT the hint kind in the seed, deliberately: buying
 * «من قائله؟» and then «أول كلمة» has to describe the same بيت, or the two hints
 * contradict each other and the player has paid 100 points for noise.
 */
export function hintCandidate(
  db: Db,
  letter: string,
  difficulty: Difficulty,
  filters: GameFilters | undefined,
  seed: string | undefined,
): Row | null {
  const picked = pickBait(db, {
    letter,
    difficulty,
    tailBias: "none",
    filters,
    seed: `hint:${seed ?? ""}:${letter}:${difficulty}`,
  })
  return picked === null ? null : picked.row
}

/** The first word of a بيت's صدر, tashkeel intact — «أول كلمة» costs 60. */
export function firstWordOf(row: Row): string {
  const sadr = cleanText(str(row.b_sadr))
  const word = sadr.split(" ")[0] ?? ""
  return word
}

/**
 * amendment 8's mercy option: a brand-new required letter from a famous بيت, so
 * a duel never dead-ends on ظ. The replacement deliberately avoids the rare set
 * (`tailBias: 'easy'`) and never lands back on the letter being abandoned —
 * paying 150 points and a streak to be handed the same wall would be a bug.
 */
export function switchLetterBait(
  db: Db,
  abandoned: string | undefined,
  filters: GameFilters | undefined,
  seed: string | undefined,
  mode: ChainMode = "rhyme",
): Row | null {
  let fallback: Row | null = null
  for (let attempt = 0; attempt < SWITCH_TRIES; attempt++) {
    for (const difficulty of ["easy", "normal", "brutal"] as const) {
      const picked = pickBait(db, {
        difficulty,
        tailBias: "easy",
        filters,
        seed: seed === undefined ? undefined : `switch:${seed}:${abandoned ?? ""}:${attempt}`,
        avoidRawiyy: abandoned,
      })
      if (picked === null) continue
      fallback ??= picked.row
      // `avoidRawiyy` constrains `game_baits.rawiyy`, which is the letter
      // `rhyme` mode demands. In `literal` mode the wall the player is paying
      // 150 points to walk away from is the LITERAL final letter, and that is
      // not in the index — so the pick is checked here and re-seeded when it
      // hands back the same wall under another name (amendment 8's guarantee).
      if (mode === "rhyme" || abandoned === undefined) return picked.row
      if (chainState(picked.row, mode).requiredLetter !== abandoned) return picked.row
    }
  }
  return fallback
}

/** How many re-seeds `switchLetterBait` spends dodging the abandoned letter. */
const SWITCH_TRIES = 4
