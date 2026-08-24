/**
 * STUB (Phase 4). Persisted slice `qarid:v1:training` — cards, dayKey,
 * newIntroducedToday, arsenal{letter:{used,mastered,lastAt}}, session.
 * Scheduling maths lives in client/training/schedule.ts (pure, tested).
 */
import { create } from "zustand"

type TrainingStore = {
  /** TODO(Phase 4): Card[] + arsenal, loaded through persist.loadSlice. */
  cards: unknown[]
  dayKey: string | null
  reset: () => void
}

export const useTraining = create<TrainingStore>()((set) => ({
  cards: [],
  dayKey: null,
  reset: () => set({ cards: [], dayKey: null }),
}))
