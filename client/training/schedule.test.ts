/**
 * The scheduler is the one part of تحفيظ a reader cannot check by looking at
 * it: a wrong interval is invisible for three weeks and then loses the deck.
 * So every number in design-ux.md §5 is pinned here, plus the two rules that
 * are about the SESSION rather than the card — the weak-letter intake and
 * «never two أبيات of one قصيدة in a row».
 */
import { describe, expect, it } from "vitest"

import type { Arsenal, TrainingCard } from "../../shared/schema.ts"
import {
  AGAIN_MS,
  DAY_MS,
  EASE_MAX,
  EASE_MIN,
  EASE_START,
  INTERVAL_MAX,
  LEECH_LAPSES,
  MAX_DUE,
  MAX_NEW_PER_DAY,
  applyGrade,
  buildQueue,
  dayKeyOf,
  dueCount,
  jitterFor,
  leechesOf,
  newCard,
  previousDay,
  resetCard,
  spreadByPoem,
  startOfDay,
} from "./schedule.ts"

const NOW = new Date(2026, 7, 24, 13, 30, 0).getTime() // local noon-ish, 24 آب

function card(over: Partial<TrainingCard> = {}): TrainingCard {
  return {
    ...newCard({ id: "q1:1", sadr: "صدر", ajuz: "عجز", poemId: "q1", firstLetter: "ص" }, NOW),
    ...over,
  }
}

describe("day boundaries", () => {
  it("uses the LOCAL midnight and the local day key", () => {
    expect(startOfDay(NOW)).toBe(new Date(2026, 7, 24, 0, 0, 0, 0).getTime())
    expect(dayKeyOf(NOW)).toBe("2026-08-24")
    expect(previousDay("2026-08-24")).toBe("2026-08-23")
    expect(previousDay("2026-01-01")).toBe("2025-12-31")
  })
})

describe("applyGrade — again", () => {
  it("resets reps, counts the lapse, drops the ease and comes back in 10 minutes", () => {
    const after = applyGrade(card({ reps: 4, interval: 30, ease: 2.3 }), "again", NOW)
    expect(after.reps).toBe(0)
    expect(after.lapses).toBe(1)
    expect(after.ease).toBeCloseTo(2.1, 6)
    expect(after.interval).toBe(0) // no longer محفوظ
    expect(after.due).toBe(NOW + AGAIN_MS)
    expect(after.leech).toBe(false)
  })

  it("turns leech at the eighth lapse and stays one", () => {
    let c = card()
    for (let i = 0; i < LEECH_LAPSES - 1; i++) c = applyGrade(c, "again", NOW)
    expect(c.lapses).toBe(LEECH_LAPSES - 1)
    expect(c.leech).toBe(false)
    c = applyGrade(c, "again", NOW)
    expect(c.lapses).toBe(LEECH_LAPSES)
    expect(c.leech).toBe(true)
    expect(applyGrade(c, "good", NOW).leech).toBe(true)
  })

  it("never lets the ease fall through the floor", () => {
    let c = card()
    for (let i = 0; i < 20; i++) c = applyGrade(c, "again", NOW)
    expect(c.ease).toBe(EASE_MIN)
  })
})

describe("applyGrade — the intervals", () => {
  it("walks 1 → 3 → interval × ease × mod", () => {
    const first = applyGrade(card(), "good", NOW)
    expect(first.reps).toBe(1)
    expect(first.interval).toBe(1)
    expect(first.due).toBe(startOfDay(NOW) + DAY_MS)

    const second = applyGrade(first, "good", NOW)
    expect(second.reps).toBe(2)
    expect(second.interval).toBe(3)

    const third = applyGrade(second, "good", NOW)
    // 3 × 2.3 × 1 = 6.9 → 7, ±10% jitter
    expect(third.interval).toBeGreaterThanOrEqual(6)
    expect(third.interval).toBeLessThanOrEqual(8)
    expect(third.due).toBe(startOfDay(NOW) + third.interval * DAY_MS)
  })

  it("moves the ease by grade and keeps it inside [1.3, 2.8]", () => {
    expect(applyGrade(card(), "good", NOW).ease).toBeCloseTo(EASE_START, 6)
    expect(applyGrade(card(), "hard", NOW).ease).toBeCloseTo(2.15, 6)
    expect(applyGrade(card(), "easy", NOW).ease).toBeCloseTo(2.4, 6)
    let c = card()
    for (let i = 0; i < 20; i++) c = applyGrade(c, "easy", NOW)
    expect(c.ease).toBe(EASE_MAX)
  })

  it("hard shortens and easy lengthens the same card", () => {
    const base = applyGrade(applyGrade(card(), "good", NOW), "good", NOW) // interval 3
    expect(applyGrade(base, "hard", NOW).interval).toBeLessThan(applyGrade(base, "easy", NOW).interval)
  })

  it("caps the interval at a year however long the streak runs", () => {
    let c = card()
    for (let i = 0; i < 40; i++) c = applyGrade(c, "easy", NOW)
    expect(c.interval).toBe(INTERVAL_MAX)
    expect(c.due).toBe(startOfDay(NOW) + INTERVAL_MAX * DAY_MS)
  })

  it("never schedules a successful card inside the same day", () => {
    let c = card()
    for (let i = 0; i < 12; i++) {
      c = applyGrade(c, "good", NOW)
      expect(c.interval).toBeGreaterThanOrEqual(1)
      expect(c.due).toBeGreaterThan(startOfDay(NOW))
    }
  })
})

describe("jitter", () => {
  it("is seeded, so the same card and rep always land on the same day", () => {
    expect(jitterFor("q1:1", 3)).toBe(jitterFor("q1:1", 3))
    expect(applyGrade(card({ reps: 2, interval: 30 }), "good", NOW).due).toBe(
      applyGrade(card({ reps: 2, interval: 30 }), "good", NOW).due,
    )
  })

  it("stays inside ±10% and differs between cards", () => {
    for (const id of ["q1:1", "q99:4", "q123:12"]) {
      const j = jitterFor(id, 5)
      expect(j).toBeGreaterThanOrEqual(-0.1)
      expect(j).toBeLessThanOrEqual(0.1)
    }
    const a = applyGrade(card({ id: "q1:1", reps: 2, interval: 100 }), "good", NOW).interval
    const b = applyGrade(card({ id: "q7:9", reps: 2, interval: 100 }), "good", NOW).interval
    expect(Math.abs(a - 230)).toBeLessThanOrEqual(23)
    expect(Math.abs(b - 230)).toBeLessThanOrEqual(23)
    expect(a).not.toBe(b)
  })
})

describe("leeches", () => {
  it("are listed worst first and reset back to a fresh card", () => {
    const cards = {
      "q1:1": card({ id: "q1:1", leech: true, lapses: 8 }),
      "q2:1": card({ id: "q2:1", leech: true, lapses: 11 }),
      "q3:1": card({ id: "q3:1" }),
    }
    expect(leechesOf(cards).map((c) => c.id)).toEqual(["q2:1", "q1:1"])
    const back = resetCard(cards["q2:1"], NOW)
    expect(back.leech).toBe(false)
    expect(back.lapses).toBe(0)
    expect(back.ease).toBe(EASE_START)
    expect(back.due).toBe(NOW)
  })
})

describe("buildQueue", () => {
  const deck = (n: number, over: (i: number) => Partial<TrainingCard> = () => ({})) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => {
        const c = card({ id: `q${i}:1`, poemId: `q${i}`, due: NOW - (n - i) * 1000, ...over(i) })
        return [c.id, c]
      }),
    )

  it("takes what is due, oldest first, and never more than twenty", () => {
    const plan = buildQueue({ cards: deck(30), now: NOW })
    expect(plan.due).toHaveLength(MAX_DUE)
    expect(plan.due[0]).toBe("q0:1")
    expect(plan.queue).toHaveLength(MAX_DUE)
  })

  it("leaves out cards that are not due yet, and every leech", () => {
    const cards = {
      ...deck(3),
      later: card({ id: "later", due: NOW + DAY_MS }),
      stuck: card({ id: "stuck", due: NOW - DAY_MS, leech: true }),
    }
    const plan = buildQueue({ cards, now: NOW })
    expect(plan.queue).not.toContain("later")
    expect(plan.queue).not.toContain("stuck")
    expect(plan.leeches.map((c) => c.id)).toEqual(["stuck"])
    expect(dueCount(cards, NOW)).toBe(3)
  })

  it("a letter session drills THAT letter — both halves, not just the new أبيات", () => {
    /**
     * `#/train/drill?letter=<L>` is what «ذاكِر حرف ج» in the ترسانة opens.
     * The letter used to bias only which candidates were asked for, so the due
     * half — which is full of whatever the PREVIOUS letter's session just
     * introduced, all of it due immediately — led the queue and the reader got
     * ظ under a ج heading.
     */
    const cards = {
      "q1:1": card({ id: "q1:1", poemId: "q1", due: NOW - 3000, firstLetter: "ظ" }),
      "q2:1": card({ id: "q2:1", poemId: "q2", due: NOW - 2000, firstLetter: "ج" }),
      "q3:1": card({ id: "q3:1", poemId: "q3", due: NOW - 1000, firstLetter: null }),
    }
    const plan = buildQueue({ cards, now: NOW, letter: "ج" })
    expect(plan.queue).toEqual(["q2:1"])
    // …and a candidate on another letter is not admitted either.
    const withNew = buildQueue({
      cards,
      now: NOW,
      letter: "ج",
      maxNew: 5,
      candidates: [
        { id: "n1:1", poemId: "n1", sadr: "س", ajuz: "ع", firstLetter: "ظ", fame: 3 },
        { id: "n2:1", poemId: "n2", sadr: "س", ajuz: "ع", firstLetter: "ج", fame: 1 },
      ],
    })
    expect(withNew.fresh.map((c) => c.id)).toEqual(["n2:1"])
    // No letter at all is the ordinary session, and nothing is filtered.
    expect(buildQueue({ cards, now: NOW }).queue).toHaveLength(3)
  })

  it("never puts two أبيات of one قصيدة back to back", () => {
    const cards = Object.fromEntries(
      ["q1:1", "q1:2", "q1:3", "q2:1", "q2:2", "q3:1"].map((id, i) => {
        const c = card({ id, poemId: id.split(":")[0] ?? null, due: NOW - (10 - i) * 1000 })
        return [id, c]
      }),
    )
    const plan = buildQueue({ cards, now: NOW })
    expect(plan.queue).toHaveLength(6)
    for (let i = 1; i < plan.queue.length; i++) {
      const a = plan.queue[i - 1]?.split(":")[0]
      const b = plan.queue[i]?.split(":")[0]
      expect(a, plan.queue.join(" ")).not.toBe(b)
    }
  })

  it("accepts a clash it cannot avoid rather than dropping the card", () => {
    const spread = spreadByPoem([
      { id: "a", poemId: "q1" },
      { id: "b", poemId: "q1" },
      { id: "c", poemId: "q1" },
    ])
    expect(spread.map((s) => s.id)).toEqual(["a", "b", "c"])
  })

  it("admits new أبيات on the letters the ترسانة is thin on, famous first", () => {
    const arsenal: Arsenal = { م: { used: 9, mastered: 0, lastAt: null }, ن: { used: 1, mastered: 0, lastAt: null } }
    const plan = buildQueue({
      cards: {},
      now: NOW,
      arsenal,
      candidates: [
        { id: "q10:1", sadr: "م…", ajuz: "…", poemId: "q10", firstLetter: "م", fame: 3 },
        { id: "q11:1", sadr: "ن…", ajuz: "…", poemId: "q11", firstLetter: "ن", fame: 2 },
        { id: "q12:1", sadr: "ظ…", ajuz: "…", poemId: "q12", firstLetter: "ظ", fame: 1 },
        { id: "q13:1", sadr: "ظ…", ajuz: "…", poemId: "q13", firstLetter: "ظ", fame: 3 },
      ],
    })
    // م is covered (9 ≥ 3) so it goes last however famous it is; among the thin
    // letters the fame order decides.
    expect(plan.fresh.map((c) => c.id)).toEqual(["q13:1", "q11:1", "q12:1", "q10:1"])
  })

  it("respects the daily new-card budget and never re-admits a known بيت", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}:1`,
      sadr: "س",
      ajuz: "ع",
      poemId: `n${i}`,
      firstLetter: "ب",
    }))
    expect(buildQueue({ cards: {}, now: NOW, candidates }).fresh).toHaveLength(MAX_NEW_PER_DAY)
    expect(buildQueue({ cards: {}, now: NOW, candidates, newIntroducedToday: 7 }).fresh).toHaveLength(3)
    expect(buildQueue({ cards: {}, now: NOW, candidates, newIntroducedToday: 99 }).fresh).toHaveLength(0)

    const known = { "n0:1": card({ id: "n0:1", due: NOW + DAY_MS }) }
    expect(buildQueue({ cards: known, now: NOW, candidates }).fresh.map((c) => c.id)).not.toContain("n0:1")
  })

  it("puts the review half before the new half", () => {
    const plan = buildQueue({
      cards: deck(2),
      now: NOW,
      candidates: [{ id: "fresh:1", sadr: "س", ajuz: "ع", poemId: "fresh", firstLetter: "ب" }],
    })
    expect(plan.queue).toEqual(["q0:1", "q1:1", "fresh:1"])
  })
})
