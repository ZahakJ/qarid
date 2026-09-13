/**
 * «أضِفه إلى التحفيظ» — the gathering, the seeds, the honest count, and the
 * invariant the import is most likely to break: `qarid:v1:training` HAS TWO
 * WRITERS.
 *
 * A مساجلة writes `arsenal[letter].used` at every summary, while this store
 * owns the cards — so a write that does not merge against what is on disk right
 * now silently erases whatever the duel recorded. The last test here is that
 * merge, driven through the real store against a real (in-memory) Storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  PERSIST_KEYS,
  PERSIST_VERSION,
  type AlbumBaitEntry,
  type AlbumPoemEntry,
  type BaitDto,
  type PoemSummary,
} from "../../shared/schema.ts"
import { gatherAlbumBaits, importedMessage, memorizeSeeds } from "./memorize.ts"

/** Minimal in-memory Storage — node has no localStorage (persist.test.ts's). */
function makeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    api: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size
      },
    } as unknown as Storage,
  }
}

let store: ReturnType<typeof makeStorage>

beforeEach(() => {
  store = makeStorage()
  vi.stubGlobal("localStorage", store.api)
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function bait(n: number, position = 1): BaitDto {
  return {
    id: 1000 + n * 10 + position,
    baytKey: `q${n}:${position}`,
    poem: { id: `q${n}`, poemId: n, title: null },
    poet: { slug: `poet-${n}`, name: `شاعر ${n}` },
    meter: null,
    era: null,
    position,
    sadr: `صدرٌ ${n}`,
    ajuz: `عجزٌ ${n}`,
    firstLetter: "ص",
    rawiyy: "ن",
    lastLetter: "ن",
    isPartial: false,
  } as unknown as BaitDto
}

function baitEntry(n: number, live = true): AlbumBaitEntry {
  return {
    kind: "bait",
    anchor: String(700000000 + n),
    position: n,
    addedAt: 1_700_000_000_000 + n,
    snapshot: { sadr: `صدرٌ ${n}`, ajuz: `عجزٌ ${n}`, poet: `شاعر ${n}` },
    bait: live ? bait(n) : null,
  }
}

function poemEntry(n: number, baitCount: number, live = true): AlbumPoemEntry {
  const poem = {
    id: `q${n}`,
    title: `قصيدة ${n}`,
    poet: { slug: `poet-${n}`, name: `شاعر ${n}` },
    meter: null,
    theme: null,
    era: null,
    langType: null,
    rhyme: null,
    rhymeShare: null,
    firstLetter: null,
    baitCount,
    hasTashkeel: false,
    previewSadr: `صدرٌ ${n}`,
    previewAjuz: `عجزٌ ${n}`,
  } as unknown as PoemSummary
  return {
    kind: "poem",
    anchor: `p${800000000 + n}`,
    position: n,
    addedAt: 1_700_000_000_000 + n,
    snapshot: { title: `قصيدة ${n}`, sadr: `صدرٌ ${n}`, ajuz: `عجزٌ ${n}`, poet: `شاعر ${n}`, baitCount },
    poem: live ? poem : null,
  }
}

/** A table standing in for `getPoemBaits`: قصيدة q<n> has as many أبيات as asked. */
function fetcherOf(counts: Record<string, number>) {
  const calls: Array<{ id: string; limit: number }> = []
  const fetch = async (id: string, limit: number) => {
    calls.push({ id, limit })
    const n = Number(id.slice(1))
    return Array.from({ length: Math.min(limit, counts[id] ?? 0) }, (_, i) => bait(n, i + 1))
  }
  return { fetch, calls }
}

describe("gatherAlbumBaits", () => {
  it("opens each قصيدة into its أبيات and keeps the shelf's order", async () => {
    const { fetch } = fetcherOf({ q2: 3 })
    const { baits, left } = await gatherAlbumBaits([baitEntry(1), poemEntry(2, 3), baitEntry(3)], fetch)
    expect(baits.map((b) => b.baytKey)).toEqual(["q1:1", "q2:1", "q2:2", "q2:3", "q3:1"])
    expect(left).toBe(0)
  })

  it("takes only the entries today's artefact still answers", async () => {
    const { fetch, calls } = fetcherOf({ q2: 3 })
    const { baits } = await gatherAlbumBaits([baitEntry(1, false), poemEntry(2, 3, false), baitEntry(3)], fetch)
    expect(baits.map((b) => b.baytKey)).toEqual(["q3:1"])
    // A dead قصيدة is never fetched: there is no id to fetch it by.
    expect(calls).toEqual([])
  })

  it("stops at the cap, asks for no more than fits, and counts what it left", async () => {
    const { fetch, calls } = fetcherOf({ q1: 40, q2: 40 })
    const { baits, left } = await gatherAlbumBaits([poemEntry(1, 40), poemEntry(2, 40), baitEntry(3)], fetch, 50)
    expect(baits).toHaveLength(50)
    expect(baits[49]!.baytKey).toBe("q2:10")
    // The second قصيدة was asked for exactly the ten that fit, not for forty.
    expect(calls).toEqual([
      { id: "q1", limit: 40 },
      { id: "q2", limit: 10 },
    ])
    // 30 of q2 and the single بيت after it.
    expect(left).toBe(31)
  })
})

describe("memorizeSeeds", () => {
  it("carries the SAME id the drill's own seed does — one card, not two", () => {
    const seeds = memorizeSeeds([bait(4)])
    expect(seeds[0]!.id).toBe(bait(4).baytKey)
    expect(seeds[0]!.baitId).toBe(bait(4).id)
    expect(seeds[0]!.poemId).toBe("q4")
  })

  it("does not offer one بيت twice when a shelf reaches it twice", () => {
    // The same بيت as a single entry and inside its own قصيدة.
    expect(memorizeSeeds([bait(9), bait(9)])).toHaveLength(1)
  })
})

describe("the sentence it reports", () => {
  it("says the honest split, and counts the معدود", () => {
    expect(importedMessage(24, 6)).toBe("أُضيف 24 بيتًا، و6 أبيات عندك من قبل")
    expect(importedMessage(2, 1)).toBe("أُضيف بيتان، وبيت واحد عندك من قبل")
    expect(importedMessage(5, 0)).toBe("أُضيف 5 أبيات إلى التحفيظ")
  })

  it("has a sentence for each of the two nothings", () => {
    expect(importedMessage(0, 12)).toBe("كلّ أبيات هذا الديوان في تحفيظك أصلًا")
    expect(importedMessage(0, 0)).toBe("لا أبيات هنا تصلح للتحفيظ")
  })

  it("says what the cap left on the shelf, and never hides it", () => {
    expect(importedMessage(300, 0, 31)).toBe("أُضيف 300 بيتًا إلى التحفيظ — وبقي 31 بيتًا خارج الحدّ")
    expect(importedMessage(0, 300, 2)).toBe("كلّ أبيات هذا الديوان في تحفيظك أصلًا — وبقي بيتان خارج الحدّ")
  })
})

describe("the import against the real deck", () => {
  it("adds once, and the second press adds nothing", async () => {
    const { useTraining } = await import("../store/trainingStore.ts")
    const baits = [bait(1), bait(2), bait(3)]
    const first = useTraining.getState().introduce(memorizeSeeds(baits))
    expect(first).toHaveLength(3)
    const second = useTraining.getState().introduce(memorizeSeeds(baits))
    expect(second).toHaveLength(0)
    expect(Object.keys(useTraining.getState().cards)).toHaveLength(3)
  })

  it("does not erase what a مساجلة wrote into the ترسانة while it was away", async () => {
    const { useTraining } = await import("../store/trainingStore.ts")
    const { flushNow } = await import("../persist.ts")
    useTraining.getState().introduce(memorizeSeeds([bait(1)]))
    // `persist.ts` batches; the duel's writer reads what is actually on disk.
    flushNow()

    // The duel's writer, exactly as `duelStore.recordProfile` does it: straight
    // into storage, while this store is not looking.
    const raw = JSON.parse(store.api.getItem(PERSIST_KEYS.training)!) as { v: number; data: Record<string, unknown> }
    expect(raw.v).toBe(PERSIST_VERSION)
    raw.data.arsenal = { ص: { used: 7, mastered: 0, lastAt: 1_700_000_000_000 } }
    store.api.setItem(PERSIST_KEYS.training, JSON.stringify(raw))

    useTraining.getState().reload()
    useTraining.getState().introduce(memorizeSeeds([bait(2), bait(3)]))
    flushNow()

    const after = JSON.parse(store.api.getItem(PERSIST_KEYS.training)!) as {
      data: { arsenal: Record<string, { used: number }>; cards: Record<string, unknown> }
    }
    expect(after.data.arsenal["ص"]!.used).toBe(7)
    expect(Object.keys(after.data.cards)).toHaveLength(3)
  })
})
