/**
 * The seats this browser holds, by match code, in localStorage — the secret is
 * the whole of the player's identity, so losing it is losing the seat. Every
 * access is guarded: private windows and blocked storage throw, and the match
 * then lasts as long as the tab.
 */

export type SeatRecord = {
  secret: string
  /** a knock the host has not answered yet — not a seat until accepted */
  knocking?: boolean
  /** the host's share link, kept so a reload can show it again */
  shareUrl?: string
  savedAt: number
}

const PREFIX = "qarid:match:"
const NAME_KEY = "qarid:match-name"
/** Seats older than this are dropped on the next write. */
const KEEP_MS = 3 * 24 * 60 * 60_000

const memory = new Map<string, string>()

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return memory.get(key) ?? null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    if (value === null) memory.delete(key)
    else memory.set(key, value)
  }
}

export function seatFor(code: string): SeatRecord | null {
  const raw = read(PREFIX + code.toUpperCase())
  if (!raw) return null
  try {
    const rec = JSON.parse(raw) as SeatRecord
    return typeof rec.secret === "string" ? rec : null
  } catch {
    return null
  }
}

export function saveSeat(code: string, rec: Omit<SeatRecord, "savedAt">): void {
  prune()
  write(PREFIX + code.toUpperCase(), JSON.stringify({ ...rec, savedAt: Date.now() }))
}

export function forgetSeat(code: string): void {
  write(PREFIX + code.toUpperCase(), null)
}

function prune(): void {
  try {
    const cutoff = Date.now() - KEEP_MS
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      const rec = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<SeatRecord>
      if (!rec.savedAt || rec.savedAt < cutoff) localStorage.removeItem(key)
    }
  } catch {
    /* storage unavailable — nothing to prune */
  }
}

/** The name this reader last played under, to prefill the next match. */
export function lastName(): string {
  return read(NAME_KEY) ?? ""
}

export function rememberName(name: string | null): void {
  write(NAME_KEY, name && name.trim() ? name.trim() : null)
}
