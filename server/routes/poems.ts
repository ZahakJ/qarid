/**
 * `/api/poems` — the corpus browser's spine (design-server.md §7, amendment 9).
 *
 *   GET /api/poems                     filtered, sorted, paginated list
 *   GET /api/poems/:publicId           poem + poet + first page of أبيات
 *   GET /api/poems/:publicId/baits     the rest, offset/limit ≤ 300
 *   GET /api/poems/:publicId/similar   «قصائد على الوزن والقافية»
 *
 * `:publicId` is `String(aldiwan_id)` for the 27% of rows scraped from
 * aldiwan.net and `q<rowid>` for everything else, which is the common case.
 * A malformed one answers 404 rather than 400: it arrives from a hash-router
 * deep link, and a dead link is a missing page, not a client bug.
 */

import { Hono } from "hono"

import {
  LIMITS,
  PoemBaitsQuerySchema,
  PoemsQuerySchema,
  PublicPoemIdSchema,
  SimilarQuerySchema,
  type PoemDetailResponse,
  type PoemSummary,
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
  baitDto,
  poemDetail,
  poemSummary,
  poetSummary,
  type Row,
} from "../dto.ts"
import { decodeParam, listBody, listPoems, notFound, parseQuery, poemFilter } from "../query.ts"

export function poemsRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()

  // ── GET /api/poems ───────────────────────────────────────────────────────
  app.get("/", (c) => {
    const parsed = parseQuery(c, PoemsQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data
    const filter = poemFilter(db, q)
    const { items, total } = listPoems(db, filter, q.sort, q.seed, q.page, q.limit)
    return c.json(listBody(items, total, q.page, q.limit))
  })

  // ── GET /api/poems/:publicId ─────────────────────────────────────────────
  app.get("/:publicId", (c) => {
    const publicId = decodeParam(c.req.param("publicId"))
    if (!PublicPoemIdSchema.safeParse(publicId).success) return notFound(c, "poem")
    const parsed = parseQuery(c, PoemBaitsQuerySchema)
    if (!parsed.ok) return parsed.res
    const { offset, limit } = parsed.data

    const row = db
      .q(`SELECT ${POEM_COLS}, ${POET_EXTRA_COLS} FROM poems p ${POEM_JOINS} WHERE p.public_id = ?`)
      .get(publicId) as Row | undefined
    if (row === undefined) return notFound(c, "poem")

    const poemId = Number(row.p_id)
    const poem = poemDetail(row)
    const body: PoemDetailResponse = {
      poem,
      poet: poetSummary(row),
      baits: readBaits(db, poemId, offset, limit),
      total: poem.baitCount,
      offset,
      limit,
      hasTashkeel: poem.hasTashkeel,
    }
    return c.json(body)
  })

  // ── GET /api/poems/:publicId/baits ───────────────────────────────────────
  app.get("/:publicId/baits", (c) => {
    const publicId = decodeParam(c.req.param("publicId"))
    if (!PublicPoemIdSchema.safeParse(publicId).success) return notFound(c, "poem")
    const parsed = parseQuery(c, PoemBaitsQuerySchema)
    if (!parsed.ok) return parsed.res
    const { offset, limit } = parsed.data

    const head = db.q("SELECT id, bait_count FROM poems WHERE public_id = ?").get(publicId) as
      | { id: number; bait_count: number }
      | undefined
    if (head === undefined) return notFound(c, "poem")

    return c.json({
      items: readBaits(db, Number(head.id), offset, limit),
      total: Number(head.bait_count),
      offset,
      limit,
    })
  })

  // ── GET /api/poems/:publicId/similar (amendment 9) ───────────────────────
  app.get("/:publicId/similar", (c) => {
    const publicId = decodeParam(c.req.param("publicId"))
    if (!PublicPoemIdSchema.safeParse(publicId).success) return notFound(c, "poem")
    const parsed = parseQuery(c, SimilarQuerySchema)
    if (!parsed.ok) return parsed.res
    const limit = Math.min(parsed.data.limit, LIMITS.maxSimilarLimit)

    const seed = db
      .q("SELECT id, poet_id, meter_id, rhyme FROM poems WHERE public_id = ?")
      .get(publicId) as { id: number; poet_id: number; meter_id: number | null; rhyme: string | null } | undefined
    if (seed === undefined) return notFound(c, "poem")

    const items = similarPoems(db, seed, limit)
    return c.json({ items, total: items.length })
  })

  return app
}

/**
 * One page of أبيات, already paired `{sadr, ajuz}` by the ingest — the client
 * never sees a flat hemistich list (design-ux.md §10). `baits_poem_pos` makes
 * this an index range scan even on the 11,608-hemistich قصيدة.
 */
function readBaits(db: Db, poemId: number, offset: number, limit: number): ReturnType<typeof baitDto>[] {
  const rows = db
    .q(
      `SELECT ${BAIT_COLS}, ${BAIT_CONTEXT_COLS}
       FROM baits b ${BAIT_JOINS}
       WHERE b.poem_id = ? ORDER BY b.position ASC LIMIT ? OFFSET ?`,
    )
    .all(poemId, limit, offset) as Row[]
  return rows.map(baitDto)
}

/**
 * amendment 9's two tiers: the same شاعر on the same بحر and قافية first (the
 * strongest signal — these are usually one sitting), then anyone else on that
 * بحر and قافية. Cheap by construction: both tiers are index range scans and
 * neither touches `baits`.
 */
function similarPoems(
  db: Db,
  seed: { id: number; poet_id: number; meter_id: number | null; rhyme: string | null },
  limit: number,
): PoemSummary[] {
  const meterCond = seed.meter_id === null ? "p.meter_id IS NULL" : "p.meter_id = ?"
  const rhymeCond = seed.rhyme === null ? "p.rhyme IS NULL" : "p.rhyme = ?"
  const shape: Array<string | number> = []
  if (seed.meter_id !== null) shape.push(seed.meter_id)
  if (seed.rhyme !== null) shape.push(seed.rhyme)

  const out: PoemSummary[] = []
  const seen = new Set<string>()
  const take = (rows: Row[]) => {
    for (const row of rows) {
      const dto = poemSummary(row)
      if (seen.has(dto.id)) continue
      seen.add(dto.id)
      out.push(dto)
      if (out.length >= limit) break
    }
  }

  take(
    db
      .q(
        `SELECT ${POEM_COLS} FROM poems p ${POEM_JOINS}
         WHERE p.poet_id = ? AND p.id <> ? AND ${meterCond} AND ${rhymeCond}
         ORDER BY p.bait_count DESC, p.id ASC LIMIT ?`,
      )
      .all(seed.poet_id, seed.id, ...shape, limit) as Row[],
  )

  if (out.length < limit) {
    take(
      db
        .q(
          `SELECT ${POEM_COLS} FROM poems p ${POEM_JOINS}
           WHERE p.id <> ? AND p.poet_id <> ? AND ${meterCond} AND ${rhymeCond}
           ORDER BY p.bait_count DESC, p.id ASC LIMIT ?`,
        )
        .all(seed.id, seed.poet_id, ...shape, limit) as Row[],
    )
  }

  return out.slice(0, limit)
}
