/**
 * «أضِفه إلى التحفيظ» — the seeds, the honest count, and the invariant the
 * import is most likely to break: `qarid:v1:training` HAS TWO WRITERS.
 *
 * A مساجلة writes `arsenal[letter].used` at every summary, while this store
 * owns the cards — so a write that does not merge against what is on disk right
 * now silently erases whatever the duel recorded. The last test here is that
 * merge, driven through the real store against a real (in-memory) Storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PERSIST_KEYS, PERSIST_VERSION, type AlbumEntry, type BaitDto } from "../../shared/schema.ts"
import { importedMessage, memorizeSeeds } from "./memorize.ts"

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

function bait(n: number): BaitDto {
  return {
    id: 1000 + n,
    baytKey: `q${n}:1`,
    poem: { id: `q${n}`, poemId: n, title: null },
    poet: { slug: `poet-${n}`, name: `شاعر ${n}` },
    meter: null,
    era: null,
    position: 1,
    sadr: `صدرٌ ${n}`,
    ajuz: `عجزٌ ${n}`,
    firstLetter: "ص",
    rawiyy: "ن",
    lastLetter: "ن",
    isPartial: false,
  } as unknown as BaitDto
}

function entry(n: number, live = true): AlbumEntry {
  return {
    hFull: String(700000000 + n),
    position: n,
    addedAt: 1_700_000_000_000 + n,
    snapshot: { sadr: `صدرٌ ${n}`, ajuz: `عجزٌ ${n}`, poet: `شاعر ${n}` },
    bait: live ? bait(n) : null,
  }
}

describe("memorizeSeeds", () => {
  it("takes only the أبيات today's artefact still answers", () => {
    const seeds = memorizeSeeds([entry(1), entry(2, false), entry(3)])
    expect(seeds.map((s) => s.id)).toEqual(["q1:1", "q3:1"])
  })

  it("carries the SAME id the drill's own seed does — one card, not two", () => {
    const seeds = memorizeSeeds([entry(4)])
    expect(seeds[0]!.id).toBe(bait(4).baytKey)
    expect(seeds[0]!.baitId).toBe(bait(4).id)
    expect(seeds[0]!.poemId).toBe("q4")
  })

  it("does not offer one بيت twice when two anchors resolve to one copy", () => {
    const twin: AlbumEntry = { ...entry(9), hFull: "700000099" }
    expect(memorizeSeeds([entry(9), twin])).toHaveLength(1)
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
})

describe("the import against the real deck", () => {
  it("adds once, and the second press adds nothing", async () => {
    const { useTraining } = await import("../store/trainingStore.ts")
    const entries = [entry(1), entry(2), entry(3)]
    const first = useTraining.getState().introduce(memorizeSeeds(entries))
    expect(first).toHaveLength(3)
    const second = useTraining.getState().introduce(memorizeSeeds(entries))
    expect(second).toHaveLength(0)
    expect(Object.keys(useTraining.getState().cards)).toHaveLength(3)
  })

  it("does not erase what a مساجلة wrote into the ترسانة while it was away", async () => {
    const { useTraining } = await import("../store/trainingStore.ts")
    const { flushNow } = await import("../persist.ts")
    useTraining.getState().introduce(memorizeSeeds([entry(1)]))
    // `persist.ts` batches; the duel's writer reads what is actually on disk.
    flushNow()

    // The duel's writer, exactly as `duelStore.recordProfile` does it: straight
    // into storage, while this store is not looking.
    const raw = JSON.parse(store.api.getItem(PERSIST_KEYS.training)!) as { v: number; data: Record<string, unknown> }
    expect(raw.v).toBe(PERSIST_VERSION)
    raw.data.arsenal = { ص: { used: 7, mastered: 0, lastAt: 1_700_000_000_000 } }
    store.api.setItem(PERSIST_KEYS.training, JSON.stringify(raw))

    useTraining.getState().reload()
    useTraining.getState().introduce(memorizeSeeds([entry(2), entry(3)]))
    flushNow()

    const after = JSON.parse(store.api.getItem(PERSIST_KEYS.training)!) as {
      data: { arsenal: Record<string, { used: number }>; cards: Record<string, unknown> }
    }
    expect(after.data.arsenal["ص"]!.used).toBe(7)
    expect(Object.keys(after.data.cards)).toHaveLength(3)
  })
})
