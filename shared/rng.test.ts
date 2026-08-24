import { describe, expect, it } from "vitest"

import { hashSeed, intBetween, pick, rngFrom, sfc32, shuffled, uniform } from "./rng.ts"

describe("seeded rng", () => {
  it("is deterministic — the same seed replays the same stream", () => {
    const a = rngFrom("daily:2026-08-23")
    const b = rngFrom("daily:2026-08-23")
    const left = Array.from({ length: 20 }, () => a())
    const right = Array.from({ length: 20 }, () => b())
    expect(left).toEqual(right)
  })

  it("separates seeds that differ by one character", () => {
    const a = Array.from({ length: 8 }, rngFrom("daily:2026-08-23"))
    const b = Array.from({ length: 8 }, rngFrom("daily:2026-08-24"))
    expect(a).not.toEqual(b)
  })

  it("stays in [0, 1)", () => {
    const r = rngFrom("qarid")
    for (let i = 0; i < 5000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it("is roughly uniform — a biased opponent picker is a boring opponent", () => {
    const r = rngFrom("uniformity")
    const buckets = new Array<number>(10).fill(0)
    const n = 100_000
    for (let i = 0; i < n; i++) buckets[Math.floor(r() * 10)]! += 1
    for (const b of buckets) expect(Math.abs(b - n / 10) / (n / 10)).toBeLessThan(0.05)
  })

  it("hashSeed gives four 32-bit words", () => {
    const seeds = hashSeed("qarid")
    expect(seeds).toHaveLength(4)
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it("sfc32 is usable directly with explicit state", () => {
    const a = sfc32(1, 2, 3, 4)
    const b = sfc32(1, 2, 3, 4)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it("pick / uniform / intBetween stay in range", () => {
    const r = rngFrom("range")
    const items = ["ا", "ب", "ت"]
    for (let i = 0; i < 500; i++) {
      expect(items).toContain(pick(r, items))
      const u = uniform(r, 5, 7)
      expect(u).toBeGreaterThanOrEqual(5)
      expect(u).toBeLessThan(7)
      const n = intBetween(r, 1, 6)
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(6)
    }
  })

  it("shuffled is a permutation and does not mutate its input", () => {
    const src = Object.freeze(["ا", "ب", "ت", "ث", "ج"])
    const out = shuffled(rngFrom("shuffle"), src)
    expect([...out].sort()).toEqual([...src].sort())
    expect(src).toEqual(["ا", "ب", "ت", "ث", "ج"])
    expect(shuffled(rngFrom("shuffle"), src)).toEqual(out)
  })
})
