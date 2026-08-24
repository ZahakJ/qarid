/**
 * The shareable block (design-ux.md §5 Daily):
 *
 *     قريض — تحدّي ٢٣ آب
 *     ن ← م ← ب ← ر
 *     سلسلة من ٦ أبيات · ٧٤٠ نقطة
 *
 * Pure text, pure functions: no clipboard, no DOM, no clock. The caller
 * supplies the day and the exchanges; this file only decides what the block
 * says. Numbers go through `shared/format.ts` so the digits match the rest of
 * the UI, and the arrow is `←` because under RTL that is the one that means
 * "next" (amendments.md §15).
 */
import { formatBaits, formatCount, RLM } from "../../shared/format.ts"

/**
 * Levantine month names, which is what design-ux.md's «٢٣ آب» is written in.
 * `Intl` would answer أغسطس under `ar` and آب only under some regional
 * locales, so the names are stated here rather than left to the runtime.
 */
export const MONTHS_AR: readonly string[] = [
  "كانون الثاني",
  "شباط",
  "آذار",
  "نيسان",
  "أيار",
  "حزيران",
  "تموز",
  "آب",
  "أيلول",
  "تشرين الأول",
  "تشرين الثاني",
  "كانون الأول",
]

/** `2026-08-23` → «٢٣ آب». Returns the raw key back if it is not a day key. */
export function arabicDay(dayKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!m) return dayKey
  const month = MONTHS_AR[Number(m[2]) - 1]
  if (!month) return dayKey
  return `${formatCount(Number(m[3]))} ${month}`
}

/** The chain, oldest first, joined with the RTL "next" arrow. */
export function letterRibbon(letters: readonly string[]): string {
  return letters.join(" ← ")
}

export type ShareInput = {
  /** null for a normal duel — only the daily challenge is dated */
  dayKey?: string | null
  letters: readonly string[]
  /** أبيات the PLAYER landed */
  chainLength: number
  score: number
  /** «أفحمتَ الخصم» */
  stumped?: boolean
}

export function shareText({ dayKey, letters, chainLength, score, stumped = false }: ShareInput): string {
  const head = dayKey ? `قريض — تحدّي ${arabicDay(dayKey)}` : "قريض — مساجلة"
  const lines = [head]
  if (letters.length) lines.push(letterRibbon(letters))
  const tail = `سلسلة من ${formatBaits(chainLength)} · ${formatCount(score)} نقطة`
  lines.push(stumped ? `${tail} · أفحمتُ الخصم` : tail)
  // the block lands in Latin-first chat apps; open it the way a بيت is copied
  return RLM + lines.join("\n")
}
