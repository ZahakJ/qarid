/**
 * STUB (Phase 2). In-memory corpus cache — poems LRU 200, poets 400, facets 40,
 * plus in-flight dedupe. Deliberately NOT persisted: 255K poems never go near
 * localStorage (CLAUDE.md invariant).
 */
import { create } from "zustand"

/** Insertion-ordered Map used as an LRU; get() re-inserts to mark recency. */
export function createLru<V>(cap: number) {
  const m = new Map<string, V>()
  return {
    get(k: string): V | undefined {
      const v = m.get(k)
      if (v !== undefined) {
        m.delete(k)
        m.set(k, v)
      }
      return v
    },
    set(k: string, v: V): void {
      if (m.has(k)) m.delete(k)
      m.set(k, v)
      while (m.size > cap) {
        const oldest = m.keys().next().value
        if (oldest === undefined) break
        m.delete(oldest)
      }
    },
    has: (k: string) => m.has(k),
    clear: () => m.clear(),
    get size() {
      return m.size
    },
  }
}

type LibraryStore = {
  poems: ReturnType<typeof createLru<unknown>>
  poets: ReturnType<typeof createLru<unknown>>
  facets: ReturnType<typeof createLru<unknown>>
  /** TODO(Phase 2): meta from /api/meta — meters, eras, themes, letters. */
  meta: unknown | null
  setMeta: (m: unknown) => void
}

export const useLibrary = create<LibraryStore>()((set) => ({
  poems: createLru<unknown>(200),
  poets: createLru<unknown>(400),
  facets: createLru<unknown>(40),
  meta: null,
  setMeta: (meta) => set({ meta }),
}))
