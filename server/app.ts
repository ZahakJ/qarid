import { Hono } from "hono"
import { compress } from "hono/compress"
import { serveStatic } from "@hono/node-server/serve-static"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.ts"
import type { Db } from "./db.ts"

// createApp is listen-free so tests can drive app.request() directly.
// `db` is null when the corpus has not been built — /healthz and the static
// client still work, every /api route answers 503.
export function createApp(config: Config, db: Db | null): { app: Hono } {
  const app = new Hono()

  // security headers on every response
  app.use("*", async (c, next) => {
    await next()
    const h = c.res.headers
    h.set("X-Content-Type-Options", "nosniff")
    h.set("Referrer-Policy", "strict-origin-when-cross-origin")
    h.set("Cross-Origin-Opener-Policy", "same-origin")
    const type = h.get("content-type") ?? ""
    if (type.includes("text/html")) {
      h.set(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "base-uri 'none'",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "img-src 'self' data: blob:",
          // vite inlines small font subsets as data: URIs — the smoke test
          // fails on a CSP violation without this
          "font-src 'self' data:",
          "style-src 'self' 'unsafe-inline'",
          "script-src 'self'",
          "connect-src 'self'",
        ].join("; "),
      )
    }
  })

  app.get("/healthz", (c) => c.text("ok"))

  app.use("/api/*", compress())

  // Every /api route needs the corpus; answer honestly when it is absent.
  app.use("/api/*", async (c, next) => {
    if (!db) return c.json({ error: "corpus_unavailable" }, 503)
    await next()
  })

  // ---------------------------------------------------------------------
  // ROUTE MOUNT POINTS — later agents add server/routes/<name>.ts, each
  // exporting a factory `(<name>Routes(db, config)) => Hono` and mount it
  // here. Keep this block the single place routes are wired.
  //
  //   app.route("/api/meta",   metaRoutes(db!, config))    // routes/meta.ts
  //   app.route("/api/poets",  poetsRoutes(db!, config))   // routes/poets.ts
  //   app.route("/api/poems",  poemsRoutes(db!, config))   // routes/poems.ts
  //   app.route("/api/baits",  baitsRoutes(db!, config))   // routes/baits.ts
  //   app.route("/api/facets", facetsRoutes(db!, config))  // routes/facets.ts
  //   app.route("/api/search", searchRoutes(db!, config))  // routes/search.ts
  //   app.route("/api/game",   gameRoutes(db!, config))    // routes/game.ts
  //   app.route("/api/stats",  statsRoutes(db!, config))   // routes/stats.ts
  //   app.route("/api/train",  trainRoutes(db!, config))   // routes/train.ts
  // ---------------------------------------------------------------------

  // client bundle — hashed assets immutable, index no-cache (hash-routed SPA)
  const distDir = path.join(import.meta.dirname, "..", "dist")
  if (fs.existsSync(path.join(distDir, "index.html"))) {
    const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8")
    app.use("/assets/*", async (c, next) => {
      await next()
      if (c.res.ok) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable")
    })
    app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), distDir) }))
    app.get("/", (c) => {
      c.header("Cache-Control", "no-cache")
      return c.html(indexHtml)
    })
    app.notFound((c) => {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404)
      c.header("Cache-Control", "no-cache")
      return c.html(indexHtml, 200)
    })
  } else {
    app.get("/", (c) => c.text("qarid server up — client dist not built (dev mode uses vite)", 200))
  }

  return { app }
}
