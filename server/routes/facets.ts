/**
 * `GET /api/facets` — every value of every facet, zeros included
 * (design-server.md §7, design-ux.md §3).
 *
 * Two things make this route the interesting one.
 *
 * **Zeros are the point.** The browse rail's letter grids DISABLE a حرف at
 * zero rather than hiding it, and the empty state «جرّب إزالة: X (0 نتيجة)»
 * has to name the chip that emptied the combination. So the response always
 * carries all 12 عصور, all 16+ بحور, all 18 أغراض, both لغة values and both
 * 28-letter grids, whatever the filter says.
 *
 * **Each dimension drops itself.** Counting العصور *with* `era=abbasi`
 * applied would report 11 zeros and one total, which would freeze the rail on
 * the first chip a reader clicked. Every dimension is therefore counted with
 * the OTHER filters applied and its own dropped — the standard faceted-search
 * semantics, and the only reading of §7 under which the rail keeps working.
 * `total` alone reflects the complete filter.
 *
 * Speed: the unfiltered case (the common one — it is what the home screen's
 * أبواب tiles and a fresh #/browse ask for) is served verbatim from
 * `meta.facets_json`, computed once at ingest. A filtered case runs six narrow
 * `GROUP BY`s, five of which ride `poems_filter(era_id, meter_id, theme_id,
 * rhyme, id)` as a covering index.
 */

import { Hono } from "hono"

import { HIJAI_LETTERS } from "../../shared/letters.ts"
import {
  FacetsQuerySchema,
  FacetsResponseSchema,
  type ArabicLetter,
  type FacetsQuery,
  type FacetsResponse,
  type LangType,
  type LetterFacet,
  type SlugFacet,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { poemFilter, slugMaps, type Filter, type FilterKey } from "../query.ts"
import { metaJson } from "./meta.ts"

const LANG_VALUES: readonly LangType[] = ["فصيح", "عامي"]

export function facetsRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const parsed = FacetsQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({ error: "bad_query", issues: parsed.error.issues.map((i) => ({ path: [...i.path], message: i.message })) }, 400)
    }
    const q = trimNoOps(db, parsed.data)
    return c.json(anyFilter(q) ? filteredFacets(db, q) : unfilteredFacets(db))
  })

  return app
}

/**
 * Both caches hang off the DB HANDLE, not off the route closure.
 *
 * They used to be `let unfiltered` / `const memo` inside `facetsRoutes`, which
 * was fine while the only filler was the route itself. `warmFacets()` below
 * fills the same maps from `server/index.ts`, before any request exists and
 * without a `Hono` in hand, so the cache has to be reachable by handle — the
 * shape `MAPS` in `server/query.ts` and `MAX_BAITS` below already use. It stays
 * correct for the same reason those do: the artefact is immutable and opened
 * `query_only`, so a facet answer is a pure function of (handle, query), and a
 * second `createApp` over the same handle SHOULD see the first one's work.
 */
const UNFILTERED = new WeakMap<object, FacetsResponse>()
const MEMO = new WeakMap<object, Map<string, FacetsResponse>>()

/** The whole-corpus payload — precomputed at ingest into `meta.facets_json`. */
function unfilteredFacets(db: Db): FacetsResponse {
  const hit = UNFILTERED.get(db as object)
  if (hit !== undefined) return hit
  const fromMeta = FacetsResponseSchema.safeParse(metaJson(db, "facets_json"))
  const value = fromMeta.success ? fromMeta.data : computeFacets(db, FacetsQuerySchema.parse({}))
  UNFILTERED.set(db as object, value)
  return value
}

/**
 * The artefact is immutable, so `computeFacets(q)` is a pure function of the
 * query — and it is six GROUP BYs over 238,733 قصائد, 102 ms for `?first=ا`
 * and 232 ms for `?lang=فصيح`, every one of them blocking the event loop for
 * its whole duration (`node:sqlite` is synchronous). A reader clicking through
 * the browse rail asks for the same handful of combinations over and over, so
 * each one is computed once per handle — by `warmFacets` at boot where it can,
 * and by the first request that asks otherwise.
 */
function filteredFacets(db: Db, q: FacetsQuery): FacetsResponse {
  let memo = MEMO.get(db as object)
  if (memo === undefined) {
    memo = new Map<string, FacetsResponse>()
    MEMO.set(db as object, memo)
  }
  const key = facetKey(q)
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const computed = computeFacets(db, q)
  if (memo.size >= FACET_MEMO_MAX) memo.clear()
  memo.set(key, computed)
  return computed
}

/**
 * Boot-time pre-warm: pay the 100–230 ms for the rail's own chips BEFORE a
 * reader can ask for them.
 *
 * The combinations a `#/browse` visitor actually reaches with one click are the
 * single-facet ones — one عصر, one بحر, one غرض — **62** of them on the real
 * artefact (12 + 32 + 18). Warmed, every one of those first clicks is a b-tree
 * lookup instead of six GROUP BYs on the request's own event-loop turn.
 *
 * Measured on `data/qarid.db`: the whole sweep is **646 ms**, worst single loop
 * stall **69 ms**. It is much cheaper than the 100–230 ms the route's own note
 * quotes because those three dimensions all ride `poems_filter(era_id,
 * meter_id, theme_id, …)`; the pricey shapes are `?first=` and `?lang=`, which
 * are 28 letters and two values wide and are NOT warmed — the point is to buy
 * the rail's chips, not to precompute the query space.
 *
 * Three properties this must keep, in order of how easy they are to break:
 *
 *  1. **It must not delay listening.** `server/index.ts` fires it and drops the
 *     promise, and the first thing every iteration does is yield — so nothing
 *     is computed until the loop is idle and the socket is already accepting.
 *  2. **It must yield between combinations.** `node:sqlite` is synchronous, so
 *     taken in one turn this would be a 646 ms stall on every other visitor.
 *     One `setImmediate` per combination caps it at a single query — 69 ms
 *     measured, less than one un-warmed request would have cost anyway.
 *  3. **It must never take the process down.** A caller with no corpus never
 *     gets here (`server/index.ts` checks), and anything else that throws is
 *     reported and swallowed: a cold cache is slow, not broken.
 *
 * Returns how many combinations it warmed, which is what the test asserts.
 */
export async function warmFacets(db: Db): Promise<number> {
  const maps = slugMaps(db)
  const combos: FacetsQuery[] = [
    ...[...maps.eraName.values()].map((v) => FacetsQuerySchema.parse({ era: v.slug })),
    ...[...maps.meterName.values()].map((v) => FacetsQuerySchema.parse({ meter: v.slug })),
    ...[...maps.themeName.values()].map((v) => FacetsQuerySchema.parse({ theme: v.slug })),
  ]

  let warmed = 0
  for (const q of combos) {
    await new Promise((resolve) => setImmediate(resolve))
    try {
      filteredFacets(db, trimNoOps(db, q))
      warmed += 1
    } catch (err) {
      console.error(`[qarid] facet pre-warm failed on ${facetKey(q)}: ${err instanceof Error ? err.message : err}`)
      return warmed
    }
  }
  return warmed
}

/** Bounded because the query space is not: 28 letters × 12 عصور × 32 بحور × … */
const FACET_MEMO_MAX = 256

function facetKey(q: FacetsQuery): string {
  return [q.poet, q.era, q.meter, q.theme, q.rhyme, q.first, q.lang, q.minBaits, q.maxBaits, q.fame]
    .map((v) => v ?? "")
    .join("\u0000")
}

/**
 * Drop the filters that filter nothing.
 *
 * `fame`, `minBaits` and `maxBaits` are not dimensions this response reports,
 * and they are the expensive ones: `poems_filter` leads with `era_id`, so none
 * of them has a supporting index and each of the six GROUP BYs re-filters the
 * whole table — measured p50 `?fame=0` 345 ms, `?minBaits=1` 267 ms,
 * `?maxBaits=100000` 239 ms. But at their extreme values they are also
 * tautologies: `poets.fame` is 0..3, every قصيدة in the artefact has at least
 * one بيت (verse-less poems are dropped at ingest), and nothing has more أبيات
 * than the longest قصيدة. Recognising that turns three of the four measured
 * shapes into the cached unfiltered payload — a b-tree lookup — and leaves the
 * honest ones (`?fame=3`, 71 ms) alone.
 */
function trimNoOps(db: Db, q: FacetsQuery): FacetsQuery {
  const out = { ...q }
  if (out.fame !== undefined && out.fame <= 0) out.fame = undefined
  if (out.minBaits !== undefined && out.minBaits <= 1) out.minBaits = undefined
  if (out.maxBaits !== undefined && out.maxBaits >= maxBaitCount(db)) out.maxBaits = undefined
  return out
}

const MAX_BAITS = new WeakMap<object, number>()

/** The longest قصيدة in the artefact — asked once per handle, never changes. */
function maxBaitCount(db: Db): number {
  const cached = MAX_BAITS.get(db as object)
  if (cached !== undefined) return cached
  const row = db.q("SELECT MAX(bait_count) AS n FROM poems").get() as { n: number | null }
  const n = Number(row.n ?? 0)
  MAX_BAITS.set(db as object, n)
  return n
}

function anyFilter(q: FacetsQuery): boolean {
  return (
    q.poet !== undefined ||
    q.era !== undefined ||
    q.meter !== undefined ||
    q.theme !== undefined ||
    q.rhyme !== undefined ||
    q.first !== undefined ||
    q.lang !== undefined ||
    q.minBaits !== undefined ||
    q.maxBaits !== undefined ||
    q.fame !== undefined
  )
}

function computeFacets(db: Db, q: FacetsQuery): FacetsResponse {
  const maps = slugMaps(db)
  const full = poemFilter(db, q)

  const idCounts = (skip: FilterKey, column: "era_id" | "meter_id" | "theme_id") => {
    const filter = poemFilter(db, q, skip)
    const rows = groupBy(db, filter, `p.${column}`)
    return rows
  }

  const eraCounts = idCounts("era", "era_id")
  const meterCounts = idCounts("meter", "meter_id")
  const themeCounts = idCounts("theme", "theme_id")
  const rhymeCounts = groupBy(db, poemFilter(db, q, "rhyme"), "p.rhyme")
  const firstCounts = groupBy(db, poemFilter(db, q, "first"), "p.first_letter")
  const langCounts = groupBy(db, poemFilter(db, q, "lang"), "p.lang_type")

  const slugList = (
    byId: Map<number, { slug: string; name: string; sort: number }>,
    counts: Map<string, number>,
  ): SlugFacet[] =>
    [...byId.entries()].map(([id, info]) => ({
      slug: info.slug,
      name: info.name,
      count: counts.get(String(id)) ?? 0,
    }))

  const letterList = (counts: Map<string, number>): LetterFacet[] =>
    HIJAI_LETTERS.map((letter) => ({ letter: letter as ArabicLetter, count: counts.get(letter) ?? 0 }))

  return {
    total: countPoems(db, full),
    eras: slugList(maps.eraName, eraCounts),
    meters: slugList(maps.meterName, meterCounts),
    themes: slugList(maps.themeName, themeCounts),
    rhymes: letterList(rhymeCounts),
    firstLetters: letterList(firstCounts),
    langTypes: LANG_VALUES.map((value) => ({ value, count: langCounts.get(value) ?? 0 })),
  }
}

function countPoems(db: Db, filter: Filter): number {
  if (filter.impossible) return 0
  const join = filter.needsPoet ? "JOIN poets po ON po.id = p.poet_id" : ""
  const row = db.q(`SELECT COUNT(*) AS n FROM poems p ${join} WHERE ${filter.where}`).get(...filter.params) as {
    n: number
  }
  return Number(row.n)
}

/** `column → count`, NULLs dropped (a facet has no "unset" chip). */
function groupBy(db: Db, filter: Filter, column: string): Map<string, number> {
  const out = new Map<string, number>()
  if (filter.impossible) return out
  const join = filter.needsPoet ? "JOIN poets po ON po.id = p.poet_id" : ""
  const rows = db
    .q(
      `SELECT ${column} AS k, COUNT(*) AS n FROM poems p ${join}
       WHERE ${filter.where} AND ${column} IS NOT NULL GROUP BY 1`,
    )
    .all(...filter.params) as Array<{ k: string | number; n: number }>
  for (const r of rows) out.set(String(r.k), Number(r.n))
  return out
}
