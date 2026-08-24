/**
 * `/api/baits` — بيت-mode browse, the serendipity picker and بيت اليوم
 * (design-server.md §7, amendment 6).
 *
 *   GET /api/baits         list, for browse when روي / حرف البداية is active
 *   GET /api/baits/random  one بيت, seeded or not
 *   GET /api/baits/daily   the shared بيت اليوم + شاعر اليوم
 *   GET /api/baits/:id     one بيت with its neighbours in the قصيدة
 *
 * The first three read `game_baits`, not `baits`. That is deliberate and it is
 * the only way these routes are affordable: `baits` has no index on
 * `first_letter` or `rawiyy` (§5 indexes it by poem and by hash only), while
 * `game_baits` is indexed on exactly those columns AND carries the `bucket` /
 * `rand` sampling keys. It is also the right *content*: `game_baits` is the
 * amendment-3 playable pool, so browse never serves a truncated hemistich or a
 * عامي fragment, and its per-letter counts are precisely the ones `/api/meta`
 * already published (amendment 10) — the letter grid's numbers and the list it
 * opens agree by construction.
 *
 * `ORDER BY RANDOM()` appears nowhere: on 2.2M rows it sorts 2.2M rows. Every
 * sample here is a wrap-around window over `bucket` (CLAUDE.md invariant).
 */

import { Hono } from "hono"

import { fnv1a32, isArabicLetter, stripTashkeel } from "../../shared/arabic.ts"
import { DAILY_TIMEZONE } from "../../shared/constants.ts"
import {
  BaitsQuerySchema,
  DailyQuerySchema,
  RandomBaitQuerySchema,
  type BaitDto,
  type BaitDetailResponse,
  type DailyResponse,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import {
  BAIT_COLS,
  BAIT_CONTEXT_COLS,
  BAIT_JOINS,
  POEM_COLS,
  POEM_JOINS,
  POET_COLS,
  POET_EXTRA_COLS,
  POET_JOINS,
  baitDto,
  poemSummary,
  poetSummary,
  type Row,
} from "../dto.ts"
import { BUCKET_COUNT, decodeParam, listBody, notFound, parseQuery, poetIdBySlug, slugMaps } from "../query.ts"

/** `game_baits` + the بيت itself + the context a `BaitDto` carries. */
const GB_FROM = `FROM game_baits gb JOIN baits b ON b.id = gb.bait_id ${BAIT_JOINS}`
/** The same, widened to a full `PoemSummary` (بيت اليوم needs one). */
const GB_FROM_WIDE = `FROM game_baits gb JOIN baits b ON b.id = gb.bait_id JOIN poems p ON p.id = b.poem_id ${POEM_JOINS}`

interface GbFilter {
  where: string
  params: Array<string | number>
  impossible: boolean
  /** the filter mentions `poems`, so a bare count still has to join it */
  needsPoem: boolean
}

function gameBaitFilter(
  db: Db,
  q: { era?: string; meter?: string; theme?: string; poet?: string; rhyme?: string; first?: string; fame?: number },
): GbFilter {
  const maps = slugMaps(db)
  const where: string[] = []
  const params: Array<string | number> = []
  let impossible = false
  let needsPoem = false

  if (q.first !== undefined) {
    where.push("gb.first_letter = ?")
    params.push(q.first)
  }
  if (q.rhyme !== undefined) {
    where.push("gb.rawiyy = ?")
    params.push(q.rhyme)
  }
  if (q.era !== undefined) {
    const id = maps.era.get(q.era)
    if (id === undefined) impossible = true
    else {
      where.push("gb.era_id = ?")
      params.push(id)
    }
  }
  if (q.meter !== undefined) {
    const id = maps.meter.get(q.meter)
    if (id === undefined) impossible = true
    else {
      where.push("gb.meter_id = ?")
      params.push(id)
    }
  }
  if (q.theme !== undefined) {
    const id = maps.theme.get(q.theme)
    if (id === undefined) impossible = true
    else {
      where.push("p.theme_id = ?")
      params.push(id)
      needsPoem = true
    }
  }
  if (q.poet !== undefined) {
    const id = poetIdBySlug(db, q.poet)
    if (id === null) impossible = true
    else {
      where.push("p.poet_id = ?")
      params.push(id)
      needsPoem = true
    }
  }
  if (q.fame !== undefined) {
    where.push("gb.fame >= ?")
    params.push(q.fame)
  }

  return { where: where.length === 0 ? "1 = 1" : where.join(" AND "), params, impossible, needsPoem }
}

function countGameBaits(db: Db, filter: GbFilter): number {
  if (filter.impossible) return 0
  const join = filter.needsPoem ? "JOIN poems p ON p.id = gb.poem_id" : ""
  const row = db.q(`SELECT COUNT(*) AS n FROM game_baits gb ${join} WHERE ${filter.where}`).get(...filter.params) as {
    n: number
  }
  return Number(row.n)
}

/**
 * The wrap-around bucket window: take the first row at or after `start`, and if
 * the window came up empty (a thin filter whose rows all sit below `start`)
 * wrap once to the bottom. Two index range scans, worst case.
 */
function sampleOne(db: Db, filter: GbFilter, extra: string, start: number, from = GB_FROM): Row | undefined {
  return sampleSome(db, filter, extra, start, from, 1)[0]
}

/**
 * The same wrap-around window, `take` rows deep — بيت اليوم needs candidates,
 * not a candidate, because it has one more gate to pass (`textIsClean`).
 */
function sampleSome(db: Db, filter: GbFilter, extra: string, start: number, from: string, take: number): Row[] {
  if (filter.impossible) return []
  const cond = extra === "" ? filter.where : `${filter.where} AND ${extra}`
  const page = (op: ">=" | "<", n: number) =>
    db
      .q(
        `SELECT ${BAIT_COLS}, ${from === GB_FROM ? BAIT_CONTEXT_COLS : `${POEM_COLS}, ${POET_EXTRA_COLS}`}
         ${from}
         WHERE ${cond} AND gb.bucket ${op} ?
         ORDER BY gb.bucket ASC, gb.rand ASC, gb.bait_id ASC LIMIT ?`,
      )
      .all(...filter.params, start, n) as Row[]
  const rows = page(">=", take)
  if (rows.length < take) rows.push(...page("<", take - rows.length))
  return rows
}

/** `YYYY-MM-DD` on the Gulf calendar — بيت اليوم turns over in Riyadh. */
export function riyadhDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DAILY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

/**
 * How many candidates بيت اليوم looks at before it settles for a damaged one.
 * Six of seven sampled days pass the gate on the first row, so this is a
 * deterministic tiebreak, not a search.
 */
const DAILY_CANDIDATES = 12

/** The first candidate in the window whose text is undamaged, if any. */
function cleanest(db: Db, filter: GbFilter, extra: string, start: number): Row | undefined {
  const rows = sampleSome(db, filter, extra, start, GB_FROM_WIDE, DAILY_CANDIDATES)
  return rows.find((r) => textIsClean(String(r.b_sadr), r.b_ajuz === null ? null : String(r.b_ajuz))) ?? rows[0]
}

/**
 * The one shape of scraper damage worth a predicate: a hemistich that begins
 * with an orphaned letter.
 *
 * It is what a word cut at a page/line boundary leaves behind — «…معاهده الغر»
 * followed by «ر ويروى…» — and Arabic has no one-letter word: و، ف، ب، ل، ك and
 * the interrogative أ are all prefixes, written joined. So a whitespace-delimited
 * first token of exactly one letter (tashkeel discounted — the mark rides on the
 * orphan too) is always damage, and never a line someone wrote.
 */
export function textIsClean(sadr: string, ajuz: string | null): boolean {
  return !startsWithOrphanLetter(sadr) && (ajuz === null || !startsWithOrphanLetter(ajuz))
}

function startsWithOrphanLetter(text: string): boolean {
  const first = stripTashkeel(text).trim().split(/\s+/)[0] ?? ""
  return [...first].length === 1 && isArabicLetter(first)
}

export function baitsRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()

  // ── GET /api/baits/random ────────────────────────────────────────────────
  app.get("/random", (c) => {
    const parsed = parseQuery(c, RandomBaitQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data
    const filter = gameBaitFilter(db, q)
    const start = q.seed === undefined ? Math.floor(Math.random() * BUCKET_COUNT) : fnv1a32(q.seed) % BUCKET_COUNT
    const row = sampleOne(db, filter, "", start)
    if (row === undefined) return c.json({ error: "no_bait" }, 404)
    return c.json(baitDto(row))
  })

  // ── GET /api/baits/daily (amendment 6) ───────────────────────────────────
  app.get("/daily", (c) => {
    const parsed = parseQuery(c, DailyQuerySchema)
    if (!parsed.ok) return parsed.res
    const date = parsed.data.date ?? riyadhDay()
    const start = fnv1a32(date) % BUCKET_COUNT
    const filter = gameBaitFilter(db, {})

    // Prefer a famous مطلع; relax rather than fail on a thin corpus. Each pass
    // is a window rather than a single row because fame and position say
    // nothing about the TEXT, and بيت اليوم is the one بيت every visitor sees:
    // 2026-08-24 opened on «يطلب العلم من معاهده الغر / ر ويروىَ من نجعة
    // الوراد», where the scraper cut «الغرر» after the first ر and pushed the
    // orphan letter to the head of the عجز. `textIsClean` is the gate; the
    // window is what it needs something to choose from.
    const row =
      cleanest(db, filter, "gb.fame >= 2 AND gb.position <= 8", start) ??
      cleanest(db, filter, "gb.position <= 8", start) ??
      cleanest(db, filter, "", start)
    if (row === undefined) return c.json({ error: "no_bait" }, 404)

    const poet = poetOfTheDay(db, date)
    if (poet === null) return c.json({ error: "no_bait" }, 404)

    const body: DailyResponse = {
      date,
      // The whole chain on #/daily is derived from this string: the client
      // passes `${seed}:${turn}` to /api/game/reply so everyone meets the same
      // opponent, بيت for بيت (amendment 6).
      seed: `daily:${date}`,
      bait: baitDto(row),
      poem: poemSummary(row),
      poetOfTheDay: poet,
    }
    return c.json(body)
  })

  // ── GET /api/baits ───────────────────────────────────────────────────────
  app.get("/", (c) => {
    const parsed = parseQuery(c, BaitsQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data
    const filter = gameBaitFilter(db, q)
    const total = countGameBaits(db, filter)
    if (total === 0) return c.json(listBody([], 0, q.page, q.limit))
    // `page` is clamped by the schema at 100,000, which on a filtered pool of
    // 200 أبيات still means "sort the pool, then skip past the end of it". A
    // page past the last one costs one COUNT and nothing else.
    if ((q.page - 1) * q.limit >= total) return c.json(listBody([], total, q.page, q.limit))

    // The sort runs over `game_baits` ALONE — a covering scan of gb_pick — and
    // only the ≤100 surviving ids are joined out to baits/poems/poets. Sorting
    // the joined rows instead cost 2.6 SECONDS on the unfiltered 1.76M-row
    // pool, because SQLite materialised every join before the LIMIT could bite.
    const narrowJoin = filter.needsPoem ? "JOIN poems p ON p.id = gb.poem_id" : ""
    const rows = db
      .q(
        `SELECT ${BAIT_COLS}, ${BAIT_CONTEXT_COLS}
         FROM (SELECT gb.bait_id AS bid, gb.fame AS f
               FROM game_baits gb ${narrowJoin}
               WHERE ${filter.where}
               ORDER BY gb.fame DESC, gb.bait_id ASC LIMIT ? OFFSET ?) sel
         JOIN baits b ON b.id = sel.bid
         ${BAIT_JOINS}
         ORDER BY sel.f DESC, sel.bid ASC`,
      )
      .all(...filter.params, q.limit, (q.page - 1) * q.limit) as Row[]
    return c.json(listBody(rows.map(baitDto), total, q.page, q.limit))
  })

  // ── GET /api/baits/:id ───────────────────────────────────────────────────
  app.get("/:id", (c) => {
    const raw = decodeParam(c.req.param("id"))
    if (!/^\d+$/.test(raw)) return notFound(c, "bait")
    const id = Number(raw)
    if (!Number.isSafeInteger(id) || id <= 0) return notFound(c, "bait")

    const row = db
      .q(
        `SELECT ${BAIT_COLS}, ${POEM_COLS}, ${POET_EXTRA_COLS}
         FROM baits b JOIN poems p ON p.id = b.poem_id ${POEM_JOINS} WHERE b.id = ?`,
      )
      .get(id) as Row | undefined
    if (row === undefined) return notFound(c, "bait")

    const poemId = Number(row.p_id)
    const position = Number(row.b_position)
    const neighbour = (op: "<" | ">", dir: "DESC" | "ASC"): BaitDto | null => {
      const n = db
        .q(
          `SELECT ${BAIT_COLS}, ${BAIT_CONTEXT_COLS} FROM baits b ${BAIT_JOINS}
           WHERE b.poem_id = ? AND b.position ${op} ? ORDER BY b.position ${dir} LIMIT 1`,
        )
        .get(poemId, position) as Row | undefined
      return n === undefined ? null : baitDto(n)
    }

    const body: BaitDetailResponse = {
      bait: baitDto(row),
      poem: poemSummary(row),
      poet: poetSummary(row),
      prev: neighbour("<", "DESC"),
      next: neighbour(">", "ASC"),
    }
    return c.json(body)
  })

  return app
}

/**
 * شاعر اليوم — deterministic for a date, and drawn from the notable half of
 * the ديوان (fame ≥ 2) so the home card never opens on a شاعر with one poem.
 */
function poetOfTheDay(db: Db, date: string) {
  const seed = fnv1a32(`poet:${date}`)
  for (const minFame of [2, 0]) {
    const total = Number(
      (db.q("SELECT COUNT(*) AS n FROM poets WHERE fame >= ?").get(minFame) as { n: number }).n,
    )
    if (total === 0) continue
    const row = db
      .q(
        `SELECT ${POET_COLS} FROM poets po ${POET_JOINS} WHERE po.fame >= ?
         ORDER BY po.fame DESC, po.poem_count DESC, po.id ASC LIMIT 1 OFFSET ?`,
      )
      .get(minFame, seed % total) as Row | undefined
    if (row !== undefined) return poetSummary(row)
  }
  return null
}
