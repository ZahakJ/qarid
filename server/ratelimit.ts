/**
 * `server/ratelimit.ts` — the in-memory token bucket design-server.md §7 puts on
 * `/api/game/*`: 12 requests per 10 seconds per IP.
 *
 * Why the duel and nothing else: every other route is a bounded index read that
 * a CDN or a browser cache absorbs. `/api/game/verify` is the one endpoint that
 * runs an FTS5 MATCH plus five jaccard comparisons on arbitrary user text, and
 * `/api/game/reply` is the one that samples a 1.76M-row pool. A script hammering
 * either is the only cheap way to make this server work hard, and 12/10s is
 * ~10× what the fastest human duel emits (a turn is a recite, a verify and a
 * reply, on a 15-second timer at its most brutal).
 *
 * A *bucket*, not a fixed window: tokens refill continuously at
 * `tokens / windowMs`, so a player who spends their allowance disambiguating one
 * بيت is not locked out for the rest of a wall-clock window — they get a token
 * back every 833 ms and the duel keeps moving.
 *
 * The state is per-process and per-limiter instance, which is deliberate:
 * `gameRoutes()` builds its own, so two `createApp()`s in one test file cannot
 * bleed counts into each other, and a restart forgives everyone. There is one
 * server and no cluster — a shared store would be infrastructure for a problem
 * that does not exist.
 */

import type { Context, MiddlewareHandler } from "hono"

export interface RateLimitOptions {
  /** bucket capacity, and the number of tokens restored per `windowMs` */
  tokens: number
  windowMs: number
  /** override the identity function (tests, or a trusted proxy header) */
  keyOf?: (c: Context) => string
  /** injectable clock — the tests do not sleep for ten seconds */
  now?: () => number
}

export interface RateLimiter {
  middleware: MiddlewareHandler
  /** forget every bucket (tests, and the only way to un-punish an IP) */
  reset(): void
  /** how many buckets are being tracked — asserted by the eviction test */
  size(): number
}

interface Bucket {
  tokens: number
  /** last refill, ms */
  at: number
}

/**
 * Past this many tracked IPs the map is swept of buckets that have been full
 * (i.e. idle for a whole window) since before the last sweep. A full bucket
 * carries no information — recreating it costs one object — so dropping it is
 * free, and that keeps a slow scan across a /16 from growing this map without
 * bound.
 */
const SWEEP_AT = 4096

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const capacity = Math.max(1, opts.tokens)
  const windowMs = Math.max(1, opts.windowMs)
  const perMs = capacity / windowMs
  const keyOf = opts.keyOf ?? clientKey
  const now = opts.now ?? (() => Date.now())
  const buckets = new Map<string, Bucket>()

  const sweep = (t: number) => {
    for (const [key, b] of buckets) {
      if (b.tokens >= capacity && t - b.at >= windowMs) buckets.delete(key)
    }
  }

  const take = (key: string, t: number): { ok: boolean; retryMs: number } => {
    let b = buckets.get(key)
    if (b === undefined) {
      b = { tokens: capacity, at: t }
      buckets.set(key, b)
      if (buckets.size > SWEEP_AT) sweep(t)
    } else {
      const elapsed = Math.max(0, t - b.at)
      b.tokens = Math.min(capacity, b.tokens + elapsed * perMs)
      b.at = t
    }
    if (b.tokens >= 1) {
      b.tokens -= 1
      return { ok: true, retryMs: 0 }
    }
    // Time until one whole token exists again — the honest Retry-After.
    return { ok: false, retryMs: Math.ceil((1 - b.tokens) / perMs) }
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const verdict = take(keyOf(c), now())
    if (!verdict.ok) {
      c.header("Retry-After", String(Math.max(1, Math.ceil(verdict.retryMs / 1000))))
      return c.json({ error: "rate_limited", message: "too many requests" }, 429)
    }
    await next()
  }

  return {
    middleware,
    reset: () => buckets.clear(),
    size: () => buckets.size,
  }
}

/**
 * The caller's identity.
 *
 * `X-Forwarded-For` is trusted because qarid only ever answers through the
 * `cf-qarid` tunnel on 127.0.0.1 (CLAUDE.md deploy): cloudflared sets the
 * header, nothing else can reach the socket, and without it every request would
 * share one bucket keyed `127.0.0.1` and the first player would rate-limit the
 * rest of the world. The left-most entry is the client per the header's spec.
 *
 * `app.request()` in a test has no socket at all — hence the `local` fallback,
 * which is also what makes the 429 test possible.
 */
export function clientKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  const real = c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip")
  if (real) return real.trim()

  // @hono/node-server hands the raw IncomingMessage through c.env.
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  const addr = env?.incoming?.socket?.remoteAddress
  return addr ?? "local"
}
