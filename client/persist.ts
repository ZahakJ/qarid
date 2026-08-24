/**
 * Hand-rolled localStorage persistence (ported from daedalus/src/persist.ts).
 *
 * Each slice is stored independently under `qarid:v<N>:<slice>` as
 * `{ v, data }`; loads run the migration chain then a Zod safeParse. Corrupt
 * payloads are BACKED UP to `qarid:corrupt-backup:<slice>`, never destroyed.
 * Writes are debounced 300 ms; `flushNow()` runs on visibilitychange → hidden.
 *
 * The slice names, their keys, the version and the migration chain all come
 * from shared/schema.ts — this module owns the mechanism, never the shapes.
 * The 255K-poem corpus never comes near localStorage (CLAUDE.md invariant):
 * only settings, duel, training, profile and denormalized favorites do.
 */
import type { z } from "zod"
import { MIGRATIONS, PERSIST_KEYS, PERSIST_VERSION, type PersistSlice } from "../shared/schema.ts"

const PREFIX = "qarid"

/** `qarid:v1:settings` etc. — the literal keys declared in shared/schema.ts. */
export function sliceKey(slice: PersistSlice): string {
  return PERSIST_KEYS[slice]
}

function backupKey(slice: PersistSlice): string {
  return `${PREFIX}:corrupt-backup:${slice}`
}

function backup(slice: PersistSlice, raw: string): void {
  try {
    localStorage.setItem(backupKey(slice), raw)
  } catch {
    /* quota or unavailable — the fallback still applies */
  }
}

/**
 * Read one slice. Anything that is not exactly the expected shape — stale
 * version with no migration path, hand-edited JSON, truncated write — is
 * backed up and replaced by `fallback`. Never throws.
 */
export function loadSlice<T>(slice: PersistSlice, schema: z.ZodType<T>, fallback: T): T {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(sliceKey(slice))
  } catch {
    return fallback // storage unavailable (private mode, SSR, node tests)
  }
  if (raw === null) return fallback
  try {
    const envelope = JSON.parse(raw) as { v?: number; data?: unknown }
    let data = envelope.data
    let v = envelope.v ?? 1
    while (v < PERSIST_VERSION) {
      const step = MIGRATIONS[v]
      if (!step) break // no path forward — safeParse below will reject it
      data = step(data)
      v++
    }
    const parsed = schema.safeParse(data)
    if (parsed.success) return parsed.data
    console.warn(`qarid: corrupt ${slice} slice — backed up, using defaults`, parsed.error)
    backup(slice, raw)
    return fallback
  } catch (err) {
    console.warn(`qarid: unreadable ${slice} slice — backed up, using defaults`, err)
    backup(slice, raw)
    return fallback
  }
}

const pending = new Map<PersistSlice, unknown>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  flushTimer = null
  for (const [slice, data] of pending) {
    try {
      localStorage.setItem(sliceKey(slice), JSON.stringify({ v: PERSIST_VERSION, data }))
    } catch (err) {
      console.warn(`qarid: failed to persist ${slice}`, err)
    }
  }
  pending.clear()
}

/** Debounced (300 ms trailing) per-slice write; slices persist independently. */
export function saveSlice(slice: PersistSlice, data: unknown): void {
  pending.set(slice, data)
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(flush, 300)
}

/** Flush immediately — visibilitychange → hidden, or before a duel navigates. */
export function flushNow(): void {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flush()
}

/** Drop a slice entirely (settings reset, «ابدأ من جديد»). */
export function clearSlice(slice: PersistSlice): void {
  pending.delete(slice)
  try {
    localStorage.removeItem(sliceKey(slice))
  } catch {
    /* ignore */
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow()
  })
}
