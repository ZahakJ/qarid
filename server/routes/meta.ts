/**
 * `GET /api/meta` — the one call the client makes before anything else
 * (design-server.md §7, amendment 10).
 *
 * Nothing here is computed: `build.ts` wrote `meta.meta_json` at ingest with
 * the counts, the 16 بحور, the 12 عصور, the 18 أغراض and the 28-letter
 * supply/demand table already shaped exactly like `MetaResponseSchema`. The
 * route reads one row, parses it once per process and hands out the frozen
 * object forever after — the artefact is immutable, so a second parse would be
 * pure waste on a payload the home screen asks for on every cold load.
 */

import { Hono } from "hono"

import { MetaResponseSchema, type MetaResponse } from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"

/** Read one `meta` row as JSON. Returns null when the key is absent. */
export function metaJson(db: Db, key: string): unknown {
  const row = db.q("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
  if (row === undefined || row.value === "") return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

export function metaRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()
  let cached: MetaResponse | null = null

  app.get("/", (c) => {
    if (cached === null) {
      const parsed = MetaResponseSchema.safeParse(metaJson(db, "meta_json"))
      if (!parsed.success) {
        // The artefact is malformed — `build.ts` asserts this key exists, so
        // reaching here means the file was truncated or built by an older
        // schema version. Say so instead of shipping a half-empty payload.
        return c.json({ error: "meta_unavailable", message: "meta_json missing or unreadable" }, 500)
      }
      cached = parsed.data
    }
    return c.json(cached)
  })

  return app
}
