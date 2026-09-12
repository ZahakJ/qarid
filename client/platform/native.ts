/**
 * The native shell shim (docs/roadmap-mobile.md §M1).
 *
 * قريض is one web app that runs in two places: an ordinary browser tab and a
 * Capacitor Android WebView. This module is the ONLY place the difference is
 * spelled, and everything else in the client stays exactly as it was on the web:
 *
 *  • On the WEB, `isNative` is false, `API_BASE` is `""` (same-origin), no token
 *    is stored and no header is added. The cookie session the server already
 *    issues is what signs you in, and nothing here changes that path.
 *
 *  • In the NATIVE shell, the page is served from the bundled assets at
 *    `https://localhost` (Capacitor's `androidScheme`), so a relative `/api/…`
 *    would hit the WebView's own empty origin, not the server. `API_BASE`
 *    therefore points every request at the real deployment
 *    (no default — it MUST be set at build time with
 *    `VITE_API_BASE` for the emulator smoke). Cross-origin WebView cookies are
 *    unreliable, so the shell authenticates with a bearer token instead: it
 *    asks for one at login (`X-Client: capacitor`), keeps it in Capacitor
 *    Preferences (survives a cold start — localStorage in a WebView does not,
 *    reliably), and sends it back as `Authorization: Bearer <token>` on every
 *    call and the `/ws` upgrade host.
 *
 * The bearer is held in memory for the synchronous `fetch` path and hydrated
 * from Preferences once at boot (`loadToken`), before the first `/auth/me`.
 */

import { Capacitor } from "@capacitor/core"

/** True only inside the Capacitor Android/iOS WebView. */
export const isNative: boolean = Capacitor.isNativePlatform()

/** The current native platform name (`"android"`, `"ios"`, or `"web"`). */
export const platform: string = Capacitor.getPlatform()

function buildApiBase(): string {
  if (!isNative) return ""
  const configured = (import.meta.env?.VITE_API_BASE ?? "").trim()
  // No fallback host on purpose. A native shell with no API base is broken,
  // and the honest way to be broken is loudly and at once — not by quietly
  // sending every request to a placeholder domain, which is what a default
  // would be in a public checkout. Set VITE_API_BASE at build time.
  if (!configured) console.error("VITE_API_BASE is not set: the native shell has no API origin to talk to")
  return configured.replace(/\/+$/, "")
}

/** Prefix for every `/api/…` and `/ws/…` path; `""` on the web (same-origin). */
export const API_BASE: string = buildApiBase()

/**
 * The origin a shared LINK must be built on — never `location.origin`.
 *
 * Inside the APK the WebView serves the bundled shell from `https://localhost`
 * (`androidScheme: "https"`, no `server.url`), so `location.origin` there is
 * `https://localhost` and a link built on it is dead the moment it leaves the
 * phone. On the web the two are the same thing, and same-origin is still what
 * you want — a reader on a preview or a staging host should share the host he
 * is actually reading.
 */
export function shareOrigin(): string {
  return API_BASE || location.origin
}

const TOKEN_KEY = "qarid.bearer.v1"
let token: string | null = null

/** The bearer token this session holds, or null. Synchronous for `fetch`. */
export function currentToken(): string | null {
  return token
}

/** Hydrate the token from Preferences. Call once at boot, before `/auth/me`. */
export async function loadToken(): Promise<void> {
  if (!isNative) return
  try {
    const { Preferences } = await import("@capacitor/preferences")
    const { value } = await Preferences.get({ key: TOKEN_KEY })
    token = value ?? null
  } catch {
    token = null
  }
}

/** Persist (or clear, with `null`) the bearer token. In-memory update is sync. */
export function setToken(next: string | null): void {
  token = next
  if (!isNative) return
  void (async () => {
    try {
      const { Preferences } = await import("@capacitor/preferences")
      if (next) await Preferences.set({ key: TOKEN_KEY, value: next })
      else await Preferences.remove({ key: TOKEN_KEY })
    } catch {
      /* best effort — the in-memory copy still authenticates this run */
    }
  })()
}

/** Absolute URL for an API path in the native shell; unchanged on the web. */
export function resolveApiUrl(path: string): string {
  if (!API_BASE) return path
  return path.startsWith("/") ? API_BASE + path : path
}

/**
 * Headers the native shell adds to every request: `X-Client` asks the server
 * for a bearer at login (allowlisted in the CORS preflight, server/origin.ts),
 * and `Authorization` carries the one we already hold. Empty on the web, so the
 * cookie flow is byte-for-byte unchanged.
 */
export function nativeHeaders(): Record<string, string> {
  if (!isNative) return {}
  const h: Record<string, string> = { "X-Client": "capacitor" }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/**
 * The `{protocol, host}` the `/ws` upgrade must target. On the web this is the
 * page's own origin (same-origin, cookie-authenticated). In the native shell
 * the page origin is `https://localhost` with no server behind it, so the
 * socket must reach `API_BASE`'s host instead; when it cannot authenticate over
 * the header a WebView cannot set, roomStore falls back to the HTTP poller,
 * which carries the bearer like every other call.
 */
export function apiSocketLoc(): { protocol: string; host: string } | undefined {
  if (!API_BASE) return undefined
  try {
    const u = new URL(API_BASE)
    return { protocol: u.protocol, host: u.host }
  } catch {
    return undefined
  }
}
