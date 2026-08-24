import { serve } from "@hono/node-server"
import { loadConfig } from "./config.ts"
import { openDbIfPresent } from "./db.ts"
import { createApp } from "./app.ts"
import { warmFacets } from "./routes/facets.ts"

const config = loadConfig()
const db = openDbIfPresent(config.dbPath)
const { app } = createApp(config, db)

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[qarid] listening on http://${info.address}:${info.port}`)
})

// cloudflared resolves "localhost" to ::1 first — bind the IPv6 loopback too,
// or the tunnel 502s. Still loopback-only; nothing external can reach either.
if (config.host === "127.0.0.1") {
  serve({ fetch: app.fetch, hostname: "::1", port: config.port }, (info) => {
    console.log(`[qarid] listening on http://[${info.address}]:${info.port}`)
  })
}

/**
 * Fire-and-forget the facet pre-warm — after `serve()`, never before it.
 *
 * A filtered `/api/facets` is six GROUP BYs over the whole قصائد table and it
 * is memoised per handle for the life of the process, which makes the FIRST
 * reader to click any chip on `#/browse` the one who pays — on a synchronous
 * event-loop turn that stalls everyone else. `warmFacets` pays it instead, for
 * the 62 single-facet combinations the rail reaches in one click: 646 ms in
 * total, yielding to the loop between each, so the socket is already accepting
 * and no single turn (69 ms worst) is longer than that first request would
 * have been anyway.
 *
 * It is guarded, not awaited, and it is skipped entirely without a corpus:
 * `openDbIfPresent` returns null on a fresh box and every `/api/*` answers 503,
 * which the pre-warm must not turn into a boot crash.
 */
if (db) {
  void warmFacets(db).catch((err: unknown) => {
    console.error(`[qarid] facet pre-warm aborted: ${err instanceof Error ? err.message : err}`)
  })
}
