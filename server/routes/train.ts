/**
 * `GET /api/train/candidates` — new drill cards for تحفيظ (design-server.md §7,
 * design-ux.md §5).
 *
 * The pool is `game_baits` at `position ≤ 6` (a مطلع or near it — the أبيات
 * people actually quote) and, by default, `fame = 3` (the شعراء a memoriser
 * should own first). `letter` narrows to أبيات that START on it, which is what
 * the arsenal's «تدرّب» button on a weak حرف needs.
 *
 * Sampling is the same wrap-around `bucket` window every other picker uses, so
 * a `seed` makes the drill deck reproducible and its absence makes it fresh.
 */

import { Hono } from "hono"

import { TrainCandidatesQuerySchema, type BaitDto } from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { BAIT_COLS, BAIT_CONTEXT_COLS, BAIT_JOINS, baitDto, type Row } from "../dto.ts"
import { BUCKET_COUNT, parseQuery, seedBucket, slugMaps } from "../query.ts"

/** design-server.md §7: fame 3, position ≤ 6. */
const MAX_POSITION = 6

export function trainRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()

  app.get("/candidates", (c) => {
    const parsed = parseQuery(c, TrainCandidatesQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data

    const maps = slugMaps(db)
    const where: string[] = ["gb.position <= ?"]
    const params: Array<string | number> = [MAX_POSITION]
    let impossible = false

    if (q.famous) {
      where.push("gb.fame = 3")
    }
    if (q.letter !== undefined) {
      where.push("gb.first_letter = ?")
      params.push(q.letter)
    }
    if (q.meter !== undefined) {
      const id = maps.meter.get(q.meter)
      if (id === undefined) impossible = true
      else {
        where.push("gb.meter_id = ?")
        params.push(id)
      }
    }
    if (q.era !== undefined) {
      const id = maps.era.get(q.era)
      if (id === undefined) impossible = true
      else {
        where.push("gb.era_id = ?")
        params.push(id)
      }
    }
    if (impossible) return c.json({ items: [], total: 0 })

    const cond = where.join(" AND ")
    const total = Number(
      (db.q(`SELECT COUNT(*) AS n FROM game_baits gb WHERE ${cond}`).get(...params) as { n: number }).n,
    )
    if (total === 0) return c.json({ items: [], total: 0 })

    const start = seedBucket(q.seed) % BUCKET_COUNT
    // The sort runs over `game_baits` ALONE and only the ≤10 survivors are
    // joined out — the house rule every other route follows (CLAUDE.md). Sorting
    // the joined rows instead made SQLite materialise the whole fame-3 slice
    // (208,180 أبيات × four joins) before the LIMIT could bite: p50 153 ms,
    // against 10 ms for the same answer.
    const page = (op: ">=" | "<", take: number): Row[] =>
      db
        .q(
          `SELECT ${BAIT_COLS}, ${BAIT_CONTEXT_COLS}
           FROM (SELECT gb.bait_id AS bid, gb.bucket AS bk, gb.rand AS rd
                 FROM game_baits gb
                 WHERE ${cond} AND gb.bucket ${op} ?
                 ORDER BY gb.bucket ASC, gb.rand ASC, gb.bait_id ASC LIMIT ?) sel
           JOIN baits b ON b.id = sel.bid
           ${BAIT_JOINS}
           ORDER BY sel.bk ASC, sel.rd ASC, sel.bid ASC`,
        )
        .all(...params, start, take) as Row[]

    const rows = page(">=", q.limit)
    if (rows.length < q.limit) rows.push(...page("<", q.limit - rows.length))

    const items: BaitDto[] = rows.map(baitDto)
    return c.json({ items, total })
  })

  return app
}
