import { describe, expect, it } from "vitest"

import {
  ARABIC_THOUSANDS,
  copyableBayt,
  countedNoun,
  formatBaits,
  formatClock,
  formatCount,
  formatNumber,
  formatPoems,
  formatPoets,
  formatScore,
  toArabicDigits,
  toLatinDigits,
} from "./format.ts"

describe("digits", () => {
  it("converts to Arabic-Indic and back", () => {
    expect(toArabicDigits("2026-08-23")).toBe("٢٠٢٦-٠٨-٢٣")
    expect(toLatinDigits("٢٠٢٦")).toBe("2026")
    expect(toLatinDigits(toArabicDigits("1234567890"))).toBe("1234567890")
  })

  it("leaves Arabic letters alone", () => {
    expect(toArabicDigits("البيت 12")).toBe("البيت ١٢")
  })
})

describe("formatNumber", () => {
  it("groups thousands with U+066C, not with a comma", () => {
    expect(formatNumber(254630)).toBe("٢٥٤٬٦٣٠")
    expect(formatNumber(254630)).toContain(ARABIC_THOUSANDS)
    expect(formatNumber(1000)).toBe("١٬٠٠٠")
    expect(formatNumber(999)).toBe("٩٩٩")
  })

  it("uses Latin digits and commas for the mono scale", () => {
    expect(formatNumber(254630, "latin")).toBe("254,630")
    expect(formatScore(1234.6)).toBe("1,235")
  })

  it("keeps a fraction on the right separator", () => {
    expect(formatNumber(3.5)).toBe("٣٫٥")
    expect(formatNumber(3.5, "latin")).toBe("3.5")
  })

  it("survives the degenerate inputs", () => {
    expect(formatCount(0)).toBe("٠")
    expect(formatNumber(Number.NaN)).toBe("٠")
    expect(formatNumber(Number.POSITIVE_INFINITY, "latin")).toBe("0")
    expect(formatNumber(-42, "latin")).toBe("-42")
  })
})

describe("formatClock", () => {
  it("is m:ss, Latin, zero-padded seconds only", () => {
    expect(formatClock(0)).toBe("0:00")
    expect(formatClock(9_000)).toBe("0:09")
    expect(formatClock(72_000)).toBe("1:12")
    expect(formatClock(600_000)).toBe("10:00")
  })

  it("never goes negative when the deadline has passed", () => {
    expect(formatClock(-5_000)).toBe("0:00")
  })
})

describe("counted nouns", () => {
  it("gets المفرد والمثنى والجمع right", () => {
    expect(formatBaits(0)).toBe("لا أبيات")
    expect(formatBaits(1)).toBe("بيت واحد")
    expect(formatBaits(2)).toBe("بيتان")
    expect(formatBaits(3)).toBe("٣ أبيات")
    expect(formatBaits(10)).toBe("١٠ أبيات")
    expect(formatBaits(11)).toBe("١١ بيتًا")
    expect(formatBaits(100)).toBe("١٠٠ بيتًا")
    // ١٠٣ takes جمع القلة again — the rule is on the last two digits.
    expect(formatBaits(103)).toBe("١٠٣ أبيات")
  })

  it("does the same for قصائد and شعراء", () => {
    expect(formatPoems(1)).toBe("قصيدة واحدة")
    expect(formatPoems(5)).toBe("٥ قصائد")
    expect(formatPoems(30)).toBe("٣٠ قصيدة")
    expect(formatPoets(2)).toBe("شاعران")
    expect(formatPoets(7167)).toBe("٧٬١٦٧ شاعرًا")
  })

  it("takes a custom form set and a numeral scale", () => {
    const forms = { zero: "none", one: "one", two: "two", few: "few", many: "many" }
    expect(countedNoun(4, forms, "latin")).toBe("4 few")
    expect(countedNoun(40, forms, "latin")).toBe("40 many")
  })
})

describe("copyableBayt", () => {
  it("opens with an RLM so a Latin-first chat app does not scramble it", () => {
    const out = copyableBayt("قِفا نَبكِ", "مِن ذِكرى حَبيبٍ")
    expect(out.codePointAt(0)).toBe(0x200f)
    expect(out).toContain(" … ")
  })

  it("handles a صدر with no عجز — the odd-hemistich case", () => {
    const out = copyableBayt("قِفا نَبكِ", null)
    expect(out).toBe("‏قِفا نَبكِ")
  })
})
