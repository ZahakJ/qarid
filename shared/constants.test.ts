/**
 * `constants.ts` and `schema.ts` are both "shared vocabulary" files, which is
 * exactly the setup where the same number quietly ends up defined twice and
 * then only half of it gets updated. schema.ts owns anything that crosses the
 * wire; constants.ts owns the rest. The overlap test below is what keeps that
 * boundary from eroding.
 */

import { describe, expect, it } from "vitest"

import * as constants from "./constants.ts"
import * as schema from "./schema.ts"
import { HIJAI_LETTERS } from "./letters.ts"

describe("constants", () => {
  it("pins the suite's four ports", () => {
    expect(constants.PORTS).toEqual({ devApi: 5750, devVite: 5751, preview: 6750, prod: 8010 })
  })

  it("namespaces localStorage under qarid:v1:", () => {
    expect(constants.LS_PREFIX).toBe("qarid:v1:")
    expect(constants.LS_CORRUPT_PREFIX.startsWith("qarid:")).toBe(true)
  })

  it("re-exports the alphabet rather than restating it", () => {
    expect(constants.CHAIN_LETTERS).toBe(HIJAI_LETTERS)
  })

  it("carries the measured corpus totals, not estimates", () => {
    expect(constants.CORPUS).toEqual({ poems: 254_630, baits: 3_857_429, poets: 7_167 })
    expect(constants.SOURCE_REVISION).toHaveLength(40)
  })

  it("keeps the scoring and verification numbers the docs specify", () => {
    expect(constants.SCORING.base).toBe(100)
    expect(constants.SCORING.stumpBonus).toBe(500)
    expect(constants.VERIFY.andJaccard).toBe(0.6)
    expect(constants.VERIFY.orJaccard).toBe(0.75)
    expect(constants.VERIFY.nearMissBand).toEqual([0.35, 0.6])
    expect(constants.PLAYABLE.minHemistichChars).toBe(12)
  })

  it("shares no export name with schema.ts — one source of truth each", () => {
    const overlap = Object.keys(constants).filter((k) => k in schema)
    expect(overlap).toEqual([])
  })
})
