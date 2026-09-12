/**
 * `qarid:v1:favorites` — the ♥ and the named مجموعات.
 *
 * DENORMALIZED on purpose (design-ux.md §6, SavedBaitSchema): a saved بيت keeps
 * its own صدر/عجز/شاعر, so #/favorites renders with the server down, survives a
 * corpus rebuild that renumbers `baits.id`, and never needs the 255K-poem
 * corpus anywhere near localStorage.
 *
 * `baytKey` (`${publicPoemId}:${position}`) is the identity — not `baitId`,
 * which is a build-local rowid. It comes off the wire on every بيت-bearing
 * response and is built by `baytKey()` in shared/arabic.ts, never by a template
 * literal here.
 */
import { create } from "zustand"
import {
  CollectionSchema,
  FavoritesSliceSchema,
  SavedBaitSchema,
  type BaitDto,
  type Collection,
  type FavoritesSlice,
  type SavedBait,
} from "../../shared/schema.ts"
import { loadSlice, saveSlice } from "../persist.ts"

export const DEFAULT_FAVORITES: FavoritesSlice = FavoritesSliceSchema.parse({})

type CollectionsStore = FavoritesSlice & {
  /** ♥ on / off. Returns the state the بيت ended in. */
  toggle: (bait: SavedBaitInput) => boolean
  add: (bait: SavedBaitInput) => void
  remove: (baytKey: string) => void
  isFavorite: (baytKey: string) => boolean
  setNote: (baytKey: string, note: string | null) => void
  createCollection: (name: string) => Collection | null
  renameCollection: (id: string, name: string) => void
  deleteCollection: (id: string) => void
  /** membership toggle; a بيت may sit in several مجموعات */
  toggleIn: (collectionId: string, baytKey: string) => void
  reset: () => void
}

/** What a view hands the store — everything else is defaulted by the schema. */
export type SavedBaitInput = {
  baytKey: string
  baitId?: number | null
  sadr: string
  ajuz?: string | null
  poemId?: string | null
  poemTitle?: string | null
  poet?: { slug: string; name: string } | null
  meter?: { slug: string; name: string; variant?: string | null } | null
  note?: string | null
}

/** A BaitDto plus its قصيدة title → the denormalized row we persist. */
export function savedFromBait(bait: BaitDto, poemTitle?: string | null): SavedBaitInput {
  return {
    baytKey: bait.baytKey,
    baitId: bait.id,
    sadr: bait.sadr,
    ajuz: bait.ajuz,
    poemId: bait.poem.id,
    poemTitle: poemTitle ?? bait.poem.title,
    poet: bait.poet,
    meter: bait.meter,
  }
}

function normalize(input: SavedBaitInput): SavedBait | null {
  const parsed = SavedBaitSchema.safeParse({
    ...input,
    meter: input.meter ? { variant: null, ...input.meter } : null,
    savedAt: Date.now(),
  })
  if (!parsed.success) {
    console.warn("qarid: refusing to save an unparseable بيت", parsed.error)
    return null
  }
  return parsed.data
}

function data(s: FavoritesSlice): FavoritesSlice {
  return { favorites: s.favorites, collections: s.collections }
}

/** Collection ids are opaque and local; time + a short random tail is enough. */
function newId(): string {
  return `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

export const useCollections = create<CollectionsStore>()((set, get) => ({
  ...loadSlice("favorites", FavoritesSliceSchema, DEFAULT_FAVORITES),

  isFavorite: (baytKey) => get().favorites.some((f) => f.baytKey === baytKey),

  add: (input) => {
    const row = normalize(input)
    if (!row) return
    const rest = get().favorites.filter((f) => f.baytKey !== row.baytKey)
    // newest first — #/favorites reads as a reverse-chronological مختارات
    set({ favorites: [row, ...rest] })
  },

  remove: (baytKey) =>
    set((s) => ({
      favorites: s.favorites.filter((f) => f.baytKey !== baytKey),
      collections: s.collections.map((c) =>
        c.baytKeys.includes(baytKey) ? { ...c, baytKeys: c.baytKeys.filter((k) => k !== baytKey), updatedAt: Date.now() } : c,
      ),
    })),

  toggle: (input) => {
    if (get().isFavorite(input.baytKey)) {
      get().remove(input.baytKey)
      return false
    }
    get().add(input)
    return true
  },

  setNote: (baytKey, note) =>
    set((s) => ({
      favorites: s.favorites.map((f) => (f.baytKey === baytKey ? { ...f, note: note && note.trim() ? note.trim().slice(0, 500) : null } : f)),
    })),

  createCollection: (name) => {
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) return null
    const now = Date.now()
    const parsed = CollectionSchema.safeParse({ id: newId(), name: trimmed, baytKeys: [], createdAt: now, updatedAt: now })
    if (!parsed.success) return null
    set((s) => ({ collections: [...s.collections, parsed.data] }))
    return parsed.data
  },

  renameCollection: (id, name) => {
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) return
    set((s) => ({
      collections: s.collections.map((c) => (c.id === id ? { ...c, name: trimmed, updatedAt: Date.now() } : c)),
    }))
  },

  deleteCollection: (id) => set((s) => ({ collections: s.collections.filter((c) => c.id !== id) })),

  toggleIn: (collectionId, baytKey) =>
    set((s) => ({
      collections: s.collections.map((c) => {
        if (c.id !== collectionId) return c
        const has = c.baytKeys.includes(baytKey)
        return {
          ...c,
          baytKeys: has ? c.baytKeys.filter((k) => k !== baytKey) : [...c.baytKeys, baytKey],
          updatedAt: Date.now(),
        }
      }),
    })),

  reset: () => set(DEFAULT_FAVORITES),
}))

useCollections.subscribe((s) => saveSlice("favorites", data(s)))

/** The saved أبيات of one collection, in the collection's own order. */
export function baitsOf(slice: FavoritesSlice, collectionId: string | undefined): SavedBait[] {
  if (!collectionId) return slice.favorites
  const c = slice.collections.find((x) => x.id === collectionId)
  if (!c) return []
  const byKey = new Map(slice.favorites.map((f) => [f.baytKey, f] as const))
  return c.baytKeys.map((k) => byKey.get(k)).filter((f): f is SavedBait => f !== undefined)
}
