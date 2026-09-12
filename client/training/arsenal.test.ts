/**
 * The ترسانة's arithmetic — amendment 10's weakness formula, and the mastery
 * that is DERIVED from the deck rather than counted up (a lapse has to be able
 * to take محفوظ away again).
 */
import { describe, expect, it } from "vitest"

import { HIJAI_LETTERS } from "../../shared/letters.ts"
import type { Arsenal, LetterInfo, TrainingCard } from "../../shared/schema.ts"
import { MASTERED_DAYS, coverageOf, heldByLetter, letterStats, supplyOf, weakestLetters, withMastery } from "./arsenal.ts"
import { newCard } from "./schedule.ts"

const NOW = 1_756_000_000_000

function card(id: string, letter: string, interval = 0): TrainingCard {
  return { ...newCard({ id, sadr: "س", ajuz: "ع", poemId: id.split(":")[0] ?? null, firstLetter: letter }, NOW), interval }
}

const LETTERS: LetterInfo[] = HIJAI_LETTERS.map((letter) => ({
  letter,
  startsWith: 1000,
  endsWith: letter === "م" ? 300_000 : letter === "ن" ? 150_000 : letter === "ظ" ? 3_000 : 20_000,
}))

describe("supply", () => {
  it("counts أبيات played in a duel plus the cards you are learning", () => {
    const cards = { "q1:1": card("q1:1", "ب"), "q2:1": card("q2:1", "ب") }
    const arsenal: Arsenal = { ب: { used: 3, mastered: 0, lastAt: null } }
    expect(heldByLetter(cards)).toEqual({ ب: 2 })
    expect(supplyOf(arsenal, heldByLetter(cards), "ب")).toBe(5)
    expect(supplyOf(arsenal, heldByLetter(cards), "ت")).toBe(0)
  })
})

describe("withMastery", () => {
  it("recomputes محفوظ from the intervals and leaves مستعمَل alone", () => {
    const cards = {
      "q1:1": card("q1:1", "ب", MASTERED_DAYS),
      "q2:1": card("q2:1", "ب", MASTERED_DAYS + 40),
      "q3:1": card("q3:1", "ب", 5),
    }
    const next = withMastery({ ب: { used: 4, mastered: 0, lastAt: 7 } }, cards)
    expect(next["ب"]).toEqual({ used: 4, mastered: 2, lastAt: 7 })
  })

  it("takes mastery back when a card lapses", () => {
    const before = withMastery({}, { "q1:1": card("q1:1", "ج", 90) })
    expect(before["ج"]?.mastered).toBe(1)
    const after = withMastery(before, { "q1:1": card("q1:1", "ج", 0) })
    expect(after["ج"]?.mastered).toBe(0)
    expect(after["ج"]?.used).toBe(0)
  })
})

describe("letterStats / weakness", () => {
  const stats = () =>
    letterStats({
      letters: LETTERS,
      arsenal: { م: { used: 8, mastered: 0, lastAt: null }, ن: { used: 2, mastered: 0, lastAt: null } },
      cards: { "q1:1": card("q1:1", "ن") },
    })

  it("returns all 28 letters in هجائي order", () => {
    expect(stats().map((s) => s.letter)).toEqual([...HIJAI_LETTERS])
  })

  it("is demand × shortfall — a covered letter is never weak, however demanded", () => {
    const byLetter = new Map(stats().map((s) => [s.letter, s]))
    const meem = byLetter.get("م")
    expect(meem?.supply).toBe(8)
    expect(meem?.demandShare).toBe(1)
    expect(meem?.weakness).toBe(0) // eight أبيات is covered

    const noon = byLetter.get("ن")
    expect(noon?.supply).toBe(3) // 2 played + 1 card
    expect(noon?.weakness).toBeCloseTo(0.5 * (1 - 3 / 8), 6)

    const dhaa = byLetter.get("ظ")
    // rarely demanded, so an empty ظ still ranks below a half-empty ن
    expect(dhaa?.weakness).toBeLessThan(noon?.weakness ?? 0)
  })

  it("ranks the weakest first and never offers a letter with no weakness", () => {
    const weak = weakestLetters(stats(), 3)
    expect(weak).toHaveLength(3)
    expect(weak[0]?.letter).toBe("ن")
    expect(weak.every((s) => s.weakness > 0)).toBe(true)
    expect(weak.map((s) => s.letter)).not.toContain("م")
  })

  it("treats an absent /api/meta as unknown demand, not as zero coverage", () => {
    const blind = letterStats({ letters: null, arsenal: {}, cards: {} })
    expect(blind.every((s) => s.weakness === 0)).toBe(true)
    expect(weakestLetters(blind)).toEqual([])
  })
})

describe("coverage", () => {
  it("counts a letter covered at one بيت", () => {
    expect(coverageOf(letterStats({ letters: LETTERS, arsenal: {}, cards: {} }))).toEqual({
      covered: 0,
      total: 28,
      ratio: 0,
    })
    const some = letterStats({
      letters: LETTERS,
      arsenal: { م: { used: 1, mastered: 0, lastAt: null } },
      cards: { "q1:1": card("q1:1", "ب") },
    })
    expect(coverageOf(some)).toEqual({ covered: 2, total: 28, ratio: 2 / 28 })
  })
})
