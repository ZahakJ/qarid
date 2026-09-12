/**
 * `/api/search` — GET, the one search endpoint (design-server.md §7).
 *
 * The route is deliberately thin: it parses, times, and shapes. Everything that
 * touches FTS5 — the bounded `hits` CTE, bm25 ranking, the AND→OR fallback and
 * the `»…«` snippet — lives in `server/search.ts` so `runSearch()` can be
 * called from a test (and, later, from the omnibox's own handler) without a
 * request object.
 *
 * `scope` decides which of the three lists are populated: `all` fills all three
 * (that is exactly the omnibox's three groups — call it with `limit=4`), and a
 * single scope fills only its own. `page`/`limit` apply to each populated list
 * independently and `total` is the sum of their counts, so a single-scope
 * search reports precisely its own list's total.
 */

import { Hono } from "hono"

import { SearchQuerySchema, type SearchResponse } from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { parseQuery } from "../query.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import { runSearch } from "../search.ts"

/**
 * The one bucket on a read route, and it is here because v2 gave this route
 * the prefix operator.
 *
 * `STAR_TERM_CAP` is what actually bounds a query's cost (shared/arabic.ts):
 * twelve legal starred four-letter words measured **594 ms** before the cap and
 * 126 ms after it, on the real corpus, from an anonymous GET. This is the
 * second bound rather than the first — sixty per ten seconds is an order of
 * magnitude above the palette's 200 ms debounce and the reader who pages
 * through results, and it keeps four scripted clients from owning the one event
 * loop indefinitely (CLAUDE.md: every SQLite call is synchronous on it).
 */
export const SEARCH_RATE_LIMIT = { tokens: 60, windowMs: 10_000 } as const

export function searchRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()
  app.use("*", createRateLimiter({ ...SEARCH_RATE_LIMIT, keyOf: clientKey }).middleware)

  app.get("/", (c) => {
    const parsed = parseQuery(c, SearchQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data

    const started = performance.now()
    const result = runSearch(db, q)
    const body: SearchResponse = {
      q: q.q,
      scope: q.scope,
      mode: result.mode,
      baits: result.baits,
      poems: result.poems,
      poets: result.poets,
      total: result.total,
      page: q.page,
      limit: q.limit,
      // µs resolution, and never negative even if the clock is coarse
      ms: Math.max(0, Math.round((performance.now() - started) * 1000) / 1000),
    }
    return c.json(body)
  })

  return app
}
