/**
 * Numbers, the way this product writes them.
 *
 * Two scales, deliberately (design-ux.md §2): verse numbers, poem counts and
 * anything a reader reads as part of the Arabic page use ARABIC-INDIC digits
 * with U+066C as the thousands separator — «٢٥٤٬٦٣٠ قصيدة». Timers, scores and
 * stats use Latin digits with `tabular-nums`, because a countdown whose digits
 * change width jitters, and Plex Mono only carries Latin figures anyway.
 *
 * Nothing here touches `Intl` on a hot path: `toLocaleString('ar-EG')` produces
 * the right glyphs but its separator and grouping vary by ICU build, and a
 * count that renders differently on the server than in the browser is a
 * hydration bug hunting for somewhere to happen.
 */

const ARABIC_INDIC = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"] as const

/** U+066C ARABIC THOUSANDS SEPARATOR — not a comma, not an apostrophe. */
export const ARABIC_THOUSANDS = "٬"

/** U+066B ARABIC DECIMAL SEPARATOR. */
export const ARABIC_DECIMAL = "٫"

/** U+061C ARABIC LETTER MARK — keeps a leading minus on the correct side. */
const ALM = "؜"

export type Numerals = "arabic" | "latin"

/** Every ASCII digit in the string becomes its Arabic-Indic twin. Nothing else moves. */
export function toArabicDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)]!)
}

/** The inverse — for parsing what a reader typed into a number field. */
export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const cp = d.codePointAt(0)!
    const base = cp >= 0x06f0 ? 0x06f0 : 0x0660
    return String(cp - base)
  })
}

/** `1234567` becomes `"1,234,567"` in Latin, `"١٬٢٣٤٬٥٦٧"` in Arabic. */
export function formatNumber(n: number, numerals: Numerals = "arabic"): string {
  if (!Number.isFinite(n)) return numerals === "arabic" ? ARABIC_INDIC[0] : "0"
  const negative = n < 0
  const parts = Math.abs(n).toString().split(".")
  const intPart = parts[0] ?? "0"
  const fracPart = parts[1]
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ")

  if (numerals === "latin") {
    const latin = grouped.replace(/ /g, ",") + (fracPart ? `.${fracPart}` : "")
    return negative ? `-${latin}` : latin
  }
  const arabic =
    toArabicDigits(grouped).replace(/ /g, ARABIC_THOUSANDS) +
    (fracPart ? ARABIC_DECIMAL + toArabicDigits(fracPart) : "")
  return negative ? `${ALM}-${arabic}` : arabic
}

/** Verse numbers, page numbers, letter-grid counts. Always Arabic-Indic. */
export function formatCount(n: number): string {
  return formatNumber(n, "arabic")
}

/** Scores and timers: Latin, so `tabular-nums` can hold the column steady. */
export function formatScore(n: number): string {
  return formatNumber(Math.round(n), "latin")
}

/** `72000` becomes `"1:12"`. Latin digits, no leading zero on the minutes. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

export interface CountedNounForms {
  /** «لا أبيات» */
  zero: string
  /** المفرد — «بيت واحد» */
  one: string
  /** المثنى — «بيتان» */
  two: string
  /** ٣ إلى ١٠ — «أبيات» */
  few: string
  /** ١١ فأكثر — «بيتًا» */
  many: string
}

/**
 * Arabic counted nouns, properly. «بيت واحد», «بيتان», «٥ أبيات», «١١ بيتًا» —
 * getting this wrong is the single most obvious way an Arabic interface
 * announces that it was translated rather than written.
 */
export function countedNoun(
  n: number,
  forms: CountedNounForms,
  numerals: Numerals = "arabic",
): string {
  const k = Math.abs(Math.trunc(n))
  if (k === 0) return forms.zero
  if (k === 1) return forms.one
  if (k === 2) return forms.two
  const num = formatNumber(k, numerals)
  const mod100 = k % 100
  if (mod100 >= 3 && mod100 <= 10) return `${num} ${forms.few}`
  return `${num} ${forms.many}`
}

export const BAYT_FORMS: CountedNounForms = {
  zero: "لا أبيات",
  one: "بيت واحد",
  two: "بيتان",
  few: "أبيات",
  many: "بيتًا",
}

export const QASIDA_FORMS: CountedNounForms = {
  zero: "لا قصائد",
  one: "قصيدة واحدة",
  two: "قصيدتان",
  few: "قصائد",
  many: "قصيدة",
}

export const SHAIR_FORMS: CountedNounForms = {
  zero: "لا شعراء",
  one: "شاعر واحد",
  two: "شاعران",
  few: "شعراء",
  many: "شاعرًا",
}

export function formatBaits(n: number): string {
  return countedNoun(n, BAYT_FORMS)
}

export function formatPoems(n: number): string {
  return countedNoun(n, QASIDA_FORMS)
}

export function formatPoets(n: number): string {
  return countedNoun(n, SHAIR_FORMS)
}

/**
 * Copying a بيت into a Latin-first chat app scrambles its punctuation unless
 * the clipboard text opens with a RIGHT-TO-LEFT MARK. design-ux.md §3 makes
 * this prefix mandatory on every copy path, so it lives next to the formatter.
 */
export const RLM = "‏"

/** The one join used for copied verse: صدر … عجز on a single logical line. */
export function copyableBayt(sadr: string, ajuz: string | null | undefined): string {
  return RLM + (ajuz ? `${sadr} … ${ajuz}` : sadr)
}
