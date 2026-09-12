import { serve } from "@hono/node-server"
import { loadConfig } from "./config.ts"
import { openDbIfPresent } from "./db.ts"
import { openUsersDbIfWritable } from "./users.ts"
import { createApp } from "./app.ts"
import { warmAnthologies } from "./routes/anthology.ts"
import { warmBuhur } from "./routes/buhur.ts"
import { warmFacets } from "./routes/facets.ts"

const config = loadConfig()
const db = openDbIfPresent(config.dbPath)
// The ONE writable database (v2.md §4). Null when data/ is read-only or the
// file cannot be created — the ديوان still serves, /api/auth/* answers 503.
const users = openUsersDbIfWritable(config.usersDbPath)
const { app, injectWebSocket } = createApp(config, db, users)

const primary = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[qarid] listening on http://${info.address}:${info.port}`)
})
// v2.md §5 — `/ws/room/:code` lives on the node server's `upgrade` event, not
// on the fetch handler, so every server this process opens has to be handed to
// the adapter or a مساجلة room falls back to polling on that address alone.
injectWebSocket(primary)

// cloudflared resolves "localhost" to ::1 first — bind the IPv6 loopback too,
// or the tunnel 502s. Still loopback-only; nothing external can reach either.
if (config.host === "127.0.0.1") {
  const secondary = serve({ fetch: app.fetch, hostname: "::1", port: config.port }, (info) => {
    console.log(`[qarid] listening on http://[${info.address}]:${info.port}`)
  })
  injectWebSocket(secondary)
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
  // Same reasoning, same shape: المختارات المنظومة resolves 110 curated مطالع
  // against the corpus and the HOME screen asks for the counts on first paint.
  // See `warmAnthologies` for the measured numbers.
  void warmAnthologies(db).catch((err: unknown) => {
    console.error(`[qarid] anthology pre-warm aborted: ${err instanceof Error ? err.message : err}`)
  })
  // And once more for صفحة البحور's sixteen example أبيات: 97 ms in total, 25 ms
  // worst turn, and after it the whole page costs the corpus nothing. Without
  // the warm the first reader of `#/buhur` pays all sixteen queries at once.
  void warmBuhur(db).catch((err: unknown) => {
    console.error(`[qarid] buhur pre-warm aborted: ${err instanceof Error ? err.message : err}`)
  })
}
