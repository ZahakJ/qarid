/**
 * الترسانة — what you can ANSWER with, letter by letter (design-ux.md §5,
 * amendments.md §10).
 *
 * The arsenal is not a score. It is an inventory of the 28 opening letters:
 * a مساجلة hands you a letter and asks for a بيت that STARTS on it, so the
 * only أبيات that ever save you are the ones you hold under that letter.
 * Two things fill a cell:
 *
 *   مستعمَل (`used`)     — أبيات you actually played in a duel. Written by
 *                          `duelStore.recordProfile` at the summary, off the
 *                          accepted exchanges, through the same
 *                          `firstLetterOf()` the server chains with.
 *   محفوظ  (`mastered`)  — drill cards on that letter whose interval reached
 *                          21 days. Recomputed from the cards on every write
 *                          by `trainingStore`, never accumulated by hand.
 *
 * Weakness is amendment 10's formula and needs BOTH sides of `/api/meta`'s
 * per-letter counts:
 *
 *     weakness = demand(letter) × (1 − min(supply, 8) / 8)
 *
 * `demand` is how often the corpus ENDS on that letter — i.e. how often an
 * opponent will demand it of you — normalized against the most demanded letter
 * so the number is a 0..1 share and not a raw 300,000. `supply` is what you
 * hold. Eight أبيات on one letter is treated as "covered": past that the letter
 * stops being a way to lose, and the ranking should move on to the next hole.
 */
import { HIJAI_LETTERS, type HijaiLetter } from "../../shared/letters.ts"
import type { Arsenal, ArsenalCell, LetterInfo, TrainingCard } from "../../shared/schema.ts"

/** The denominator of «1 − supply/8» — أبيات past this stop reducing weakness. */
export const SUPPLY_TARGET = 8

/** Under this many أبيات a letter is a hole the new-card intake aims at. */
export const COVERAGE_TARGET = 3

/** An interval this long is محفوظ — the card has survived three weeks. */
export const MASTERED_DAYS = 21

export const EMPTY_CELL: ArsenalCell = { used: 0, mastered: 0, lastAt: null }

export function cellOf(arsenal: Arsenal | undefined, letter: string): ArsenalCell {
  return arsenal?.[letter as HijaiLetter] ?? EMPTY_CELL
}

/** How many drill cards OPEN on each letter — the ones you are learning now. */
export function heldByLetter(cards: Readonly<Record<string, TrainingCard>>): Record<string, number> {
  const held: Record<string, number> = {}
  for (const card of Object.values(cards)) {
    const letter = card.firstLetter
    if (!letter) continue
    held[letter] = (held[letter] ?? 0) + 1
  }
  return held
}

/** Cards on each letter that reached محفوظ — what `arsenal.mastered` mirrors. */
export function masteredByLetter(cards: Readonly<Record<string, TrainingCard>>): Record<string, number> {
  const done: Record<string, number> = {}
  for (const card of Object.values(cards)) {
    const letter = card.firstLetter
    if (!letter || card.interval < MASTERED_DAYS) continue
    done[letter] = (done[letter] ?? 0) + 1
  }
  return done
}

/**
 * `arsenal.mastered` recomputed from the cards, `used` left exactly as it was.
 * Mastery is a FUNCTION of the deck (a lapse takes it away again), so it is
 * derived on every write rather than counted up and drifted.
 */
export function withMastery(arsenal: Arsenal, cards: Readonly<Record<string, TrainingCard>>): Arsenal {
  const done = masteredByLetter(cards)
  const next: Arsenal = { ...arsenal }
  for (const letter of HIJAI_LETTERS) {
    const cell = arsenal[letter]
    const mastered = done[letter] ?? 0
    if (!cell && mastered === 0) continue
    const base = cell ?? EMPTY_CELL
    if (base.mastered === mastered && cell) continue
    next[letter] = { ...base, mastered }
  }
  return next
}

/** What you hold on a letter: أبيات played, plus the cards you are learning. */
export function supplyOf(arsenal: Arsenal | undefined, held: Record<string, number>, letter: string): number {
  return cellOf(arsenal, letter).used + (held[letter] ?? 0)
}

export type LetterStat = {
  letter: HijaiLetter
  used: number
  mastered: number
  /** cards on this letter, whatever their interval */
  held: number
  /** used + held — what «تغطية» and the weakness formula count */
  supply: number
  /** corpus أبيات that END on this letter (amendment 10) */
  demand: number
  /** demand as a 0..1 share of the most demanded letter */
  demandShare: number
  /** 0..1 — how badly this letter can hurt you */
  weakness: number
  lastAt: number | null
}

/**
 * One row per letter, in هجائي order (`shared/letters.ts` owns the order, and
 * the heatmap's 7×4 is that order wrapped).
 */
export function letterStats({
  letters,
  arsenal,
  cards,
}: {
  /** `/api/meta` letters; an empty list means demand is unknown, not zero */
  letters: readonly LetterInfo[] | null
  arsenal: Arsenal
  cards: Readonly<Record<string, TrainingCard>>
}): LetterStat[] {
  const held = heldByLetter(cards)
  const demandOf = new Map<string, number>()
  for (const row of letters ?? []) demandOf.set(row.letter, row.endsWith)
  let maxDemand = 0
  for (const n of demandOf.values()) if (n > maxDemand) maxDemand = n

  return HIJAI_LETTERS.map((letter) => {
    const cell = cellOf(arsenal, letter)
    const heldHere = held[letter] ?? 0
    const supply = cell.used + heldHere
    const demand = demandOf.get(letter) ?? 0
    const demandShare = maxDemand === 0 ? 0 : demand / maxDemand
    const shortfall = 1 - Math.min(supply, SUPPLY_TARGET) / SUPPLY_TARGET
    return {
      letter,
      used: cell.used,
      mastered: cell.mastered,
      held: heldHere,
      supply,
      demand,
      demandShare,
      weakness: demandShare * shortfall,
      lastAt: cell.lastAt,
    }
  })
}

/**
 * The letters to work on, worst first. Ties break on هجائي order so the list
 * does not reshuffle itself between two renders of the same data.
 */
export function weakestLetters(stats: readonly LetterStat[], n = 3): LetterStat[] {
  return [...stats]
    .filter((s) => s.weakness > 0)
    .sort((a, b) => b.weakness - a.weakness)
    .slice(0, n)
}

/** «تغطية 21 من 28 حرفًا» — a letter counts as covered at one بيت. */
export function coverageOf(stats: readonly LetterStat[]): { covered: number; total: number; ratio: number } {
  const total = stats.length
  const covered = stats.filter((s) => s.supply > 0).length
  return { covered, total, ratio: total === 0 ? 0 : covered / total }
}
