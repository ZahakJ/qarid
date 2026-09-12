/**
 * قريض service worker (docs/roadmap-mobile.md §M0). Hand-rolled, no workbox.
 *
 * This file is EXCLUDED from the app's tsconfig (it runs in a worker global,
 * not the DOM) and is bundled on its own by the `qarid:pwa` vite plugin, which
 * inlines `__SW_VERSION__` (the build hash) and `__SW_PRECACHE__` (the shell +
 * fonts + built asset URLs) via esbuild `define`. All routing and versioning
 * decisions live in ./swRoutes.ts, which is unit-tested — this file is the
 * glue that turns a strategy into a cached `Response`.
 */
import { cacheName, routeStrategy, staleCaches } from "./swRoutes.ts"

declare const self: any
declare const __SW_VERSION__: string
declare const __SW_PRECACHE__: string[]

const VERSION = __SW_VERSION__
const PRECACHE = __SW_PRECACHE__
const CACHE = cacheName(VERSION)
const SHELL = "/index.html"
const OFFLINE = "/offline.html"

// Install: fill the versioned cache with the shell, fonts and built assets,
// then take over immediately so the first visit is offline-ready.
self.addEventListener("install", (event: any) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // `reload` bypasses the HTTP cache so the precache is the freshly deployed
      // bytes, never a stale copy the browser happened to hold.
      await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })))
      await self.skipWaiting()
    })(),
  )
})

// Activate: delete every older قريض cache (a clean invalidation on deploy),
// then claim open clients so the new worker controls them without a reload.
self.addEventListener("activate", (event: any) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(staleCaches(names, VERSION).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

const offlineJson = () =>
  new Response(JSON.stringify({ error: "offline" }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

self.addEventListener("fetch", (event: any) => {
  const req: Request = event.request
  const url = new URL(req.url)
  const strategy = routeStrategy({
    sameOrigin: url.origin === self.location.origin,
    method: req.method,
    mode: req.mode,
    pathname: url.pathname,
  })

  // bypass + passthrough: let the browser fetch it, and never cache it. This is
  // how /api/auth and /api/room stay per-cookie and no-store.
  if (strategy === "bypass" || strategy === "passthrough") return

  if (strategy === "network-first") {
    // /api/*: the live corpus wins; offline, favorites still render from
    // localStorage and the failed call gets a 503 the view can handle.
    event.respondWith(fetch(req).catch(() => offlineJson()))
    return
  }

  if (strategy === "navigation") {
    // A page load: prefer the network (so a new deploy's index arrives), fall
    // back to the cached shell, and finally to the offline page.
    event.respondWith(
      fetch(req).catch(async () => {
        const shell = (await caches.match(SHELL)) || (await caches.match("/"))
        return shell || (await caches.match(OFFLINE)) || offlineJson()
      }),
    )
    return
  }

  // cache-first: precached assets, fonts, icons, the manifest. Serve the cache,
  // fall to the network, and cache what the network gives back.
  event.respondWith(
    (async () => {
      const hit = await caches.match(req)
      if (hit) return hit
      try {
        const res = await fetch(req)
        if (res.ok && res.type === "basic") {
          const cache = await caches.open(CACHE)
          void cache.put(req, res.clone())
        }
        return res
      } catch {
        return Response.error()
      }
    })(),
  )
})
