/**
 * STUB (Phase 2/4). Persisted slice `qarid:v1:favorites` — favorites are
 * DENORMALIZED (sadr, ajuz, poet, poemId) so a saved بيت still renders with the
 * server down; `collections` are named buckets over those keys.
 */
import { create } from "zustand"

type CollectionsStore = {
  favorites: unknown[]
  collections: unknown[]
  /** TODO(Phase 2): add/remove/isFavorite + persist wiring. */
  reset: () => void
}

export const useCollections = create<CollectionsStore>()((set) => ({
  favorites: [],
  collections: [],
  reset: () => set({ favorites: [], collections: [] }),
}))
