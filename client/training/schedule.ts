/**
 * SM-2-lite — the whole scheduling brain of تحفيظ (design-ux.md §5).
 *
 * Pure by construction: no clock, no storage, no network, no `Math.random`.
 * Every function takes `now` and returns a new card; the jitter comes from
 * `rngFrom()` seeded on `due:${id}:${reps}`, so the same card graded the same
 * way lands on the same day on every device and in every test run — the
 * property `schedule.test.ts` pins.
 *
 * The algorithm, exactly as specified:
 *
 *   again  reps = 0, lapses++, ease −= 0.2, due = now + 10 min,
 *          leech at 8 lapses
 *   else   reps++, ease += {hard −0.15, good 0, easy +0.10},
 *          mod = {hard 0.7, good 1, easy 1.3},
 *          interval = reps==1 ? 1 : reps==2 ? 3 : round(interval × ease × mod),
 *          ±10% jitter, due = startOfDay(now) + interval days
 *
 * Two clamps hold everywhere: ease ∈ [1.3, 2.8] and interval ∈ [1, 365].
 *
 * The jitter is applied to WHOLE DAYS. A fractional day would let a card
 * scheduled «tomorrow» at 21:00 come due again at 19:00 the same evening —
 * jitter exists to spread a big pile of 90-day cards across a week, not to
 * reopen today's work.
 */
import { rngFrom } from "../../shared/rng.ts"
import type { Arsenal, CardGrade, TrainingCard } from "../../shared/schema.ts"
import { COVERAGE_TARGET, heldByLetter, supplyOf } from "./arsenal.ts"

export const DAY_MS = 86_400_000
export const AGAIN_MS = 10 * 60_000

export const EASE_START = 2.3
export const EASE_MIN = 1.3
export const EASE_MAX = 2.8
export const INTERVAL_MIN = 1
export const INTERVAL_MAX = 365

/** 8 lapses and the card is a leech — the hub offers replace / delete. */
export const LEECH_LAPSES = 8

/** How many reviews one session puts in front of you, and how many new أبيات. */
export const MAX_DUE = 20
export const MAX_NEW_PER_DAY = 10

/** ease += this, by grade. */
export const EASE_DELTA: Readonly<Record<CardGrade, number>> = {
  again: -0.2,
  hard: -0.15,
  good: 0,
  easy: 0.1,
}

/** interval × ease × this, by grade. */
export const GRADE_MOD: Readonly<Record<CardGrade, number>> = {
  again: 0,
  hard: 0.7,
  good: 1,
  easy: 1.3,
}

export const GRADE_LABEL: Readonly<Record<CardGrade, string>> = {
  again: "من جديد",
  hard: "بصعوبة",
  good: "أصبتُ",
  easy: "سهل",
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

export function clampEase(ease: number): number {
  return clamp(Number(ease.toFixed(4)), EASE_MIN, EASE_MAX)
}

export function clampInterval(days: number): number {
  return clamp(Math.round(days), INTERVAL_MIN, INTERVAL_MAX)
}

/** Local midnight — the day boundary a reader actually lives in. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Local `YYYY-MM-DD`. Never `toISOString()`, which is UTC and rolls at 03:00. */
export function dayKeyOf(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The day before `dayKey`, for the review-streak test. */
export function previousDay(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number)
  if (!y || !m || !d) return dayKey
  return dayKeyOf(new Date(y, m - 1, d).getTime() - DAY_MS)
}

/** ±10% of the interval, deterministic per (card, rep). */
export function jitterFor(id: string, reps: number): number {
  return rngFrom(`due:${id}:${reps}`)() * 0.2 - 0.1
}

/** What a بيت looks like on its way into the deck. */
export type CardSeed = {
  id: string
  baitId?: number | null
  sadr: string
  ajuz: string | null
  poet?: { slug: string; name: string } | null
  poemId?: string | null
  firstLetter?: string | null
  rawiyy?: string | null
}

/** A fresh card: due immediately, because a card you have not seen is due. */
export function newCard(seed: CardSeed, now: number): TrainingCard {
  return {
    id: seed.id,
    baitId: seed.baitId ?? null,
    sadr: seed.sadr,
    ajuz: seed.ajuz,
    poet: seed.poet ?? null,
    poemId: seed.poemId ?? null,
    firstLetter: (seed.firstLetter ?? null) as TrainingCard["firstLetter"],
    rawiyy: (seed.rawiyy ?? null) as TrainingCard["rawiyy"],
    ease: EASE_START,
    interval: 0,
    due: now,
    reps: 0,
    lapses: 0,
    leech: false,
    addedAt: now,
  }
}

/** The one transition. Everything else in this file only chooses an order. */
export function applyGrade(card: TrainingCard, grade: CardGrade, now: number): TrainingCard {
  if (grade === "again") {
    const lapses = card.lapses + 1
    return {
      ...card,
      reps: 0,
      lapses,
      ease: clampEase(card.ease + EASE_DELTA.again),
      // Ten minutes, not tomorrow: a بيت you have just failed is worth one more
      // look before the session ends, and `interval` drops to 0 so the letter
      // stops counting as محفوظ the moment it stops being true.
      interval: 0,
      due: now + AGAIN_MS,
      leech: card.leech || lapses >= LEECH_LAPSES,
    }
  }

  const reps = card.reps + 1
  const ease = clampEase(card.ease + EASE_DELTA[grade])
  const base = reps === 1 ? 1 : reps === 2 ? 3 : Math.round(card.interval * ease * GRADE_MOD[grade])
  const days = clampInterval(base * (1 + jitterFor(card.id, reps)))
  return { ...card, reps, ease, interval: days, due: startOfDay(now) + days * DAY_MS }
}

/** A leech taken back to zero — «استبدل» on the hub. */
export function resetCard(card: TrainingCard, now: number): TrainingCard {
  return { ...card, ease: EASE_START, interval: 0, due: now, reps: 0, lapses: 0, leech: false }
}

export function isDue(card: TrainingCard, now: number): boolean {
  return !card.leech && card.due <= now
}

export function leechesOf(cards: Readonly<Record<string, TrainingCard>>): TrainingCard[] {
  return Object.values(cards)
    .filter((c) => c.leech)
    .sort((a, b) => b.lapses - a.lapses || a.addedAt - b.addedAt)
}

// ── the queue ───────────────────────────────────────────────────────────────

/** A بيت the API offered as new material, before it becomes a card. */
export type QueueCandidate = CardSeed & { fame?: number }

export type QueueInput = {
  cards: Readonly<Record<string, TrainingCard>>
  now: number
  /** أبيات from `/api/train/candidates`, already famous-first */
  candidates?: readonly QueueCandidate[]
  arsenal?: Arsenal
  newIntroducedToday?: number
  maxDue?: number
  maxNew?: number
}

export type QueuePlan = {
  /** card ids in the order the drill shows them */
  queue: string[]
  /** the due half, before interleaving */
  due: string[]
  /** candidates that should be admitted as cards, in intake order */
  fresh: QueueCandidate[]
  leeches: TrainingCard[]
}

/** Anything the no-two-in-a-row rule needs to know about a queue item. */
type Slot = { id: string; poemId: string | null }

/**
 * Never two consecutive أبيات from one قصيدة. Two lines of the same قصيدة share
 * a قافية, a بحر and usually a sentence, so back to back the second one is
 * recall of the first, not of itself. A greedy forward swap keeps the ordering
 * otherwise intact — and when a clash genuinely cannot be avoided (a queue that
 * is all one قصيدة) it is accepted rather than dropping the card.
 */
export function spreadByPoem<T extends Slot>(items: readonly T[]): T[] {
  const rest = [...items]
  const out: T[] = []
  let previous: string | null = null
  while (rest.length > 0) {
    let pick = 0
    if (previous !== null && rest[0]?.poemId === previous) {
      const alt = rest.findIndex((it) => it.poemId !== previous)
      if (alt !== -1) pick = alt
    }
    const [taken] = rest.splice(pick, 1)
    if (!taken) break
    out.push(taken)
    previous = taken.poemId
  }
  return out
}

/**
 * The session plan: everything due, then as much new material as the day's
 * budget allows, ordered so no قصيدة speaks twice in a row.
 *
 * The new-card bias is the whole reason تحفيظ exists next to a duel: a بيت on a
 * letter you already hold eight of teaches you nothing you needed, while ظ
 * (which the corpus demands and you have never once answered) is how the next
 * مساجلة ends. Candidates opening on a letter under `COVERAGE_TARGET` come
 * first; within each half the API's own fame order is preserved, so the أبيات
 * a memoriser should own first are the ones offered first.
 */
export function buildQueue(input: QueueInput): QueuePlan {
  const { cards, now, candidates = [], arsenal = {}, newIntroducedToday = 0 } = input
  const maxDue = input.maxDue ?? MAX_DUE
  const maxNew = Math.max(0, Math.min(input.maxNew ?? MAX_NEW_PER_DAY, MAX_NEW_PER_DAY - newIntroducedToday))

  const dueCards = Object.values(cards)
    .filter((c) => isDue(c, now))
    .sort((a, b) => a.due - b.due || a.addedAt - b.addedAt)
    .slice(0, maxDue)

  const held = heldByLetter(cards)
  const seen = new Set(Object.keys(cards))
  const offered = candidates.filter((c) => !seen.has(c.id))
  const weak: QueueCandidate[] = []
  const rest: QueueCandidate[] = []
  for (const candidate of offered) {
    const letter = candidate.firstLetter
    const thin = letter !== null && letter !== undefined && supplyOf(arsenal, held, letter) < COVERAGE_TARGET
    ;(thin ? weak : rest).push(candidate)
  }
  const byFame = (a: QueueCandidate, b: QueueCandidate) => (b.fame ?? 0) - (a.fame ?? 0)
  const fresh = [...weak.sort(byFame), ...rest.sort(byFame)].slice(0, maxNew)

  const slots: Slot[] = [
    ...dueCards.map((c) => ({ id: c.id, poemId: c.poemId })),
    ...fresh.map((c) => ({ id: c.id, poemId: c.poemId ?? null })),
  ]

  return {
    queue: spreadByPoem(slots).map((s) => s.id),
    due: dueCards.map((c) => c.id),
    fresh,
    leeches: leechesOf(cards),
  }
}

/** How many cards are waiting right now — the hub's «المستحقّة» number. */
export function dueCount(cards: Readonly<Record<string, TrainingCard>>, now: number): number {
  let n = 0
  for (const card of Object.values(cards)) if (isDue(card, now)) n++
  return n
}
