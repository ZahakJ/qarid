/**
 * The token bucket, and the one thing about it nobody could see from a route:
 * whether a bucket is ever RELEASED.
 *
 * `size()` has always been documented as "asserted by the eviction test" and
 * there was no eviction test — and there was no eviction either, because the
 * sweep judged an idle bucket by the token count stored at its LAST request.
 * Refill is lazy, so that number is at most `capacity - 1` after any completed
 * `take()`, and `tokens >= capacity` was therefore unsatisfiable: 200,000
 * one-shot IPs kept 200,000 buckets and 208 MB of RSS, plus a full O(n) map
 * scan on the one event loop for every new IP after that.
 */

import { describe, expect, it } from "vitest"

import { createRateLimiter } from "./ratelimit.ts"

/** The sweep only runs past this many keys — it is a cleanup, not a policy. */
const SWEEP_AT = 4096

function limiterAt(clock: { t: number }) {
  return createRateLimiter({ tokens: 12, windowMs: 10_000, now: () => clock.t })
}

describe("bucket eviction", () => {
  it("releases the buckets of clients that made one request and left", () => {
    const clock = { t: 1_000_000 }
    const rl = limiterAt(clock)

    // One request each from 10,000 distinct addresses, spread over ten hours.
    for (let i = 0; i < 10_000; i++) {
      clock.t += 3_600
      expect(rl.take(`10.0.${(i >> 8) & 255}.${i & 255}`).ok).toBe(true)
    }

    // Every one of them refilled to capacity hours ago, so the map must not
    // still be carrying them: the sweep fires on the next new key.
    clock.t += 10 * 60 * 60 * 1000
    rl.take("203.0.113.1")
    expect(rl.size()).toBeLessThanOrEqual(SWEEP_AT)
  })

  it("keeps a bucket that is still spending, and one that is still punished", () => {
    const clock = { t: 1_000_000 }
    const rl = limiterAt(clock)

    // Fill the map past the sweep threshold with one-shot keys…
    for (let i = 0; i < SWEEP_AT + 200; i++) {
      clock.t += 1
      rl.take(`10.1.${(i >> 8) & 255}.${i & 255}`)
    }
    // …and spend a real client's whole allowance at the same instant.
    for (let i = 0; i < 12; i++) expect(rl.take("198.51.100.7").ok).toBe(true)
    expect(rl.take("198.51.100.7").ok).toBe(false)

    // A sweep must not forgive a client that is still inside its own window:
    // at 12 per 10 s a spent bucket is worth 0.6 of a token half a second on.
    clock.t += 500
    for (let i = 0; i < 100; i++) rl.take(`10.2.0.${i}`)
    expect(rl.take("198.51.100.7").ok).toBe(false)

    // …and the bucket does come back on its own, one token at a time.
    clock.t += 1_000
    expect(rl.take("198.51.100.7").ok).toBe(true)
  })

  it("sweeps at most once per window, however many new keys arrive", () => {
    const clock = { t: 1_000_000 }
    let scanned = 0
    const rl = createRateLimiter({
      tokens: 12,
      windowMs: 10_000,
      now: () => clock.t,
      keyOf: () => "unused",
    })
    // The observable proxy for "the scan ran" is that the map shrank. Fill it
    // with keys that are all sweepable, then add new ones in a burst inside one
    // window: exactly one of them may pay for a scan.
    for (let i = 0; i < SWEEP_AT + 1; i++) {
      rl.take(`10.3.${(i >> 8) & 255}.${i & 255}`)
      scanned += 1
    }
    clock.t += 60_000
    const before = rl.size()
    rl.take("first-new-key")
    const afterFirst = rl.size()
    expect(afterFirst).toBeLessThan(before)
    // Every later key in the same window just inserts; nothing rescans.
    for (let i = 0; i < 50; i++) rl.take(`burst-${i}`)
    expect(rl.size()).toBe(afterFirst + 50)
    expect(scanned).toBeGreaterThan(SWEEP_AT)
  })
})
