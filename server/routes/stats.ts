/**
 * `GET /api/stats` — the StatsView's histograms (design-server.md §7).
 *
 * Precomputed at ingest into `meta.stats_json`: era/بحر tallies, the قافية and
 * first-letter distributions, the poem-length histogram and the top 20 شعراء.
 * Computing any of it live would mean a full scan of 254,630 poems per page
 * view, and the numbers cannot change between builds anyway.
 */

import { Hono } from "hono"

import { StatsResponseSchema, type StatsResponse } from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { metaJson } from "./meta.ts"

export function statsRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()
  let cached: StatsResponse | null = null

  app.get("/", (c) => {
    if (cached === null) {
      const parsed = StatsResponseSchema.safeParse(metaJson(db, "stats_json"))
      if (!parsed.success) {
        return c.json({ error: "stats_unavailable", message: "stats_json missing or unreadable" }, 500)
      }
      cached = parsed.data
    }
    return c.json(cached)
  })

  return app
}
