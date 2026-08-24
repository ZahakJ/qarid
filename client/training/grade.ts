/**
 * Marking a drill answer (design-ux.md §5).
 *
 * Two measurements, one verdict:
 *
 *   sim = 1 − lev(normalize(typed), normalize(ajuz)) / max(len)
 *
 * — a normalized edit distance over the SHARED normalizer, so a forgotten
 * تشكيل, an أ written ا, a ة written ه and a doubled space are all free. That
 * is not leniency for its own sake: the corpus itself spells the same عجز four
 * ways, and `shared/arabic.ts` is the only place in قريض allowed to decide that
 * two spellings are one word (CLAUDE.md invariant).
 *
 * The thresholds are the design's:
 *   sim == 1              → good, and easy when it came back inside 8 seconds
 *   0.65 ≤ sim < 1        → hard, shown with the word diff
 *   else                  → again
 *
 * The diff is WORD level, not character level, because that is the unit a
 * memoriser missed: «تجري الرياح» for «تجري الرياحُ بما» is one missing word,
 * not four missing letters, and colouring letters would make a near-miss look
 * like rubble. Alignment is a Levenshtein table over normalized tokens with a
 * backtrace, so a word inserted at the front does not paint the whole عجز red.
 */
import { normalize } from "../../shared/arabic.ts"
import type { CardGrade } from "../../shared/schema.ts"

/** An answer this fast on a perfect line was recall, not reconstruction. */
export const EASY_MS = 8000

/** Below this the answer is not a near miss, it is a different بيت. */
export const HARD_FLOOR = 0.65

/** Classic DP edit distance, two rows. Inputs here are one hemistich long. */
export function levenshtein(a: readonly string[] | string, b: readonly string[] | string): number {
  const x = typeof a === "string" ? [...a] : a
  const y = typeof b === "string" ? [...b] : b
  if (x.length === 0) return y.length
  if (y.length === 0) return x.length

  let prev = Array.from({ length: y.length + 1 }, (_, i) => i)
  let row = new Array<number>(y.length + 1)
  for (let i = 1; i <= x.length; i++) {
    row[0] = i
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1
      row[j] = Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
    const swap = prev
    prev = row
    row = swap
  }
  return prev[y.length] ?? 0
}

/** Words of a hemistich, normalized. Empty strings never survive. */
export function tokens(text: string | null | undefined): string[] {
  return normalize(text ?? "")
    .split(" ")
    .filter(Boolean)
}

/**
 * 0..1. Both empty is a perfect answer to an empty question (a بيت with no
 * عجز); one empty and the other not is 0, never a division by zero.
 */
export function similarity(typed: string | null | undefined, expected: string | null | undefined): number {
  const a = normalize(typed ?? "")
  const b = normalize(expected ?? "")
  if (a === "" && b === "") return 1
  if (a === "" || b === "") return 0
  const max = Math.max([...a].length, [...b].length)
  return Math.max(0, 1 - levenshtein(a, b) / max)
}

/** The verdict the drill pre-selects; the reader may always overrule it. */
export function gradeFor(sim: number, elapsedMs: number): CardGrade {
  if (sim >= 1) return elapsedMs < EASY_MS ? "easy" : "good"
  if (sim >= HARD_FLOOR) return "hard"
  return "again"
}

export type DiffState = "ok" | "wrong" | "missing"

/**
 * One word of the EXPECTED عجز, marked. `typed` carries what was written in
 * its place, so the card can show «كتبتَ: الرياحَ» under a wrong word without
 * a second diff pass.
 */
export type DiffToken = {
  text: string
  state: DiffState
  typed: string | null
}

/**
 * The عجز, word by word, marked against what was typed. The rendering contract
 * (design-ux.md §5): correct → text-1, missing → text-3, wrong → danger.
 *
 * Words the reader added that the بيت does not have are not tokens of their
 * own — the line on screen is the بيت, and an invented word has no place in it.
 * It surfaces as the `typed` of the word it displaced.
 */
export function wordDiff(typed: string | null | undefined, expected: string | null | undefined): DiffToken[] {
  const want = (expected ?? "").split(/\s+/).filter(Boolean)
  const wantKey = want.map((w) => normalize(w))
  const gotRaw = (typed ?? "").split(/\s+/).filter(Boolean)
  const got = gotRaw.map((w) => normalize(w))

  if (want.length === 0) return []
  if (got.length === 0) return want.map((text) => ({ text, state: "missing" as const, typed: null }))

  // Levenshtein table over words, kept whole so the backtrace can read it.
  const n = wantKey.length
  const m = got.length
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = wantKey[i - 1] === got[j - 1] ? 0 : 1
      const row = d[i]
      const above = d[i - 1]
      if (!row || !above) continue
      row[j] = Math.min((row[j - 1] ?? 0) + 1, (above[j] ?? 0) + 1, (above[j - 1] ?? 0) + cost)
    }
  }

  const out: DiffToken[] = []
  let i = n
  let j = m
  while (i > 0) {
    const here = d[i]?.[j] ?? 0
    const diag = d[i - 1]?.[j - 1] ?? 0
    const up = d[i - 1]?.[j] ?? 0
    const cost = j > 0 && wantKey[i - 1] === got[j - 1] ? 0 : 1
    if (j > 0 && here === diag + cost) {
      out.push({
        text: want[i - 1] ?? "",
        state: cost === 0 ? "ok" : "wrong",
        typed: cost === 0 ? null : (gotRaw[j - 1] ?? null),
      })
      i--
      j--
    } else if (here === up + 1) {
      out.push({ text: want[i - 1] ?? "", state: "missing", typed: null })
      i--
    } else {
      // an inserted word: consumed silently, it is not part of the بيت
      j--
    }
  }
  return out.reverse()
}

/** «أصبتَ ٧ من ٩ كلمات» — the one line that sits over the diff. */
export function diffScore(tokens: readonly DiffToken[]): { ok: number; total: number } {
  return { ok: tokens.filter((t) => t.state === "ok").length, total: tokens.length }
}
