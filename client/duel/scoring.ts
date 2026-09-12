/**
 * Duel scoring — pure arithmetic, no clock, no store, no React.
 *
 * design-ux.md §4.3 fixes the shape of an award:
 *
 *   award = 100 + 10·min(streak,10) + (timer ? round(msLeft/1000)·2 : 0)
 *              + round(50·obscurity) − hintsSpentThisExchange
 *
 * amendments.md §16 states the same thing multiplicatively —
 * `base × streakMult + timeBonus + obscurityBonus(log poet poem_count)` —
 * and for `base = 100` the two agree exactly: `100 × (1 + 0.1·k)` IS
 * `100 + 10·k`. The one place they genuinely differ is where `obscurity`
 * comes from: design-server.md §8 derives it from the poet's fame and the
 * بيت's position and puts it on the wire, amendment 16 wants it derived from
 * the log of the poet's `poem_count`. `scoreObscurity()` below takes the MAX
 * of the two, so the server stays the floor and a شاعر with eleven surviving
 * قصائد can still lift a بيت the fame table calls ordinary.
 *
 * v2.md §2 adds one lever on top: وضع التدريب halves what a move EARNS
 * (`ASSIST.scoreMultiplier`), never what it spends — see `assistScale`.
 *
 * Every number the formula uses lives in shared/constants.ts (`SCORING`,
 * `ASSIST`) or shared/schema.ts (`HINT_COSTS`) — this file adds no constants of
 * its own.
 */
import { ASSIST, SCORING } from "../../shared/constants.ts"
import { HINT_COSTS, type HintKind } from "../../shared/schema.ts"

/** What one accepted بيت is worth, itemised so the UI can show the breakdown. */
export type AwardBreakdown = {
  base: number
  streakBonus: number
  timeBonus: number
  obscurityBonus: number
  hintPenalty: number
  /** وضع التدريب was on: the earned half of this award was halved (v2.md §2) */
  assisted: boolean
  total: number
}

export type AwardInput = {
  /** the streak INCLUDING this answer — 1 for the first بيت of a duel */
  streak: number
  /** ms left on the clock when the answer was submitted; ignored when timer is off */
  msRemaining: number
  timerOn: boolean
  /** 0..1 — see `scoreObscurity` */
  obscurity: number
  /** points already committed to hints on THIS exchange (positive number) */
  hintPenalty?: number
  /** وضع التدريب — the rail was there to answer with (v2.md §2) */
  assist?: boolean
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * amendments.md §16's obscurity signal: a شاعر with one surviving قصيدة scores
 * 1, and the bonus decays on a log scale to 0 at 1,000 قصائد. المتنبي (519)
 * lands near 0.09, a one-poem شاعر at 1.0.
 */
export function obscurityFromPoemCount(poemCount: number | null | undefined): number {
  if (poemCount === null || poemCount === undefined || !Number.isFinite(poemCount)) return 0
  const n = Math.max(1, Math.min(1000, Math.trunc(poemCount)))
  return clamp01(1 - Math.log10(n) / 3)
}

/** The server's obscurity is the floor; amendment 16's log signal may raise it. */
export function scoreObscurity(serverObscurity: number, poemCount?: number | null): number {
  return clamp01(Math.max(clamp01(serverObscurity), obscurityFromPoemCount(poemCount)))
}

/**
 * وضع التدريب's flat halving (v2.md §2), applied to what a move EARNS and never
 * to what it costs.
 *
 * A player who answered off the suggestion rail did less of the remembering, so
 * the points are worth half — but a هَمْس they bought is still 60 points gone,
 * and discounting the penalty alongside the award would make hints cheaper in
 * training mode than in a real duel, which is backwards. Rounded, so the score
 * stays an integer everywhere it is shown.
 */
export function assistScale(assist: boolean, points: number): number {
  return assist ? Math.round(points * ASSIST.scoreMultiplier) : points
}

/** The itemised award. `total` may go negative if the player bought hints. */
export function awardFor(input: AwardInput): AwardBreakdown {
  const streak = Number.isFinite(input.streak) ? Math.max(0, Math.trunc(input.streak)) : 0
  const base = SCORING.base
  const streakBonus = SCORING.perStreak * Math.min(streak, SCORING.maxStreakBonus)
  const seconds = input.timerOn ? Math.round(Math.max(0, input.msRemaining) / 1000) : 0
  const timeBonus = seconds * SCORING.perSecondRemaining
  const obscurityBonus = Math.round(SCORING.obscurityBonus * clamp01(input.obscurity))
  const hintPenalty = Math.max(0, Math.trunc(input.hintPenalty ?? 0))
  const assisted = input.assist === true
  const earned = base + streakBonus + timeBonus + obscurityBonus
  return {
    base,
    streakBonus,
    timeBonus,
    obscurityBonus,
    hintPenalty,
    assisted,
    total: assistScale(assisted, earned) - hintPenalty,
  }
}

/** «أفحمتَ الخصم» — the opponent had no reply left (amendments.md §16). */
export const STUMP_BONUS = SCORING.stumpBonus

/** …halved like every other earned point when وضع التدريب is on. */
export function stumpBonusFor(assist: boolean): number {
  return assistScale(assist, STUMP_BONUS)
}

/** Price of one hint, as a positive number of points. */
export function hintCost(kind: HintKind): number {
  return HINT_COSTS[kind]
}

/**
 * design-ux.md §4 sets the tier's hint policy: مبتدئ pays half, فحل pays
 * double, سيف gets none at all. Returned as a multiplier so a caller can both
 * price a button and grey it out.
 */
export type HintPricing = { multiplier: number; allowed: boolean }

export function hintPricing(tier: "beginner" | "poet" | "champion" | "sword"): HintPricing {
  switch (tier) {
    case "beginner":
      return { multiplier: 0.5, allowed: true }
    case "poet":
      return { multiplier: 1, allowed: true }
    case "champion":
      return { multiplier: 2, allowed: true }
    case "sword":
      return { multiplier: 1, allowed: false }
  }
}

/** The price actually charged for `kind` at `tier`, rounded to whole points. */
export function pricedHint(kind: HintKind, tier: "beginner" | "poet" | "champion" | "sword"): number {
  return Math.round(hintCost(kind) * hintPricing(tier).multiplier)
}

/** Total points committed to a list of hints at one tier. */
export function hintSpend(kinds: readonly HintKind[], tier: "beginner" | "poet" | "champion" | "sword"): number {
  return kinds.reduce((sum, k) => sum + pricedHint(k, tier), 0)
}
