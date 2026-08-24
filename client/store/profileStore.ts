/**
 * `qarid:v1:profile` — what قريض remembers about YOU across sessions
 * (design-ux.md §6): games played, أبيات played, best streak and score, the
 * شعراء you have met, daily results, and when you first opened the ديوان.
 *
 * Phase 2 reads it (the home screen's المساجلة bar shows أطول سلسلة and the
 * arsenal ring) and writes only `firstSeenAt`. Phase 3's duel summary is what
 * fills the rest; the API is complete here so the duel never has to reach into
 * localStorage itself.
 *
 * `poetsMet` is the retention mechanic — «لقيت 47 شاعرًا من 6,997» — and is a
 * SET of poet slugs kept sorted so two sessions that met the same شعراء persist
 * byte-identical payloads.
 */
import { create } from "zustand"
import { ProfileSliceSchema, type DailyResult, type ProfileSlice } from "../../shared/schema.ts"
import { loadSlice, saveSlice } from "../persist.ts"

export const DEFAULT_PROFILE: ProfileSlice = ProfileSliceSchema.parse({})

type ProfileStore = ProfileSlice & {
  /** one finished duel folds into the profile in a single call */
  recordDuel: (r: { score: number; streak: number; abyat: number; poets?: readonly string[] }) => void
  metPoets: (slugs: readonly string[]) => void
  recordDaily: (result: DailyResult) => void
  /** «لقيت N شاعرًا» */
  poetsMetCount: () => number
  reset: () => void
}

function data(s: ProfileSlice): ProfileSlice {
  return {
    gamesPlayed: s.gamesPlayed,
    abyatPlayed: s.abyatPlayed,
    bestStreak: s.bestStreak,
    bestScore: s.bestScore,
    poetsMet: s.poetsMet,
    dailyResults: s.dailyResults,
    reviewStreak: s.reviewStreak,
    firstSeenAt: s.firstSeenAt,
  }
}

function union(existing: readonly string[], added: readonly string[]): string[] {
  const set = new Set(existing)
  for (const s of added) if (s) set.add(s)
  return [...set].sort()
}

const loaded = loadSlice("profile", ProfileSliceSchema, DEFAULT_PROFILE)

export const useProfile = create<ProfileStore>()((set, get) => ({
  ...loaded,
  // «منذ» on the stats page needs a start date, and the honest one is the first
  // time this browser opened قريض — not the first duel.
  firstSeenAt: loaded.firstSeenAt || Date.now(),

  recordDuel: ({ score, streak, abyat, poets = [] }) =>
    set((s) => ({
      gamesPlayed: s.gamesPlayed + 1,
      abyatPlayed: s.abyatPlayed + Math.max(0, Math.trunc(abyat)),
      bestStreak: Math.max(s.bestStreak, Math.max(0, Math.trunc(streak))),
      bestScore: Math.max(s.bestScore, Math.trunc(score)),
      poetsMet: union(s.poetsMet, poets),
    })),

  metPoets: (slugs) => set((s) => ({ poetsMet: union(s.poetsMet, slugs) })),

  recordDaily: (result) => set((s) => ({ dailyResults: { ...s.dailyResults, [result.date]: result } })),

  poetsMetCount: () => get().poetsMet.length,

  reset: () => set({ ...DEFAULT_PROFILE, firstSeenAt: Date.now() }),
}))

useProfile.subscribe((s) => saveSlice("profile", data(s)))
