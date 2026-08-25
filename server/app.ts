import { Hono } from "hono"
import { compress } from "hono/compress"
import { serveStatic } from "@hono/node-server/serve-static"
import { createNodeWebSocket } from "@hono/node-ws"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.ts"
import type { Db } from "./db.ts"
import type { UsersDb } from "./users.ts"
import { originGuard } from "./origin.ts"
import { authRoutes } from "./routes/auth.ts"
import { baitsRoutes } from "./routes/baits.ts"
import { facetsRoutes } from "./routes/facets.ts"
import { gameRoutes } from "./routes/game.ts"
import { metaRoutes } from "./routes/meta.ts"
import { poemsRoutes } from "./routes/poems.ts"
import { poetsRoutes } from "./routes/poets.ts"
import { profileRoutes } from "./routes/profile.ts"
import { mountRoomSocket, roomDeps, roomRoutes } from "./routes/rooms.ts"
import { searchRoutes } from "./routes/search.ts"
import { statsRoutes } from "./routes/stats.ts"
import { trainRoutes } from "./routes/train.ts"

/** What `serve()` hands back — the two node servers `index.ts` opens. */
type UpgradableServer = Parameters<ReturnType<typeof createNodeWebSocket>["injectWebSocket"]>[0]

// createApp is listen-free so tests can drive app.request() directly.
// `db` is null when the corpus has not been built — /healthz and the static
// client still work, every /api route answers 503.
//
// `injectWebSocket` is the second half of v2.md §5: the WebSocket lives on the
// node http server, not on the fetch handler, so a caller that binds a socket
// (server/index.ts) must hand each server it opens to this. A caller that does
// NOT — every test that drives `app.request()` — simply never calls it, and
// `/ws/room/:code` then answers like any un-upgraded GET.
export function createApp(
  config: Config,
  db: Db | null,
  users: UsersDb | null = null,
): { app: Hono; injectWebSocket: (server: UpgradableServer) => void } {
  const app = new Hono()
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app })

  // security headers on every response
  app.use("*", async (c, next) => {
    await next()
    const h = c.res.headers
    h.set("X-Content-Type-Options", "nosniff")
    h.set("Referrer-Policy", "strict-origin-when-cross-origin")
    h.set("Cross-Origin-Opener-Policy", "same-origin")

    /**
     * Cache-Control on `/api/*`, which had none at all — so Cloudflare cached
     * nothing and every reload re-derived everything.
     *
     * The database is a build artefact (CLAUDE.md invariant): `/api/meta`,
     * `/api/stats` and `/api/facets` are pure functions of it and cannot change
     * until it is rebuilt, so they get an hour with a day of
     * stale-while-revalidate. Every other read gets a minute — enough to absorb
     * a reload and a back-button, short enough that nothing feels stuck. The
     * two that must never be cached say so: `/api/baits/random` is a different
     * بيت every call, and the duel is a POST conversation.
     *
     * It lives HERE, in the outermost middleware, and not in an `/api/*` one of
     * its own — that is not a style choice. `@hono/node-server` swaps in a lazy
     * `Response` whose headers live in a side cache, and hono's `c.header()`
     * rebuilds that response from its ORIGINAL init (context.ts:213). So when
     * `compress()` sets `Vary: Accept-Encoding` on the way out, every header an
     * INNER middleware wrote directly onto `c.res.headers` is silently dropped.
     * The last middleware to touch the headers is the only one that can be sure
     * they ship, and that is this one.
     */
    if (c.req.path.startsWith("/api/") && c.res.ok && !h.has("Cache-Control")) {
      h.set("Cache-Control", cachePolicy(c.req.path, c.req.method))
    }
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

  /**
   * Cross-origin request forgery, closed at the door (server/origin.ts).
   *
   * It sits ABOVE every route and below the header middleware: a POST from a
   * sibling `*.avicenna.space` page is *same-site*, so `SameSite=Lax` sends the
   * session cookie with it, and nothing else in this server asked where the
   * request came from. `/healthz` is a GET and unaffected.
   */
  app.use("*", originGuard(config))

  app.get("/healthz", (c) => c.text("ok"))

  /**
   * Compression, everywhere — not just `/api/*`.
   *
   * The client bundle is the biggest thing this server sends and it was going
   * out raw: a cold `#/` was 11 requests and 727 KB, of which index-*.js is
   * 453,382 B (135,539 B gzipped) and index-*.css 67,026 B (11,713 B) — ~373 KB
   * of avoidable transfer per first load. Cloudflare would compress it at the
   * edge for the public hostname, but not the origin→edge hop, not
   * `npm run preview` and not a direct hit on 8010.
   *
   * hono's `compress()` already skips what must not be touched: HEAD, an
   * existing `Content-Encoding`, `206`, bodies under 1 KB, `no-transform`, and
   * anything outside its compressible-content-type list — so the 223 KB of
   * woff2 (already compressed) is correctly left alone.
   */
  app.use("*", compress())

  /**
   * `HEAD` never reaches `compress()` (it returns early), and nothing else sets
   * a length on a streamed JSON body, so `curl -I` on any /api route came back
   * 200 with neither `content-length` nor `content-encoding` — unusable for a
   * monitor that probes size. The body is drained here and its byte count
   * reported, which is exactly what HEAD promises: the GET headers, no body.
   */
  app.use("*", async (c, next) => {
    await next()
    // The method test comes FIRST and nothing above it may touch `c.res.body`:
    // @hono/node-server hands back a lazy Response whose headers live in a
    // side cache until someone reads the body, and reading it rebuilds the
    // response from its ORIGINAL init — silently dropping every header an inner
    // middleware set (this ate the Cache-Control below for a while). Headers
    // are snapshotted before the body is drained for the same reason.
    if (c.req.method !== "HEAD") return
    const status = c.res.status
    const headers = new Headers(c.res.headers)
    if (headers.has("content-length")) return
    const body = await c.res.arrayBuffer()
    headers.set("Content-Length", String(body.byteLength))
    c.res = new Response(null, { status, headers })
  })

  // Every /api route needs the corpus; answer honestly when it is absent.
  // Except the two that do not touch it: accounts live in their own writable
  // database (server/users.ts), so a box with no corpus can still say who you
  // are — and a box with no writable users db still serves the whole ديوان.
  app.use("/api/*", async (c, next) => {
    if (!db && !CORPUS_FREE.some((prefix) => c.req.path.startsWith(prefix))) {
      return c.json({ error: "corpus_unavailable" }, 503)
    }
    await next()
  })

  // Accounts + profiles (v2.md §4). Mounted whether or not `users` opened: the
  // sub-apps answer 503 themselves, which is what keeps a read-only data/ a log
  // line rather than a crash loop.
  app.route("/api/auth", authRoutes(users, config))
  app.route("/api/profile", profileRoutes(users, config))

  // ---------------------------------------------------------------------
  // ROUTE MOUNT POINTS — every sub-app lives in server/routes/<name>.ts and
  // exports a factory `(db, config) => Hono`. Keep this block the single
  // place routes are wired.
  //
  // The `db!` is safe: the middleware above already answered 503 for a null
  // handle, and no factory touches SQLite at construction time (lookup maps
  // and the meta payload are memoised on first request, not on mount).
  // ---------------------------------------------------------------------
  if (db) {
    app.route("/api/meta", metaRoutes(db, config))
    app.route("/api/poets", poetsRoutes(db, config))
    app.route("/api/poems", poemsRoutes(db, config))
    app.route("/api/baits", baitsRoutes(db, config))
    app.route("/api/facets", facetsRoutes(db, config))
    app.route("/api/search", searchRoutes(db, config))
    app.route("/api/game", gameRoutes(db, config))
    app.route("/api/stats", statsRoutes(db, config))
    app.route("/api/train", trainRoutes(db, config))

    // مساجلة rooms (v2.md §5). They need BOTH databases — the corpus for the
    // verify pipeline, the writable one for the room itself — so they are the
    // one feature that is mounted only when both are open. The socket is
    // registered on the root app because `/ws/room/:code` is not an `/api`
    // path: it is an upgrade, and the corpus gate above would answer it with
    // JSON no browser would read.
    if (users) {
      const rooms = roomDeps(db, users, config)
      app.route("/api/room", roomRoutes(rooms))
      mountRoomSocket(app, rooms, upgradeWebSocket)
    }
  }

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

    /**
     * PWA files served from the scope ROOT (docs/roadmap-mobile.md §M0).
     *
     * They must sit at `/…`, not under `/assets/`, because a service worker's
     * scope is its own directory: `/sw.js` controls the whole app, `/assets/sw.js`
     * could not. Each is read once at boot like index.html, so a deploy needs
     * the same restart the bundle already needs.
     *
     * Two header rules matter. `sw.js` is `no-cache` (`must-revalidate`): the
     * worker file itself must never be pinned, or a deploy's new worker is never
     * discovered — the worker's OWN versioned cache is what makes assets fast,
     * not an HTTP cache on the script. And `Service-Worker-Allowed: /` lets the
     * worker claim the root scope even though the script is fetched from it (a
     * belt-and-braces header; the scope is already root here). The icons and
     * manifest are not content-hashed, so they get a short cache, not the
     * year-long `immutable` the hashed `/assets/*` get.
     */
    const serveRootFile = (
      url: string,
      file: string,
      type: string,
      cache: string,
      extra?: Record<string, string>,
    ) => {
      const p = path.join(distDir, file)
      if (!fs.existsSync(p)) return
      const body = fs.readFileSync(p)
      app.get(url, (c) => {
        c.header("Content-Type", type)
        c.header("Cache-Control", cache)
        for (const [k, v] of Object.entries(extra ?? {})) c.header(k, v)
        return c.body(body)
      })
    }

    serveRootFile("/sw.js", "sw.js", "text/javascript; charset=utf-8", "no-cache, must-revalidate", {
      "Service-Worker-Allowed": "/",
    })
    serveRootFile(
      "/manifest.webmanifest",
      "manifest.webmanifest",
      "application/manifest+json; charset=utf-8",
      "public, max-age=3600",
    )
    serveRootFile("/offline.html", "offline.html", "text/html; charset=utf-8", "public, max-age=300")
    for (const icon of ["icon-192.png", "icon-512.png", "icon-192-maskable.png", "icon-512-maskable.png"]) {
      serveRootFile(`/icons/${icon}`, path.join("icons", icon), "image/png", "public, max-age=86400")
    }

    app.notFound((c) => {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404)
      // A missing `/assets/<hash>` is a 404, NOT the SPA shell. Serving
      // index.html at 200 under a hashed asset URL is how a tab still holding a
      // pre-deploy index.html gets HTML where it asked for a module — blank
      // page, `Failed to load module script`, because `nosniff` is set — and
      // the `/assets/*` middleware above would then stamp that HTML
      // `immutable, max-age=31536000` in the browser and at the edge, for a
      // year, under the JS URL. (`c.res.ok` is false here, so the header is not
      // set either way; both halves of the trap are closed.)
      if (c.req.path.startsWith("/assets/")) return c.json({ error: "not_found" }, 404)
      c.header("Cache-Control", "no-cache")
      return c.html(indexHtml, 200)
    })
  } else {
    app.get("/", (c) => c.text("qarid server up — client dist not built (dev mode uses vite)", 200))
  }

  return { app, injectWebSocket }
}

/** The `/api` prefixes that answer without the corpus artefact (v2.md §4). */
const CORPUS_FREE = ["/api/auth/", "/api/profile/"] as const

/** How long one `/api` response may be reused. See the middleware above. */
function cachePolicy(path: string, method: string): string {
  if (method !== "GET" && method !== "HEAD") return "no-store"
  // Who is signed in is per-reader and per-cookie: a shared cache holding
  // /api/auth/me for a minute would hand one player another player's masthead.
  if (path.startsWith("/api/auth/") || path.startsWith("/api/profile/")) return "private, no-store"
  // A مساجلة room (v2.md §5) is the most per-reader, most live thing this
  // server has: `you.canPlay` is in the payload and the deadline moves every
  // turn. Sixty seconds of shared cache on `GET /api/room/:code/state` would
  // hand one player the other player's screen, a minute late.
  if (path.startsWith("/api/room")) return "private, no-store"
  if (path.startsWith("/api/game/")) return path === "/api/game/pool" ? "public, max-age=3600" : "no-store"
  if (path === "/api/baits/random") return "no-store"
  if (path === "/api/meta" || path === "/api/stats" || path === "/api/facets") {
    return "public, max-age=3600, stale-while-revalidate=86400"
  }
  return "public, max-age=60"
}
