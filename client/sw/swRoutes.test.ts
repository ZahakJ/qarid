/**
 * The service worker's routing + cache-versioning logic (client/sw/swRoutes.ts).
 * This is the code the deployed worker (client/sw/sw.ts) actually calls, so a
 * regression here is a regression in production.
 */
import { describe, expect, it } from "vitest"
import {
  CACHE_PREFIX,
  cacheName,
  isNoStore,
  precacheVersion,
  routeStrategy,
  staleCaches,
} from "./swRoutes.ts"
import { shouldRegisterServiceWorker } from "./register.ts"

const ORIGIN = { sameOrigin: true, method: "GET", mode: "cors", pathname: "/" }

describe("routeStrategy", () => {
  it("bypasses every non-GET, same-origin or not", () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "PATCH"]) {
      expect(routeStrategy({ ...ORIGIN, method, pathname: "/api/game/verify" })).toBe("bypass")
    }
  })

  it("bypasses cross-origin GETs (fonts CDN, third parties)", () => {
    expect(routeStrategy({ ...ORIGIN, sameOrigin: false, pathname: "/assets/x.js" })).toBe("bypass")
  })

  it("passes /api/auth and /api/room through uncached (per-cookie, no-store)", () => {
    expect(routeStrategy({ ...ORIGIN, pathname: "/api/auth/me" })).toBe("passthrough")
    expect(routeStrategy({ ...ORIGIN, pathname: "/api/room/BADIRU/state" })).toBe("passthrough")
  })

  it("network-firsts the rest of /api", () => {
    for (const p of ["/api/meta", "/api/search", "/api/baits/daily", "/api/poems"]) {
      expect(routeStrategy({ ...ORIGIN, pathname: p })).toBe("network-first")
    }
  })

  it("treats a page navigation as a navigation (shell fallback)", () => {
    expect(routeStrategy({ ...ORIGIN, mode: "navigate", pathname: "/" })).toBe("navigation")
    // hash routes are still just "/" to the network
    expect(routeStrategy({ ...ORIGIN, mode: "navigate", pathname: "/index.html" })).toBe("navigation")
  })

  it("cache-firsts precached assets, fonts, icons and the manifest", () => {
    for (const p of [
      "/assets/index-abc.js",
      "/assets/index-abc.css",
      "/assets/amiri-arabic-400-normal-x.woff2",
      "/icons/icon-512.png",
      "/manifest.webmanifest",
      "/offline.html",
    ]) {
      expect(routeStrategy({ ...ORIGIN, pathname: p })).toBe("cache-first")
    }
  })

  it("does not confuse /api/authentic-looking paths — prefix, not substring", () => {
    // isNoStore keys on the leading prefix; a non-/api path with "auth" in it
    // is a cache-first asset, not a passthrough.
    expect(routeStrategy({ ...ORIGIN, pathname: "/assets/author-avatar.png" })).toBe("cache-first")
  })
})

describe("isNoStore", () => {
  it("is true for the two per-cookie prefixes and nothing else", () => {
    expect(isNoStore("/api/auth/login")).toBe(true)
    expect(isNoStore("/api/room/ABCDEF/turn")).toBe(true)
    expect(isNoStore("/api/meta")).toBe(false)
    expect(isNoStore("/api/profile/foo")).toBe(false)
  })
})

describe("cache versioning", () => {
  it("names caches under the qarid prefix", () => {
    expect(cacheName("deadbeef")).toBe(`${CACHE_PREFIX}deadbeef`)
  })

  it("precacheVersion is deterministic and order-independent", () => {
    const a = ["/", "/assets/index-1.js", "/assets/index-1.css"]
    const b = ["/assets/index-1.css", "/", "/assets/index-1.js"]
    expect(precacheVersion(a)).toBe(precacheVersion(b))
  })

  it("precacheVersion changes when any asset hash changes", () => {
    const before = ["/", "/assets/index-AAAA.js"]
    const after = ["/", "/assets/index-BBBB.js"]
    expect(precacheVersion(before)).not.toBe(precacheVersion(after))
  })

  it("precacheVersion is an 8-char hex string", () => {
    expect(precacheVersion(["/", "/x.js"])).toMatch(/^[0-9a-f]{8}$/)
  })

  it("staleCaches keeps the current version and drops older qarid caches", () => {
    const present = [
      cacheName("v1old"),
      cacheName("v2now"),
      "some-other-app-cache",
      "workbox-precache-vX",
    ]
    expect(staleCaches(present, "v2now")).toEqual([cacheName("v1old")])
  })

  it("staleCaches never touches caches outside the qarid prefix", () => {
    expect(staleCaches(["unrelated", "leyline-pwa-1"], "abc")).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════

describe("shouldRegisterServiceWorker", () => {
  const web = { prod: true, native: false, supported: true }

  it("registers on a production web build", () => {
    expect(shouldRegisterServiceWorker(web)).toBe(true)
  })

  it("NEVER registers inside the APK", () => {
    // Capacitor serves https://localhost through WebViewAssetLoader, which a
    // worker's own fetch does not go through: every same-origin fetch fails,
    // the navigation strategy falls back to the shell it precached on first
    // run, and the app is pinned to that build for good. It shipped that way.
    expect(shouldRegisterServiceWorker({ ...web, native: true })).toBe(false)
  })

  it("stays out of dev, where vite emits no sw.js", () => {
    expect(shouldRegisterServiceWorker({ ...web, prod: false })).toBe(false)
  })

  it("is a no-op where the browser has no worker at all", () => {
    expect(shouldRegisterServiceWorker({ ...web, supported: false })).toBe(false)
  })
})
