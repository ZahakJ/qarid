/**
 * `qarid:v1:training` — the deck, the day, and the ترسانة (design-ux.md §5).
 *
 * The maths is not here. `client/training/schedule.ts` decides when a card is
 * next due and `client/training/arsenal.ts` decides what a letter is worth;
 * this file only holds the deck, moves the day forward, and persists.
 *
 * TWO WRITERS, one slice. `duelStore.recordProfile` writes `arsenal[…].used`
 * at the end of every مساجلة — that is how a duel feeds the ترسانة, and it
 * happens while this store is not mounted. So:
 *
 *   • every train view calls `reload()` on mount, which re-reads the slice out
 *     of localStorage and picks up whatever the duel recorded;
 *   • every write merges against what is on disk RIGHT NOW, taking the larger
 *     `used` of the two. `used` only ever counts up, so the merge is monotone
 *     and a duel finished in another tab cannot be erased by a card graded in
 *     this one.
 *
 * `mastered` is not merged: it is DERIVED from the cards by `withMastery()` on
 * every write, so this store is its only author.
 */
import { create } from "zustand"

import { HIJAI_LETTERS } from "../../shared/letters.ts"
import {
  TrainingSliceSchema,
  type Arsenal,
  type ArsenalCell,
  type CardGrade,
  type TrainingCard,
  type TrainingSlice,
} from "../../shared/schema.ts"
import { withMastery } from "../training/arsenal.ts"
import { applyGrade, dayKeyOf, previousDay, resetCard, type CardSeed } from "../training/schedule.ts"
import { newCard } from "../training/schedule.ts"
import { loadSlice, saveSlice } from "../persist.ts"

export const DEFAULT_TRAINING: TrainingSlice = TrainingSliceSchema.parse({})

type TrainingStore = TrainingSlice & {
  /** re-read the slice from storage (a duel may have written it) */
  reload: () => void
  /** admit new أبيات as cards; returns the cards actually created */
  introduce: (seeds: readonly CardSeed[], now?: number) => TrainingCard[]
  grade: (id: string, grade: CardGrade, now?: number) => void
  /** «استبدل» — a leech taken back to a fresh card */
  restore: (id: string, now?: number) => void
  /** «احذف» — the بيت leaves the deck entirely */
  drop: (id: string) => void
  /** «هذا في ترسانتي» — one more بيت held under this letter */
  claimLetter: (letter: string, now?: number) => void
  reset: () => void
}

function read(): TrainingSlice {
  return loadSlice("training", TrainingSliceSchema, DEFAULT_TRAINING)
}

function bareCell(cell: ArsenalCell | undefined): ArsenalCell {
  return cell ?? { used: 0, mastered: 0, lastAt: null }
}

/** `used` and `lastAt` take the larger of the two; `mastered` is ours. */
function mergeArsenal(stored: Arsenal, mine: Arsenal): Arsenal {
  const out: Arsenal = {}
  for (const letter of HIJAI_LETTERS) {
    const a = stored[letter]
    const b = mine[letter]
    if (!a && !b) continue
    const x = bareCell(a)
    const y = bareCell(b)
    out[letter] = {
      used: Math.max(x.used, y.used),
      mastered: y.mastered,
      lastAt: Math.max(x.lastAt ?? 0, y.lastAt ?? 0) || null,
    }
  }
  return out
}

/** The slice without the verbs — what actually goes to localStorage. */
function data(s: TrainingSlice): TrainingSlice {
  return {
    cards: s.cards,
    dayKey: s.dayKey,
    newIntroducedToday: s.newIntroducedToday,
    arsenal: s.arsenal,
    session: s.session,
    reviewStreak: s.reviewStreak,
    lastReviewDay: s.lastReviewDay,
  }
}

/** Roll the day over: a new local day zeroes the new-card budget. */
function rolled(slice: TrainingSlice, now: number): TrainingSlice {
  const today = dayKeyOf(now)
  if (slice.dayKey === today) return slice
  return { ...slice, dayKey: today, newIntroducedToday: 0 }
}

export const useTraining = create<TrainingStore>()((set, get) => {
  /** Write-through: derive mastery, merge the duel's `used`, persist, publish. */
  const commit = (next: TrainingSlice): TrainingSlice => {
    const arsenal = mergeArsenal(read().arsenal, withMastery(next.arsenal, next.cards))
    const merged = { ...next, arsenal }
    saveSlice("training", data(merged))
    set(merged)
    return merged
  }

  return {
    ...rolled(read(), Date.now()),

    reload: () => {
      const slice = rolled(read(), Date.now())
      const arsenal = withMastery(slice.arsenal, slice.cards)
      set({ ...slice, arsenal })
    },

    introduce: (seeds, now = Date.now()) => {
      const cur = rolled(get(), now)
      const made: TrainingCard[] = []
      const cards = { ...cur.cards }
      for (const seed of seeds) {
        if (cards[seed.id]) continue
        const card = newCard(seed, now)
        cards[card.id] = card
        made.push(card)
      }
      if (made.length === 0) {
        if (cur !== get()) commit(cur)
        return []
      }
      commit({ ...cur, cards, newIntroducedToday: cur.newIntroducedToday + made.length })
      return made
    },

    grade: (id, grade, now = Date.now()) => {
      const cur = rolled(get(), now)
      const card = cur.cards[id]
      if (!card) return
      const today = dayKeyOf(now)
      // The streak counts DAYS with a review in them, so it is decided once per
      // day by the first card graded — never once per card.
      const streak =
        cur.lastReviewDay === today
          ? cur.reviewStreak
          : cur.lastReviewDay === previousDay(today)
            ? cur.reviewStreak + 1
            : 1
      commit({
        ...cur,
        cards: { ...cur.cards, [id]: applyGrade(card, grade, now) },
        reviewStreak: streak,
        lastReviewDay: today,
      })
    },

    restore: (id, now = Date.now()) => {
      const cur = get()
      const card = cur.cards[id]
      if (!card) return
      commit({ ...cur, cards: { ...cur.cards, [id]: resetCard(card, now) } })
    },

    drop: (id) => {
      const cur = get()
      if (!cur.cards[id]) return
      const cards = { ...cur.cards }
      delete cards[id]
      commit({ ...cur, cards })
    },

    claimLetter: (letter, now = Date.now()) => {
      const cur = get()
      const key = letter as keyof Arsenal
      const cell = bareCell(cur.arsenal[key])
      commit({ ...cur, arsenal: { ...cur.arsenal, [key]: { ...cell, used: cell.used + 1, lastAt: now } } })
    },

    reset: () => commit(DEFAULT_TRAINING),
  }
})

/** Non-reactive read, for effects and the drill's queue builder. */
export function trainingSlice(): TrainingSlice {
  return data(useTraining.getState())
}
