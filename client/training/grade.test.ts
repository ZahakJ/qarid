/**
 * Marking. The two things that would actually go wrong: a spelling the corpus
 * itself varies being called a mistake, and the word diff painting a whole عجز
 * red because one word was inserted at the front.
 */
import { describe, expect, it } from "vitest"

import { EASY_MS, diffScore, gradeFor, levenshtein, similarity, tokens, wordDiff } from "./grade.ts"

const AJUZ = "تَجري الرِياحُ بِما لا تَشتَهي السُفُنُ"

describe("levenshtein", () => {
  it("counts edits over characters and over word arrays alike", () => {
    expect(levenshtein("", "")).toBe(0)
    expect(levenshtein("", "abc")).toBe(3)
    expect(levenshtein("كتاب", "كتاب")).toBe(0)
    expect(levenshtein("كتاب", "كتب")).toBe(1)
    expect(levenshtein(["a", "b", "c"], ["a", "c"])).toBe(1)
  })
})

describe("similarity", () => {
  it("forgives everything the shared normalizer forgives", () => {
    expect(similarity(AJUZ, "تجري الرياح بما لا تشتهي السفن")).toBe(1)
    expect(similarity("إذا الشعبُ يوماً أرادَ الحياة", "اذا الشعب يوما اراد الحياه")).toBe(1)
    expect(similarity("قِفا   نَبكِ", "قفا نبك")).toBe(1)
  })

  it("falls with the number of wrong words, and floors at zero", () => {
    const near = similarity(AJUZ, "تجري الرياح بما لا تشتهي القمر")
    expect(near).toBeGreaterThan(0.65)
    expect(near).toBeLessThan(1)
    expect(similarity(AJUZ, "ولا خير في ود امرئ متلون")).toBeLessThan(0.65)
    expect(similarity(AJUZ, "")).toBe(0)
    expect(similarity("", AJUZ)).toBe(0)
    expect(similarity("", "")).toBe(1)
  })
})

describe("gradeFor", () => {
  it("is the design's ladder", () => {
    expect(gradeFor(1, EASY_MS - 1)).toBe("easy")
    expect(gradeFor(1, EASY_MS)).toBe("good")
    expect(gradeFor(0.99, 1000)).toBe("hard")
    expect(gradeFor(0.65, 1000)).toBe("hard")
    expect(gradeFor(0.6499, 1000)).toBe("again")
    expect(gradeFor(0, 1000)).toBe("again")
  })
})

describe("tokens", () => {
  it("normalizes and drops the empties", () => {
    expect(tokens("  قِفا   نَبكِ ")).toEqual(["قفا", "نبك"])
    expect(tokens(null)).toEqual([])
  })
})

describe("wordDiff", () => {
  it("marks every word of a perfect answer ok, tashkeel and all", () => {
    const d = wordDiff("تجري الرياح بما لا تشتهي السفن", AJUZ)
    expect(d.map((t) => t.state)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"])
    // the DISPLAYED word is the بيت's own spelling, not what was typed
    expect(d[1]?.text).toBe("الرِياحُ")
    expect(diffScore(d)).toEqual({ ok: 6, total: 6 })
  })

  it("marks a substituted word wrong and keeps what was written in its place", () => {
    const d = wordDiff("تجري الرياح بما لا تشتهي القمر", AJUZ)
    expect(d.slice(0, 5).every((t) => t.state === "ok")).toBe(true)
    expect(d[5]).toEqual({ text: "السُفُنُ", state: "wrong", typed: "القمر" })
  })

  it("marks the words that never arrived missing", () => {
    const d = wordDiff("تجري الرياح", AJUZ)
    expect(d.map((t) => t.state)).toEqual(["ok", "ok", "missing", "missing", "missing", "missing"])
    expect(d.every((t) => t.typed === null)).toBe(true)
  })

  it("survives a word inserted at the front — the rest is still ok", () => {
    const d = wordDiff("ثم تجري الرياح بما لا تشتهي السفن", AJUZ)
    expect(d.map((t) => t.state)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"])
  })

  it("returns the whole عجز missing when nothing was typed, and nothing at all when there is no عجز", () => {
    expect(wordDiff("", AJUZ).map((t) => t.state)).toEqual(Array(6).fill("missing"))
    expect(wordDiff("أي شيء", "")).toEqual([])
  })
})
