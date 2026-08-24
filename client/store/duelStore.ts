/**
 * STUB (Phase 3). Persisted slice `qarid:v1:duel` — config, seed, phase,
 * required letter + provenance, exchanges, usedKeys, score/lives/streak,
 * wall-clock deadline. The reducer lives in client/duel/machine.ts; this store
 * only holds its state and dispatches into it (design-ux.md §4).
 */
import { create } from "zustand"

export type DuelPhase =
  | "idle"
  | "dealing"
  | "reciting"
  | "awaiting"
  | "verifying"
  | "disambiguating"
  | "rejected"
  | "penalising"
  | "accepted"
  | "computerThinking"
  | "summary"
  | "failed"

type DuelStore = {
  phase: DuelPhase
  /** TODO(Phase 3): full DuelState from shared/schema.ts + machine.ts. */
  reset: () => void
}

export const useDuel = create<DuelStore>()((set) => ({
  phase: "idle",
  reset: () => set({ phase: "idle" }),
}))
