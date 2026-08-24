import { describe, expect, it } from "vitest"

import {
  BAYT_FORMS,
  FAWZ_FORMS,
  MUSAJALA_FORMS,
  BITAQA_FORMS,
  copyableBayt,
  countedNoun,
  countedNounGenitive,
  countedNounWithAdjective,
  countedUnit,
  formatCards,
  formatDayStreak,
  formatResults,
  formatWords,
  formatBaits,
  formatClock,
  formatCount,
  formatNumber,
  formatPoems,
  formatPoets,
  formatScore,
  toLatinDigits,
} from "./format.ts"

describe("digits", () => {
  it("parses Arabic-Indic and Persian digits back to ASCII", () => {
    expect(toLatinDigits("٢٠٢٦")).toBe("2026")
    expect(toLatinDigits("۲۰۲۶")).toBe("2026")
    expect(toLatinDigits("١٢٣٤٥٦٧٨٩٠")).toBe("1234567890")
  })

  it("leaves Arabic letters alone", () => {
    expect(toLatinDigits("البيت ١٢")).toBe("البيت 12")
  })
})

describe("formatNumber", () => {
  it("is Western digits with a comma every three — the owner's one scale", () => {
    expect(formatNumber(239411)).toBe("239,411")
    expect(formatNumber(254630)).toBe("254,630")
    expect(formatNumber(1000)).toBe("1,000")
    expect(formatNumber(999)).toBe("999")
    expect(formatNumber(3393887)).toBe("3,393,887")
  })

  it("emits no Arabic-Indic digit and no U+066C anywhere", () => {
    for (const n of [0, 7, 42, 999, 1000, 239411, 3393887, 3.5]) {
      expect(formatNumber(n)).not.toMatch(/[٠-٩٬٫]/)
    }
  })

  it("rounds the score scale", () => {
    expect(formatScore(1234.6)).toBe("1,235")
  })

  it("keeps a fraction on a decimal point", () => {
    expect(formatNumber(3.5)).toBe("3.5")
  })

  it("survives the degenerate inputs", () => {
    expect(formatCount(0)).toBe("0")
    expect(formatNumber(Number.NaN)).toBe("0")
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0")
    // an LRM opens the run so the minus does not flip to the far side in RTL
    expect(formatNumber(-42)).toBe("\u200E-42")
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
    expect(formatBaits(3)).toBe("3 أبيات")
    expect(formatBaits(10)).toBe("10 أبيات")
    expect(formatBaits(11)).toBe("11 بيتًا")
    expect(formatBaits(100)).toBe("100 بيتًا")
    // 103 takes جمع القلة again — the rule is on the last two digits.
    expect(formatBaits(103)).toBe("103 أبيات")
    expect(formatBaits(951)).toBe("951 بيتًا")
  })

  it("does the same for قصائد and شعراء", () => {
    expect(formatPoems(1)).toBe("قصيدة واحدة")
    expect(formatPoems(5)).toBe("5 قصائد")
    expect(formatPoems(30)).toBe("30 قصيدة")
    expect(formatPoets(2)).toBe("شاعران")
    expect(formatPoets(6997)).toBe("6,997 شاعرًا")
  })

  it("takes a custom form set", () => {
    const forms = { zero: "none", one: "one", two: "two", few: "few", many: "many" }
    expect(countedNoun(4, forms)).toBe("4 few")
    expect(countedNoun(40, forms)).toBe("40 many")
    expect(countedNoun(1400, forms)).toBe("1,400 many")
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

describe("counted nouns in the shapes the views actually need", () => {
  it("puts the dual in the genitive after a preposition — «سلسلة من بيتين»", () => {
    // «سلسلة من بيتان» shipped in the duel's share text; it is the one form
    // whose ending a reader hears, and the only one this function changes.
    expect(countedNounGenitive(2, BAYT_FORMS)).toBe("بيتين")
    expect(countedNounGenitive(1, BAYT_FORMS)).toBe("بيت واحد")
    expect(countedNounGenitive(6, BAYT_FORMS)).toBe("6 أبيات")
    expect(countedNounGenitive(14, BAYT_FORMS)).toBe("14 بيتًا")
    expect(countedNounGenitive(0, BAYT_FORMS)).toBe("لا أبيات")
  })

  it("countedUnit gives the WORD only, for a layout that printed the digits itself", () => {
    // A stat tile or a coloured number span cannot use «بطاقة واحدة».
    expect(countedUnit(0, BITAQA_FORMS)).toBe("بطاقة")
    expect(countedUnit(1, BITAQA_FORMS)).toBe("بطاقة")
    expect(countedUnit(2, BITAQA_FORMS)).toBe("بطاقة")
    expect(countedUnit(5, BITAQA_FORMS)).toBe("بطاقات")
    expect(countedUnit(10, BITAQA_FORMS)).toBe("بطاقات")
    expect(countedUnit(11, BITAQA_FORMS)).toBe("بطاقة")
    expect(countedUnit(103, BITAQA_FORMS)).toBe("بطاقات")
    expect(countedUnit(3_371_410, BAYT_FORMS)).toBe("أبيات")
  })

  it("agrees the نعت with the معدود", () => {
    const adj = { one: "جديد", two: "جديدان", few: "جديدة", many: "جديدًا" }
    expect(countedNounWithAdjective(1, BAYT_FORMS, adj)).toBe("بيت واحد جديد")
    expect(countedNounWithAdjective(2, BAYT_FORMS, adj)).toBe("بيتان جديدان")
    expect(countedNounWithAdjective(5, BAYT_FORMS, adj)).toBe("5 أبيات جديدة")
    expect(countedNounWithAdjective(12, BAYT_FORMS, adj)).toBe("12 بيتًا جديدًا")
    expect(countedNounWithAdjective(0, BAYT_FORMS, adj)).toBe("لا أبيات")
  })

  it("counts نتائج, بطاقات, كلمات and أيام the same way", () => {
    expect(formatResults(0)).toBe("لا نتائج")
    expect(formatResults(4)).toBe("4 نتائج")
    expect(formatResults(129)).toBe("129 نتيجة")
    expect(formatCards(10)).toBe("10 بطاقات")
    expect(formatCards(11)).toBe("11 بطاقة")
    expect(formatWords(5)).toBe("5 كلمات")
    expect(formatDayStreak(1)).toBe("يوم واحد متتالٍ")
    expect(formatDayStreak(2)).toBe("يومان متتاليان")
    expect(formatDayStreak(3)).toBe("3 أيام متتالية")
    expect(formatDayStreak(12)).toBe("12 يومًا متتاليًا")
  })
})

describe("the profile page's counted nouns (v2.md §4)", () => {
  it("counts مساجلات and انتصارات the way a reader would say them", () => {
    expect(countedNoun(0, MUSAJALA_FORMS)).toBe("لا مساجلات")
    expect(countedNoun(1, MUSAJALA_FORMS)).toBe("مساجلة واحدة")
    expect(countedNoun(2, MUSAJALA_FORMS)).toBe("مساجلتان")
    expect(countedNoun(5, MUSAJALA_FORMS)).toBe("5 مساجلات")
    expect(countedNoun(11, MUSAJALA_FORMS)).toBe("11 مساجلة")
    // The stat tile prints the digits itself, so only the WORD is wanted.
    expect(countedUnit(0, MUSAJALA_FORMS)).toBe("مساجلة")
    expect(countedUnit(4, MUSAJALA_FORMS)).toBe("مساجلات")
    expect(countedUnit(12, FAWZ_FORMS)).toBe("فوزًا")
    expect(countedUnit(3, FAWZ_FORMS)).toBe("انتصارات")
  })
})
