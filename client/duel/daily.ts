/**
 * تحدّي اليوم — the rules of the shared daily chain (design-ux.md §5 Daily,
 * amendments.md §6), as pure functions the view only has to render.
 *
 *  • ONE opening بيت for everyone: the server seeds `/api/game/start` with
 *    `daily:<YYYY-MM-DD>`, and every reply with `daily:<day>:<turn>` — so two
 *    players who answer the same أبيات face the same opponent, بيتًا بيتًا.
 *    (`duelStore` sends those seeds whenever `session.dailyDate` is set.)
 *  • ONE life, NO timer: the challenge is memory, not speed.
 *  • ONE attempt per day, enforced on the client against the profile slice —
 *    the corpus is public and the game is stateless, so this is an honesty
 *    rail, not a security boundary, and it is written down as such.
 *
 * The day turns over in Riyadh, matching `riyadhDay()` on the server
 * (server/routes/baits.ts) — بيت اليوم and تحدّي اليوم must not disagree about
 * what day it is.
 */
import { DAILY_TIMEZONE } from "../../shared/constants.ts"
import type { DuelConfig, ProfileSlice } from "../../shared/schema.ts"
import { configFor } from "./tiers.ts"

/** `YYYY-MM-DD` on the Gulf calendar. Mirrors the server's `riyadhDay()`. */
export function riyadhDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DAILY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

/** شاعر tier, clock off, one life. */
export function dailyConfig(): DuelConfig {
  const base = configFor("poet", { timer: false, format: "endless", chainMode: "rhyme", filters: {} })
  return { ...base, lives: 1 }
}

export function playedToday(profile: Pick<ProfileSlice, "dailyResults">, day: string): boolean {
  return Boolean(profile.dailyResults[day])
}
