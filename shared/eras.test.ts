/**
 * Fourteen raw values in, twelve rows out. The two merges are the whole point
 * of this file, and a browse page that lists الأندلس twice — once as «العصر
 * الأندلسي» and once as «المغرب والأندلس» — is the bug it exists to prevent.
 */

import { describe, expect, it } from "vitest"

import {
  ERAS,
  RAW_ERA_VALUES,
  compareEras,
  eraBySlug,
  normalizeEra,
} from "./eras.ts"

describe("the eras table", () => {
  it("is twelve rows in chronological order", () => {
    expect(ERAS).toHaveLength(12)
    expect(ERAS.map((e) => e.sort)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(ERAS.map((e) => e.slug)).toEqual([
      "jahili", "mukhadram", "islami", "umawi", "abbasi", "andalus",
      "fatimi", "ayyubi", "mamluki", "baynadawlatayn", "uthmani", "hadith",
    ])
  })

  it("has unique slugs and unique names", () => {
    expect(new Set(ERAS.map((e) => e.slug)).size).toBe(12)
    expect(new Set(ERAS.map((e) => e.name)).size).toBe(12)
  })

  it("marks الأندلس والمغرب as a region, everything else as a period", () => {
    // amendment 11: it overlaps الأموي through العثماني; a timeline that draws
    // it as a period between them is drawing a lie.
    for (const e of ERAS) expect(e.kind, e.slug).toBe(e.slug === "andalus" ? "region" : "period")
    expect(eraBySlug("andalus")!.span).toBeNull()
  })
})

describe("normalizeEra over the corpus vocabulary", () => {
  it("resolves all fourteen raw values", () => {
    expect(RAW_ERA_VALUES).toHaveLength(14)
    for (const raw of RAW_ERA_VALUES) expect(normalizeEra(raw), raw).not.toBeNull()
  })

  it("performs the two merges", () => {
    expect(normalizeEra("قبل الإسلام")!.slug).toBe("jahili")
    expect(normalizeEra("العصر الجاهلي")!.slug).toBe("jahili")
    expect(normalizeEra("العصر الأندلسي")!.slug).toBe("andalus")
    expect(normalizeEra("المغرب والأندلس")!.slug).toBe("andalus")
  })

  it("fixes the corpus's «المخضرمين» to المخضرمون", () => {
    expect(normalizeEra("المخضرمين")!.name).toBe("المخضرمون")
    expect(normalizeEra("المخضرمون")!.slug).toBe("mukhadram")
  })

  it("collapses 14 raw values onto 12 distinct rows", () => {
    const slugs = new Set(RAW_ERA_VALUES.map((r) => normalizeEra(r)!.slug))
    expect(slugs.size).toBe(12)
  })

  it("is spelling-insensitive — eight source sites, eight habits", () => {
    expect(normalizeEra("العصر الاموي")!.slug).toBe("umawi")
    expect(normalizeEra("  العصر   العباسي  ")!.slug).toBe("abbasi")
    expect(normalizeEra("العَصرُ الأُمَوي")!.slug).toBe("umawi")
  })

  it("answers null for the 107,209 rows that carry no era", () => {
    for (const raw of [null, undefined, "", "   ", "لا شيء"]) {
      expect(normalizeEra(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it("sorts chronologically by slug", () => {
    expect(compareEras("jahili", "hadith")).toBeLessThan(0)
    expect(compareEras("abbasi", "umawi")).toBeGreaterThan(0)
    const shuffled = ["hadith", "jahili", "abbasi", "andalus"]
    expect([...shuffled].sort(compareEras)).toEqual(["jahili", "abbasi", "andalus", "hadith"])
  })
})
