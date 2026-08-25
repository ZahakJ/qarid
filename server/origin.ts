/**
 * `server/origin.ts` — is this request coming from قريض's own page?
 *
 * WHY THIS EXISTS. The session cookie's only cross-origin defence was
 * `SameSite=Lax`, and SameSite is computed on the REGISTRABLE DOMAIN, not on
 * the origin. This deployment is a suite: meme., alchemy., vestige.,
 * alexandria., leyline… all live under `avicenna.space` beside
 * `qarid.avicenna.space`, several of them serve user-supplied content by
 * design, and every one of them is *same-site* with قريض — so a page on any of
 * them (or an XSS on any of them) sends `qarid_sess` with a forged POST. Lax
 * stops the drive-by from an arbitrary internet page; it does not stop a
 * neighbour. Measured before this file existed: a `text/plain` POST from
 * `https://meme.avicenna.space` renamed the signed-in reader's account, logged
 * them out, and — through `/api/room/:code/resign` — threw their live مساجلة.
 *
 * WHAT IT CHECKS, in the order a browser makes it cheap:
 *
 *  1. `Sec-Fetch-Site`. Every current browser sends it and no page can forge
 *     it. `same-origin` and `none` (a typed URL, a bookmark) pass; `same-site`
 *     and `cross-site` are exactly the neighbour above, and they do not.
 *  2. `Origin`. Present on every state-changing fetch and on every form POST.
 *     It must be `PUBLIC_ORIGIN`, or the very host this request was addressed
 *     to — the second clause is what makes `npm run dev` (vite on 5751 proxying
 *     to 5750) and a smoke run on 127.0.0.1 work without configuration, since
 *     both are same-origin by construction. `Origin: null` (a sandboxed frame,
 *     a `data:` document) matches neither and is refused.
 *  3. Neither header at all → allowed. That is `curl`, a test's
 *     `app.request()`, and a native client; none of them carries somebody
 *     else's cookie by accident, which is the whole threat model here.
 *
 * The check is mounted on the METHODS that change something and on the
 * WebSocket upgrade (which is a GET, and which the browser will happily open
 * cross-origin with the cookie attached). Ordinary reads are left alone: the
 * server sends no CORS headers, so a cross-origin page can fire a GET but can
 * never read the answer.
 */

import type { Context, MiddlewareHandler } from "hono"

import type { Config } from "./config.ts"

/** Methods that can change something, and therefore need the check. */
const GUARDED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** Path prefixes whose GETs are guarded too — an upgrade rides the cookie. */
const GUARDED_GETS = ["/ws/"] as const

function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "").toLowerCase()
}

/** `https://qarid.avicenna.space` → `qarid.avicenna.space` (port included). */
function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Whether `origin` may act on this server. Exported for the tests; the
 * middleware below is the only production caller.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  publicOrigin: string,
): boolean {
  if (!origin) return true
  const o = normalizeOrigin(origin)
  if (o === "" || o === "null") return false
  if (o === normalizeOrigin(publicOrigin)) return true
  const from = hostOf(o)
  return from !== null && host !== undefined && from === host.trim().toLowerCase()
}

/** `Sec-Fetch-Site`, when the browser sent one: only our own page passes. */
export function fetchSiteAllowed(site: string | undefined): boolean {
  if (!site) return true
  const s = site.trim().toLowerCase()
  return s === "same-origin" || s === "none"
}

export function sameOriginRequest(c: Context, config: Config): boolean {
  if (!fetchSiteAllowed(c.req.header("sec-fetch-site"))) return false
  return originAllowed(c.req.header("origin"), c.req.header("host"), config.publicOrigin)
}

/** True when this request is one the guard has to look at. */
export function needsOriginCheck(method: string, path: string): boolean {
  if (GUARDED_METHODS.has(method.toUpperCase())) return true
  return GUARDED_GETS.some((prefix) => path.startsWith(prefix))
}

/**
 * The middleware. 403 with an Arabic message a reader could actually see if
 * they ever managed to trip it themselves — they cannot, from قريض's own page.
 */
export function originGuard(config: Config): MiddlewareHandler {
  return async (c, next) => {
    if (needsOriginCheck(c.req.method, c.req.path) && !sameOriginRequest(c, config)) {
      return c.json({ error: "origin_rejected", message: "طلبٌ من موضعٍ غير موضع الموقع" }, 403)
    }
    await next()
  }
}
