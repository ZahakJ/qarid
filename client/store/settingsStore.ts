/**
 * `qarid:v1:settings` — the only slice Phase 0 actually writes.
 *
 * The shape is SettingsSliceSchema in shared/schema.ts; persistence goes
 * through client/persist.ts, so a hand-edited or stale payload degrades to
 * defaults (and is backed up) instead of crashing the app.
 */
import { create } from "zustand"
import { SettingsSliceSchema, type SettingsSlice } from "../../shared/schema.ts"
import { loadSlice, saveSlice } from "../persist.ts"

/** Every field in the slice carries a zod default — this is that record. */
export const DEFAULT_SETTINGS: SettingsSlice = SettingsSliceSchema.parse({})

type SettingsStore = SettingsSlice & {
  patch: (p: Partial<SettingsSlice>) => void
  reset: () => void
}

/** Strip the actions back off before persisting. */
function data(s: SettingsSlice): SettingsSlice {
  return {
    tashkeel: s.tashkeel,
    showRawiyy: s.showRawiyy,
    verseSize: s.verseSize,
    numerals: s.numerals,
    sound: s.sound,
    reduceMotion: s.reduceMotion,
  }
}

export const useSettings = create<SettingsStore>()((set) => ({
  ...loadSlice("settings", SettingsSliceSchema, DEFAULT_SETTINGS),
  patch: (p) => set(p),
  reset: () => set(DEFAULT_SETTINGS),
}))

useSettings.subscribe((s) => saveSlice("settings", data(s)))

/** Resolved motion preference: an explicit setting outranks the media query. */
export function motionReduced(s: Pick<SettingsSlice, "reduceMotion">): boolean {
  if (s.reduceMotion === "on") return true
  if (s.reduceMotion === "off") return false
  if (typeof matchMedia !== "function") return false
  return matchMedia("(prefers-reduced-motion: reduce)").matches
}
