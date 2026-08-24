import { describe, expect, it } from "vitest"
import { ASSIST, SCORING } from "../../shared/constants.ts"
import { HINT_COSTS } from "../../shared/schema.ts"
import {
  awardFor,
  hintCost,
  hintPricing,
  hintSpend,
  obscurityFromPoemCount,
  pricedHint,
  scoreObscurity,
  assistScale,
  stumpBonusFor,
  STUMP_BONUS,
} from "./scoring.ts"

describe("awardFor — design-ux.md §4.3", () => {
  it("the plain case: first بيت, no timer, no obscurity, no hints", () => {
    const a = awardFor({ streak: 1, msRemaining: 0, timerOn: false, obscurity: 0 })
    expect(a.base).toBe(100)
    expect(a.streakBonus).toBe(10)
    expect(a.timeBonus).toBe(0)
    expect(a.obscurityBonus).toBe(0)
    expect(a.total).toBe(110)
  })

  it("streak bonus is 10 a rung and caps at ten rungs", () => {
    expect(awardFor({ streak: 7, msRemaining: 0, timerOn: false, obscurity: 0 }).streakBonus).toBe(70)
    expect(awardFor({ streak: 10, msRemaining: 0, timerOn: false, obscurity: 0 }).streakBonus).toBe(100)
    expect(awardFor({ streak: 40, msRemaining: 0, timerOn: false, obscurity: 0 }).streakBonus).toBe(100)
  })

  it("amendment 16's multiplicative form agrees with the additive one", () => {
    for (const streak of [0, 1, 5, 10, 25]) {
      const mult = SCORING.base * (1 + (SCORING.perStreak / SCORING.base) * Math.min(streak, SCORING.maxStreakBonus))
      const a = awardFor({ streak, msRemaining: 0, timerOn: false, obscurity: 0 })
      expect(a.base + a.streakBonus).toBeCloseTo(mult, 9)
    }
  })

  it("time bonus is 2 points a whole second, and only when the timer is on", () => {
    expect(awardFor({ streak: 1, msRemaining: 12_400, timerOn: true, obscurity: 0 }).timeBonus).toBe(24)
    expect(awardFor({ streak: 1, msRemaining: 12_400, timerOn: false, obscurity: 0 }).timeBonus).toBe(0)
    // rounding, not truncation: 12.6s is 13 seconds' worth
    expect(awardFor({ streak: 1, msRemaining: 12_600, timerOn: true, obscurity: 0 }).timeBonus).toBe(26)
  })

  it("a negative clock never pays a negative bonus", () => {
    expect(awardFor({ streak: 1, msRemaining: -5_000, timerOn: true, obscurity: 0 }).timeBonus).toBe(0)
  })

  it("obscurity pays up to 50 and is clamped to 0..1", () => {
    expect(awardFor({ streak: 1, msRemaining: 0, timerOn: false, obscurity: 1 }).obscurityBonus).toBe(50)
    expect(awardFor({ streak: 1, msRemaining: 0, timerOn: false, obscurity: 0.5 }).obscurityBonus).toBe(25)
    expect(awardFor({ streak: 1, msRemaining: 0, timerOn: false, obscurity: 4 }).obscurityBonus).toBe(50)
    expect(awardFor({ streak: 1, msRemaining: 0, timerOn: false, obscurity: -1 }).obscurityBonus).toBe(0)
    expect(awardFor({ streak: 1, msRemaining: 0, timerOn: false, obscurity: Number.NaN }).obscurityBonus).toBe(0)
  })

  it("hints come off the award once, and may take it negative", () => {
    const a = awardFor({ streak: 1, msRemaining: 0, timerOn: false, obscurity: 0, hintPenalty: 300 })
    expect(a.hintPenalty).toBe(300)
    expect(a.total).toBe(-190)
  })

  it("the worked example: streak 7, 12s left, obscurity .4, one «من قائله؟»", () => {
    const a = awardFor({ streak: 7, msRemaining: 12_000, timerOn: true, obscurity: 0.4, hintPenalty: HINT_COSTS.poet })
    // 100 + 70 + 24 + 20 − 40
    expect(a.total).toBe(174)
  })
})

describe("obscurity", () => {
  it("a one-قصيدة شاعر is maximally obscure; 1000+ is not obscure at all", () => {
    expect(obscurityFromPoemCount(1)).toBe(1)
    expect(obscurityFromPoemCount(1000)).toBe(0)
    expect(obscurityFromPoemCount(50_000)).toBe(0)
    expect(obscurityFromPoemCount(null)).toBe(0)
    expect(obscurityFromPoemCount(undefined)).toBe(0)
  })

  it("decays on a log scale — المتنبي (519 قصيدة) is nearly not obscure", () => {
    expect(obscurityFromPoemCount(519)).toBeCloseTo(1 - Math.log10(519) / 3, 6)
    expect(obscurityFromPoemCount(519)).toBeLessThan(0.1)
    expect(obscurityFromPoemCount(10)).toBeCloseTo(2 / 3, 6)
  })

  it("the server's obscurity is a floor the log signal may lift", () => {
    expect(scoreObscurity(0.2, 1)).toBe(1)
    expect(scoreObscurity(0.9, 1000)).toBe(0.9)
    expect(scoreObscurity(0.9, undefined)).toBe(0.9)
    expect(scoreObscurity(2, 5)).toBe(1)
  })
})

describe("hint pricing — design-ux.md §4 tier table", () => {
  it("prices come from HINT_COSTS, never from a literal", () => {
    expect(hintCost("poet")).toBe(HINT_COSTS.poet)
    expect(hintCost("first_word")).toBe(HINT_COSTS.first_word)
    expect(hintCost("meter")).toBe(HINT_COSTS.meter)
    expect(hintCost("switch_letter")).toBe(HINT_COSTS.switch_letter)
  })

  it("مبتدئ pays half, شاعر full, فحل double, سيف gets none", () => {
    expect(hintPricing("beginner")).toEqual({ multiplier: 0.5, allowed: true })
    expect(hintPricing("poet").multiplier).toBe(1)
    expect(hintPricing("champion").multiplier).toBe(2)
    expect(hintPricing("sword").allowed).toBe(false)

    expect(pricedHint("poet", "beginner")).toBe(20)
    expect(pricedHint("poet", "poet")).toBe(40)
    expect(pricedHint("poet", "champion")).toBe(80)
  })

  it("hintSpend sums a whole exchange at the tier's price", () => {
    expect(hintSpend(["poet", "meter"], "poet")).toBe(60)
    expect(hintSpend(["poet", "meter"], "beginner")).toBe(30)
    expect(hintSpend([], "champion")).toBe(0)
  })

  it("«أفحمتَ الخصم» is worth 500 (amendment 16)", () => {
    expect(STUMP_BONUS).toBe(SCORING.stumpBonus)
    expect(STUMP_BONUS).toBe(500)
  })
})

describe("وضع التدريب — the flat halving (v2.md §2)", () => {
  it("halves what a بيت earns", () => {
    const plain = awardFor({ streak: 3, msRemaining: 20_000, timerOn: true, obscurity: 0.5 })
    const assisted = awardFor({ streak: 3, msRemaining: 20_000, timerOn: true, obscurity: 0.5, assist: true })
    expect(assisted.total).toBe(Math.round(plain.total * ASSIST.scoreMultiplier))
    expect(assisted.assisted).toBe(true)
    expect(plain.assisted).toBe(false)
  })

  it("leaves the itemisation alone — only the total is halved", () => {
    // The breakdown is what the summary shows; halving `base` would make the
    // screen claim a بيت is worth 50 points, which it is not.
    const a = awardFor({ streak: 10, msRemaining: 0, timerOn: false, obscurity: 0, assist: true })
    expect(a.base).toBe(SCORING.base)
    expect(a.streakBonus).toBe(SCORING.perStreak * SCORING.maxStreakBonus)
    expect(a.total).toBe(Math.round((SCORING.base + a.streakBonus) * ASSIST.scoreMultiplier))
  })

  it("does NOT discount a هَمْس the player bought", () => {
    // Earned points halve; spent points do not, or hints would be cheaper in
    // training mode than in a real duel.
    const a = awardFor({ streak: 1, msRemaining: 0, timerOn: false, obscurity: 0, hintPenalty: 60, assist: true })
    expect(a.hintPenalty).toBe(60)
    expect(a.total).toBe(Math.round(110 * ASSIST.scoreMultiplier) - 60)
  })

  it("halves «أفحمتَ الخصم» too", () => {
    expect(stumpBonusFor(false)).toBe(STUMP_BONUS)
    expect(stumpBonusFor(true)).toBe(Math.round(STUMP_BONUS * ASSIST.scoreMultiplier))
  })

  it("assistScale is the identity when التدريب is off", () => {
    for (const n of [0, 1, 99, 137, 500]) expect(assistScale(false, n)).toBe(n)
    expect(assistScale(true, 137)).toBe(69)
  })

  it("keeps the score an integer", () => {
    for (const streak of [0, 1, 3, 7]) {
      const a = awardFor({ streak, msRemaining: 3_333, timerOn: true, obscurity: 0.37, assist: true })
      expect(Number.isInteger(a.total)).toBe(true)
    }
  })
})
