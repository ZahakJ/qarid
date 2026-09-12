/**
 * The count-up is a display device over a number that is already correct, so
 * what the test pins is that it can never LIE: it ends on the exact value, it
 * never runs past it, and a nonsense input degrades to the truth rather than
 * to NaN on screen.
 */
import { describe, expect, it } from "vitest"
import { countUpValue, easeOut } from "./useCountUp.ts"

describe("easeOut", () => {
  it("is clamped and monotone", () => {
    expect(easeOut(-1)).toBe(0)
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
    expect(easeOut(2)).toBe(1)
    let prev = -1
    for (let i = 0; i <= 20; i++) {
      const v = easeOut(i / 20)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it("decelerates — half the time is more than half the distance", () => {
    expect(easeOut(0.5)).toBeGreaterThan(0.5)
    // and never overshoots: nothing in قريض bounces (v2.md §8)
    for (let i = 0; i <= 20; i++) expect(easeOut(i / 20)).toBeLessThanOrEqual(1)
  })
})

describe("countUpValue", () => {
  it("ends on the exact value", () => {
    expect(countUpValue(0, 364, 1)).toBe(364)
    expect(countUpValue(0, 364, 1.4)).toBe(364)
    expect(countUpValue(120, 90, 1)).toBe(90)
  })

  it("starts where it was told to start", () => {
    expect(countUpValue(120, 300, 0)).toBe(120)
    expect(countUpValue(120, 300, -3)).toBe(120)
  })

  it("stays inside the interval, counting up or down", () => {
    for (let i = 0; i <= 30; i++) {
      const up = countUpValue(0, 1000, i / 30)
      expect(up).toBeGreaterThanOrEqual(0)
      expect(up).toBeLessThanOrEqual(1000)
      const down = countUpValue(1000, 0, i / 30)
      expect(down).toBeGreaterThanOrEqual(0)
      expect(down).toBeLessThanOrEqual(1000)
    }
  })

  it("returns whole numbers — a score is never «317.4»", () => {
    for (let i = 0; i <= 10; i++) expect(Number.isInteger(countUpValue(0, 317, i / 10))).toBe(true)
  })

  it("degrades to the truth, never to NaN", () => {
    expect(countUpValue(Number.NaN, 50, 0.5)).toBe(50)
    expect(countUpValue(0, 50, Number.NaN)).toBe(50)
    expect(countUpValue(0, Number.NaN, 0.5)).toBe(0)
  })
})
