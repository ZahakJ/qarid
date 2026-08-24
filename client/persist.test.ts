import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsSliceSchema, type SettingsSlice } from "../shared/schema.ts"
import { clearSlice, flushNow, loadSlice, saveSlice, sliceKey } from "./persist.ts"

/** Minimal in-memory Storage — node has no localStorage. */
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
const DEFAULTS: SettingsSlice = SettingsSliceSchema.parse({})

beforeEach(() => {
  store = makeStorage()
  vi.stubGlobal("localStorage", store.api)
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  flushNow()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("keys", () => {
  it("namespaces every slice under qarid:v1:", () => {
    expect(sliceKey("settings")).toBe("qarid:v1:settings")
    expect(sliceKey("duel")).toBe("qarid:v1:duel")
    expect(sliceKey("favorites")).toBe("qarid:v1:favorites")
  })
})

describe("loadSlice", () => {
  it("returns the fallback when nothing is stored", () => {
    expect(loadSlice("settings", SettingsSliceSchema, DEFAULTS)).toEqual(DEFAULTS)
  })

  it("round-trips a written slice", () => {
    const next: SettingsSlice = { ...DEFAULTS, verseSize: "lg", showRawiyy: true }
    saveSlice("settings", next)
    flushNow()
    expect(loadSlice("settings", SettingsSliceSchema, DEFAULTS)).toEqual(next)
  })

  it("stores a {v, data} envelope", () => {
    saveSlice("settings", DEFAULTS)
    flushNow()
    const raw = store.map.get("qarid:v1:settings")
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)).toEqual({ v: 1, data: DEFAULTS })
  })

  it("backs up unreadable JSON and falls back instead of throwing", () => {
    store.map.set("qarid:v1:settings", "{not json")
    expect(loadSlice("settings", SettingsSliceSchema, DEFAULTS)).toEqual(DEFAULTS)
    expect(store.map.get("qarid:corrupt-backup:settings")).toBe("{not json")
  })

  it("backs up a payload that fails the schema", () => {
    const bad = JSON.stringify({ v: 1, data: { verseSize: "enormous", tashkeel: "yes" } })
    store.map.set("qarid:v1:settings", bad)
    expect(loadSlice("settings", SettingsSliceSchema, DEFAULTS)).toEqual(DEFAULTS)
    expect(store.map.get("qarid:corrupt-backup:settings")).toBe(bad)
  })

  it("never destroys the corrupt payload — the live key is left alone", () => {
    const bad = JSON.stringify({ v: 1, data: null })
    store.map.set("qarid:v1:settings", bad)
    loadSlice("settings", SettingsSliceSchema, DEFAULTS)
    expect(store.map.get("qarid:v1:settings")).toBe(bad)
  })

  it("survives storage being unavailable (private mode)", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new DOMException("denied")
      },
      setItem() {
        throw new DOMException("denied")
      },
      removeItem() {
        throw new DOMException("denied")
      },
    } as unknown as Storage)
    expect(loadSlice("settings", SettingsSliceSchema, DEFAULTS)).toEqual(DEFAULTS)
    expect(() => {
      saveSlice("settings", DEFAULTS)
      flushNow()
    }).not.toThrow()
  })
})

describe("saveSlice debounce", () => {
  it("waits 300 ms and coalesces writes", () => {
    vi.useFakeTimers()
    saveSlice("settings", { ...DEFAULTS, verseSize: "sm" })
    saveSlice("settings", { ...DEFAULTS, verseSize: "lg" })
    expect(store.map.has("qarid:v1:settings")).toBe(false)
    vi.advanceTimersByTime(299)
    expect(store.map.has("qarid:v1:settings")).toBe(false)
    vi.advanceTimersByTime(1)
    expect(JSON.parse(store.map.get("qarid:v1:settings")!).data.verseSize).toBe("lg")
  })

  it("flushNow writes immediately and cancels the pending timer", () => {
    vi.useFakeTimers()
    saveSlice("profile", { hello: 1 })
    flushNow()
    expect(JSON.parse(store.map.get("qarid:v1:profile")!).data).toEqual({ hello: 1 })
    store.map.delete("qarid:v1:profile")
    vi.advanceTimersByTime(1000)
    expect(store.map.has("qarid:v1:profile")).toBe(false)
  })

  it("persists slices independently", () => {
    saveSlice("settings", DEFAULTS)
    saveSlice("profile", { gamesPlayed: 3 })
    flushNow()
    expect(store.map.has("qarid:v1:settings")).toBe(true)
    expect(store.map.has("qarid:v1:profile")).toBe(true)
  })
})

describe("clearSlice", () => {
  it("removes the key and drops a pending write", () => {
    vi.useFakeTimers()
    saveSlice("settings", DEFAULTS)
    clearSlice("settings")
    vi.advanceTimersByTime(1000)
    expect(store.map.has("qarid:v1:settings")).toBe(false)
  })
})
