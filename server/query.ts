/**
 * `server/query.ts` — request parsing, slug→id lookups and the one filter
 * builder every list route shares (design-server.md §7).
 *
 * Two decisions worth knowing before you use it:
 *
 *  • An UNKNOWN slug is not an error. `SlugSchema` already proved the shape;
 *    `era=nope` is a filter that matches nothing, so the route answers
 *    `{items: [], total: 0}` rather than 400. A 400 is reserved for input the
 *    client could not legally have produced (`sort=bogus`), which is a bug
 *    worth surfacing. That is what `impossible` on a `Filter` means.
 *  • Every SQL string handed to `db.q()` is a CONSTANT-SHAPED template: values
 *    only ever arrive as bound parameters, so the prepared-statement cache in
 *    `db.ts` stays bounded by the number of filter *shapes* (a few dozen), not
 *    by the number of filter *values*.
 */

import type { Context } from "hono"
import { z } from "zod"

import { fnv1a32 } from "../shared/arabic.ts"
import { toErrorBody } from "../shared/schema.ts"
import type { Db } from "./db.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response }

/**
 * Parse a query string through a schema, or answer `400 {error, issues}`.
 * Numbers and booleans are clamped by the schema and never fail; only an
 * illegal enum value gets here.
 */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): Parsed<z.infer<S>> {
  const result = schema.safeParse(c.req.query())
  if (!result.success) return { ok: false, res: c.json(toErrorBody(result.error, "bad_query"), 400) }
  return { ok: true, data: result.data as z.infer<S> }
}

/** Parse a single path param (already percent-decoded) or answer 400. */
export function parseParam<S extends z.ZodType>(c: Context, schema: S, value: string): Parsed<z.infer<S>> {
  const result = schema.safeParse(value)
  if (!result.success) return { ok: false, res: c.json(toErrorBody(result.error, "bad_param"), 400) }
  return { ok: true, data: result.data as z.infer<S> }
}

/**
 * Path params arrive percent-encoded whenever the slug is Arabic — and 73% of
 * poet slugs are (CLAUDE.md spike finding 2). Hono decodes for us; this is the
 * belt-and-braces pass for a client that double-encoded, and it never throws on
 * a malformed sequence.
 */
export function decodeParam(raw: string | undefined): string {
  if (!raw) return ""
  if (!raw.includes("%")) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function notFound(c: Context, what: string): Response {
  return c.json({ error: "not_found", message: what }, 404)
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookups (the artefact is immutable, so every one of these is memoised)
// ─────────────────────────────────────────────────────────────────────────────

type SlugMaps = {
  era: Map<string, number>
  meter: Map<string, number>
  theme: Map<string, number>
  eraName: Map<number, { slug: string; name: string; sort: number }>
  meterName: Map<number, { slug: string; name: string; sort: number }>
  themeName: Map<number, { slug: string; name: string; sort: number }>
}

const MAPS = new WeakMap<object, SlugMaps>()

/** slug↔id for the three lookup tables, read once per database handle. */
export function slugMaps(db: Db): SlugMaps {
  const cached = MAPS.get(db as object)
  if (cached) return cached
  const load = (table: string) => {
    const rows = db.q(`SELECT id, slug, name, sort FROM ${table} ORDER BY sort, id`).all() as Array<
      Record<string, unknown>
    >
    const bySlug = new Map<string, number>()
    const byId = new Map<number, { slug: string; name: string; sort: number }>()
    for (const r of rows) {
      const id = Number(r.id)
      const slug = String(r.slug)
      bySlug.set(slug, id)
      byId.set(id, { slug, name: String(r.name), sort: Number(r.sort) })
    }
    return { bySlug, byId }
  }
  const eras = load("eras")
  const meters = load("meters")
  const themes = load("themes")
  const maps: SlugMaps = {
    era: eras.bySlug,
    meter: meters.bySlug,
    theme: themes.bySlug,
    eraName: eras.byId,
    meterName: meters.byId,
    themeName: themes.byId,
  }
  MAPS.set(db as object, maps)
  return maps
}

/** poets.id for a slug, or null. One prepared statement, unique index hit. */
export function poetIdBySlug(db: Db, slug: string): number | null {
  const row = db.q("SELECT id FROM poets WHERE slug = ?").get(slug) as { id: number } | undefined
  return row === undefined ? null : Number(row.id)
}

/** poems.id for a public id (`16182` or `q1234`), or null. */
export function poemIdByPublicId(db: Db, publicId: string): number | null {
  const row = db.q("SELECT id FROM poems WHERE public_id = ?").get(publicId) as { id: number } | undefined
  return row === undefined ? null : Number(row.id)
}

// ─────────────────────────────────────────────────────────────────────────────
// The poem filter
// ─────────────────────────────────────────────────────────────────────────────

export interface PoemFilterInput {
  poet?: string
  era?: string
  meter?: string
  theme?: string
  rhyme?: string
  first?: string
  lang?: string
  minBaits?: number
  maxBaits?: number
  fame?: number
}

export interface Filter {
  /** `WHERE …` body, always non-empty (`1 = 1` when nothing is set). */
  where: string
  params: Array<string | number>
  /** a slug named nothing in the artefact — the result set is provably empty */
  impossible: boolean
  /** `fame` was set, so the caller must join `poets po` */
  needsPoet: boolean
}

export type FilterKey = keyof PoemFilterInput

/**
 * Build the shared `WHERE` for /api/poems, /api/facets and the poet diwan.
 * `skip` drops one dimension — that is how /api/facets counts the OTHER values
 * of the facet you are standing on instead of returning 27 zeros.
 */
export function poemFilter(db: Db, q: PoemFilterInput, skip?: FilterKey): Filter {
  const maps = slugMaps(db)
  const where: string[] = []
  const params: Array<string | number> = []
  let impossible = false
  let needsPoet = false
  const on = (key: FilterKey) => skip !== key

  const lookup = (map: Map<string, number>, slug: string, column: string) => {
    const id = map.get(slug)
    if (id === undefined) {
      impossible = true
      return
    }
    where.push(`${column} = ?`)
    params.push(id)
  }

  if (q.poet !== undefined && on("poet")) {
    const id = poetIdBySlug(db, q.poet)
    if (id === null) impossible = true
    else {
      where.push("p.poet_id = ?")
      params.push(id)
    }
  }
  if (q.era !== undefined && on("era")) lookup(maps.era, q.era, "p.era_id")
  if (q.meter !== undefined && on("meter")) lookup(maps.meter, q.meter, "p.meter_id")
  if (q.theme !== undefined && on("theme")) lookup(maps.theme, q.theme, "p.theme_id")
  if (q.rhyme !== undefined && on("rhyme")) {
    where.push("p.rhyme = ?")
    params.push(q.rhyme)
  }
  if (q.first !== undefined && on("first")) {
    where.push("p.first_letter = ?")
    params.push(q.first)
  }
  if (q.lang !== undefined && on("lang")) {
    where.push("p.lang_type = ?")
    params.push(q.lang)
  }
  if (q.minBaits !== undefined && on("minBaits")) {
    where.push("p.bait_count >= ?")
    params.push(q.minBaits)
  }
  if (q.maxBaits !== undefined && on("maxBaits")) {
    where.push("p.bait_count <= ?")
    params.push(q.maxBaits)
  }
  if (q.fame !== undefined && on("fame")) {
    where.push("po.fame >= ?")
    params.push(q.fame)
    needsPoet = true
  }

  return { where: where.length === 0 ? "1 = 1" : where.join(" AND "), params, impossible, needsPoet }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sampling
// ─────────────────────────────────────────────────────────────────────────────

/** `BUCKETS` from shared/constants.ts, restated as the modulus of the window. */
export const BUCKET_COUNT = 1000

/**
 * A deterministic bucket for a seed, or a genuinely random one when no seed was
 * given. Never `ORDER BY RANDOM()` — see CLAUDE.md; on 2M+ rows that sorts 2M+
 * rows, whereas the bucket column turns the same job into an index range scan.
 */
export function seedBucket(seed: string | undefined): number {
  if (seed === undefined) return Math.floor(Math.random() * BUCKET_COUNT) % BUCKET_COUNT
  return fnv1a32(seed) % BUCKET_COUNT
}

/** A stable 31-bit number from a seed — for scatter-ordering and index picks. */
export function seedNumber(seed: string | undefined): number {
  if (seed === undefined) return (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) & 0x7fffffff
  return fnv1a32(seed) & 0x7fffffff
}

/** `{items, total, page, limit}` — the envelope every list route returns. */
export function listBody<T>(items: T[], total: number, page: number, limit: number) {
  return { items, total, page, limit }
}

/** OFFSET for a 1-based page. */
export function offsetOf(page: number, limit: number): number {
  return (page - 1) * limit
}

// ─────────────────────────────────────────────────────────────────────────────
// The poem list — shared by /api/poems, /api/poets/:slug and .../poems
// ─────────────────────────────────────────────────────────────────────────────

import { POEM_COLS, POEM_JOINS, poemSummary, type Row } from "./dto.ts"
import type { PoemsSort, PoemSummary } from "../shared/schema.ts"

/**
 * ORDER BY for each documented sort. `random` deserves a note: `poems` has no
 * persisted `bucket` column (only `game_baits` does — §5), so a seeded
 * multiply-shift over the primary key stands in for one. It is deterministic
 * for a given seed, therefore stable across pagination the way design-ux.md §3
 * requires, and it scatters ids that ingest order had grouped by poet.
 */
function orderFor(sort: PoemsSort, seed: string | undefined): { sql: string; params: number[] } {
  switch (sort) {
    case "title":
      return { sql: "p.title_key ASC, p.id ASC", params: [] }
    case "length":
      return { sql: "p.bait_count DESC, p.id ASC", params: [] }
    case "poet":
      return { sql: "po.sort_key ASC, p.id ASC", params: [] }
    case "random":
      // A seeded multiply-mod-prime over the primary key: every seed is a
      // different permutation (adding the seed instead of multiplying by it
      // would only ROTATE one fixed order, which is not what «عشوائي» means).
      return { sql: "((p.id * ?) % 1048573) ASC, p.id ASC", params: [seedNumber(seed) | 1] }
    case "fame":
    default:
      return { sql: "po.fame DESC, p.bait_count DESC, p.id ASC", params: [] }
  }
}

/** `poet`/`fame` sorts and the fame filter are the only reasons to join poets. */
function needsPoetJoin(filter: Filter, sort: PoemsSort): boolean {
  return filter.needsPoet || sort === "poet" || sort === "fame"
}

export interface PoemListPage {
  items: PoemSummary[]
  total: number
}

/**
 * One page of `PoemSummary`, plus the unpaginated total.
 *
 * The sort runs inside a narrow subquery that selects `p.id` and nothing else;
 * only the ≤100 surviving ids are then joined out to poets/meters/themes/eras.
 * On the full corpus that is the difference between sorting 254,630 wide joined
 * rows and sorting 254,630 integers. `baits` is never touched (§7).
 */
export function listPoems(
  db: Db,
  filter: Filter,
  sort: PoemsSort,
  seed: string | undefined,
  page: number,
  limit: number,
): PoemListPage {
  if (filter.impossible) return { items: [], total: 0 }

  const join = needsPoetJoin(filter, sort) ? "JOIN poets po ON po.id = p.poet_id" : ""
  const total = Number(
    (db.q(`SELECT COUNT(*) AS n FROM poems p ${join} WHERE ${filter.where}`).get(...filter.params) as { n: number })
      .n,
  )
  if (total === 0) return { items: [], total: 0 }

  const order = orderFor(sort, seed)
  const rows = db
    .q(
      `SELECT ${POEM_COLS}
       FROM (SELECT p.id AS pid FROM poems p ${join} WHERE ${filter.where}
             ORDER BY ${order.sql} LIMIT ? OFFSET ?) sel
       JOIN poems p ON p.id = sel.pid
       ${POEM_JOINS}
       ORDER BY ${order.sql}`,
    )
    .all(...filter.params, ...order.params, limit, offsetOf(page, limit), ...order.params) as Row[]

  return { items: rows.map(poemSummary), total }
}
