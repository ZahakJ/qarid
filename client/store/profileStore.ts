/**
 * STUB (Phase 3). Persisted slice `qarid:v1:profile` — gamesPlayed,
 * abyatPlayed, bestStreak, bestScore, poetsMet, dailyResults, reviewStreak,
 * firstSeenAt. `poetsMet` powers the retention mechanic on the duel summary.
 */
import { create } from "zustand"

type ProfileStore = {
  gamesPlayed: number
  bestStreak: number
  /** TODO(Phase 3): the rest of the slice + persist wiring. */
  reset: () => void
}

export const useProfile = create<ProfileStore>()((set) => ({
  gamesPlayed: 0,
  bestStreak: 0,
  reset: () => set({ gamesPlayed: 0, bestStreak: 0 }),
}))
