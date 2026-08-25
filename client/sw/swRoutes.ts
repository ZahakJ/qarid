/**
 * قريض — service-worker ROUTING and CACHE-VERSIONING logic, kept pure.
 *
 * The deployed worker is `client/sw/sw.ts`, which touches `self`, `caches` and
 * the `install`/`activate`/`fetch` events and therefore cannot be imported into
 * a node test. Everything here is a plain function over primitives, so it IS
 * imported by both `sw.ts` and `swRoutes.test.ts` — there is one source of
 * truth for "which strategy does this request take" and "which caches are
 * stale", and the test exercises exactly the code that ships.
 *
 * Design (docs/roadmap-mobile.md §M0):
 *   • the app shell + fonts + built assets are precached, versioned by the
 *     build hash so a deploy invalidates cleanly;
 *   • `/api/*` is network-first with an offline fallback;
 *   • `/api/auth` and `/api/room` are per-cookie, `no-store`, and NEVER cached;
 *   • navigations fall back to the cached shell (favorites render offline,
 *     denormalized in localStorage) and finally to the offline page.
 */

/** Every قريض cache name begins with this; anything else is left alone. */
export const CACHE_PREFIX = "qarid-pwa-"

/** The versioned cache for one build. */
export function cacheName(version: string): string {
  return CACHE_PREFIX + version
}

/**
 * Of the caches present, the ones this build should delete on `activate` —
 * every قريض cache that is not the current version. A cache belonging to some
 * OTHER app on the same origin (the suite shares `*.avicenna.space`, but each
 * artifact has its own origin, so this is belt-and-braces) is never touched.
 */
export function staleCaches(existing: readonly string[], version: string): string[] {
  const keep = cacheName(version)
  return existing.filter((n) => n.startsWith(CACHE_PREFIX) && n !== keep)
}

/**
 * A deterministic short hash of the precache list. The list is the built
 * asset URLs, whose filenames already carry vite's per-content hash, so ANY
 * change to any shipped byte moves the version and the old cache is dropped on
 * the next activate. FNV-1a (32-bit) — pure, dependency-free, and identical in
 * the build plugin and in a test.
 */
export function precacheVersion(urls: readonly string[]): string {
  let h = 0x811c9dc5
  const joined = [...urls].sort().join("\n")
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i)
    // h *= 16777619, kept in 32-bit space without overflow
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

export type Strategy =
  /** cross-origin or non-GET — the SW does not intercept it at all. */
  | "bypass"
  /** same-origin but must never be cached (`/api/auth`, `/api/room`). */
  | "passthrough"
  /** `/api/*` — try the network, fall back to a cached copy or an offline body. */
  | "network-first"
  /** a page navigation — network, then the cached shell, then the offline page. */
  | "navigation"
  /** a precached asset / font / icon / manifest — cache, then network. */
  | "cache-first"

/** The two per-cookie prefixes the worker must never store. */
export function isNoStore(pathname: string): boolean {
  return pathname.startsWith("/api/auth") || pathname.startsWith("/api/room")
}

/**
 * The one classifier. Given the primitive facts of a request, decide how the
 * worker handles it. Order matters: method and origin gate first (a POST or a
 * cross-origin GET is never ours), then the no-store API prefixes, then the
 * rest of `/api`, then navigations, and everything else is a static asset.
 */
export function routeStrategy(input: {
  sameOrigin: boolean
  method: string
  mode: string
  pathname: string
}): Strategy {
  if (input.method !== "GET") return "bypass"
  if (!input.sameOrigin) return "bypass"
  if (isNoStore(input.pathname)) return "passthrough"
  if (input.pathname.startsWith("/api/")) return "network-first"
  if (input.mode === "navigate") return "navigation"
  return "cache-first"
}
