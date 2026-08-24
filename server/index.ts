import { serve } from "@hono/node-server"
import { loadConfig } from "./config.ts"
import { openDbIfPresent } from "./db.ts"
import { createApp } from "./app.ts"

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
