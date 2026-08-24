/**
 * The corpus cache. In memory ONLY: 255K poems never go near localStorage
 * (CLAUDE.md invariant), and a قصيدة you read two minutes ago is worth a
 * re-render, not a persistence layer.
 *
 * Three LRUs at the sizes design-ux.md §6 fixes — poems 200, poets 400,
 * facets 40 — plus the single `/api/meta` payload, which every view wants and
 * which changes only when the artefact is rebuilt.
 *
 * Request dedupe already lives in `client.ts` (one in-flight promise per
 * method+path), so these loaders only have to answer "have I already got it?".
 * A response fetched under an AbortSignal is still cached: it arrived, and the
 * next reader should not have to ask again.
 */
import { create } from "zustand"
import type {
  FacetsResponse,
  MetaResponse,
  PoemDetailResponse,
  PoetPageResponse,
  SimilarPoemsResponse,
} from "../../shared/schema.ts"
import * as api from "../api/queries.ts"

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
    delete: (k: string) => m.delete(k),
    clear: () => m.clear(),
    get size() {
      return m.size
    },
  }
}

export type Lru<V> = ReturnType<typeof createLru<V>>

type LibraryStore = {
  poems: Lru<PoemDetailResponse>
  poets: Lru<PoetPageResponse>
  facets: Lru<FacetsResponse>
  /** amendments.md §9 — «قصائد على الوزن والقافية», keyed poemId|limit */
  similar: Lru<SimilarPoemsResponse>
  meta: MetaResponse | null
  setMeta: (m: MetaResponse) => void
  /** drop everything — test seam, and the only honest response to a rebuild */
  clear: () => void
}

export const useLibrary = create<LibraryStore>()((set, get) => ({
  poems: createLru<PoemDetailResponse>(200),
  poets: createLru<PoetPageResponse>(400),
  facets: createLru<FacetsResponse>(40),
  similar: createLru<SimilarPoemsResponse>(40),
  meta: null,
  setMeta: (meta) => set({ meta }),
  clear: () => {
    const s = get()
    s.poems.clear()
    s.poets.clear()
    s.facets.clear()
    s.similar.clear()
    set({ meta: null })
  },
}))

// ── loaders ────────────────────────────────────────────────────────────────

/** `/api/meta`, fetched once per session. */
export async function loadMeta(signal?: AbortSignal): Promise<MetaResponse> {
  const cached = useLibrary.getState().meta
  if (cached) return cached
  const meta = await api.getMeta({ signal })
  useLibrary.getState().setMeta(meta)
  return meta
}

/**
 * The قصيدة plus its first page of أبيات. `force` re-fetches past the cache,
 * which nothing needs yet but a reload button will.
 */
export async function loadPoem(publicId: string, signal?: AbortSignal, force = false): Promise<PoemDetailResponse> {
  const { poems } = useLibrary.getState()
  if (!force) {
    const hit = poems.get(publicId)
    if (hit) return hit
  }
  const poem = await api.getPoem(publicId, {}, { signal })
  poems.set(publicId, poem)
  return poem
}

/** Cache an extended page set back onto the poem, so re-entry starts warm. */
export function cachePoemBaits(publicId: string, baits: PoemDetailResponse["baits"]): void {
  const { poems } = useLibrary.getState()
  const hit = poems.get(publicId)
  if (!hit || baits.length <= hit.baits.length) return
  poems.set(publicId, { ...hit, baits })
}

export async function loadSimilarPoems(
  publicId: string,
  limit = 8,
  signal?: AbortSignal,
): Promise<SimilarPoemsResponse> {
  const { similar } = useLibrary.getState()
  const key = `${publicId}|${limit}`
  const hit = similar.get(key)
  if (hit) return hit
  const res = await api.getSimilarPoems(publicId, limit, { signal })
  similar.set(key, res)
  return res
}

export async function loadPoet(slug: string, signal?: AbortSignal): Promise<PoetPageResponse> {
  const { poets } = useLibrary.getState()
  const hit = poets.get(slug)
  if (hit) return hit
  const poet = await api.getPoet(slug, { signal })
  poets.set(slug, poet)
  return poet
}

export async function loadFacets(
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<FacetsResponse> {
  const { facets } = useLibrary.getState()
  const key = JSON.stringify(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  const hit = facets.get(key)
  if (hit) return hit
  const res = await api.getFacets(params, { signal })
  facets.set(key, res)
  return res
}
