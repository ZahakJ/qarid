/**
 * Numbers, the way this product writes them.
 *
 * **One scale: WESTERN (Latin) digits with a comma every three, everywhere** —
 * «239,411 قصيدة», verse number «12», «×7», «951 بيتًا», the daily share text,
 * stats, timers. Owner decision, 2026-08-24 (design-ux.md §2): the app used to
 * split its numbers in two — Arabic-Indic ٠١٢٣ for anything a reader read as
 * part of the Arabic page, Latin for timers and scores — and the split is gone.
 * There is no `numerals` setting any more; there is nothing to choose between.
 *
 * Nothing here touches `Intl`: `toLocaleString()` produces the right glyphs but
 * its separator and grouping vary by ICU build, and a count that renders
 * differently on the server than in the browser is a hydration bug hunting for
 * somewhere to happen.
 *
 * Bidi: a bare Latin number inside an Arabic run needs no mark — the bidi
 * algorithm gives European digits a weak LTR direction and resolves them
 * against the paragraph, so «951 بيتًا» and «×7» order correctly on their own.
 * Two shapes DO need help and get it at their call site, not here: a number
 * with a NEUTRAL character glued to it that must stay on its left (the hint
 * price `‎−40`), and a numeric RANGE around a neutral dash (`2–3` in the stats
 * histogram), which needs its own LTR run or it reads back to front.
 */

/**
 * U+200E LEFT-TO-RIGHT MARK — the minus in front of a Latin number is a
 * NEUTRAL character, so in an RTL paragraph it resolves to the paragraph's
 * direction and lands on the wrong side («42-»). An LRM in front of it opens an
 * LTR run and the sign stays where a reader expects it.
 */
const LRM = "‎"

/**
 * Arabic-Indic (and Persian) digits → ASCII, for parsing what a reader typed
 * or pasted into a field. Nothing in the UI emits those digits any more, but
 * readers still type them.
 */
export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const cp = d.codePointAt(0)!
    const base = cp >= 0x06f0 ? 0x06f0 : 0x0660
    return String(cp - base)
  })
}

/** `1234567` becomes `"1,234,567"`. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const negative = n < 0
  const parts = Math.abs(n).toString().split(".")
  const intPart = parts[0] ?? "0"
  const fracPart = parts[1]
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const out = grouped + (fracPart ? `.${fracPart}` : "")
  return negative ? `${LRM}-${out}` : out
}

/** Verse numbers, page numbers, letter-grid counts — reading scale. */
export function formatCount(n: number): string {
  return formatNumber(n)
}

/** Scores and timers: rounded, so `tabular-nums` can hold the column steady. */
export function formatScore(n: number): string {
  return formatNumber(Math.round(n))
}

/** `72000` becomes `"1:12"`. No leading zero on the minutes. */
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
  /** المثنى مجرورًا — «بيتين»، بعد حرف جرّ («سلسلة من بيتين») */
  twoGenitive?: string
  /** 3 إلى 10 — «أبيات» */
  few: string
  /** 11 فأكثر — «بيتًا» */
  many: string
}

/**
 * Arabic counted nouns, properly. «بيت واحد», «بيتان», «5 أبيات», «11 بيتًا» —
 * getting this wrong is the single most obvious way an Arabic interface
 * announces that it was translated rather than written.
 */
export function countedNoun(n: number, forms: CountedNounForms): string {
  const k = Math.abs(Math.trunc(n))
  if (k === 0) return forms.zero
  if (k === 1) return forms.one
  if (k === 2) return forms.two
  const num = formatNumber(k)
  const mod100 = k % 100
  if (mod100 >= 3 && mod100 <= 10) return `${num} ${forms.few}`
  return `${num} ${forms.many}`
}

/**
 * The same counted noun after a preposition — «سلسلة من بيتين», not «من بيتان».
 *
 * Only the dual moves: المثنى is مجرور there, and it is the one form whose
 * ending a reader hears. Everything else (the singular «بيت واحد», the جمع
 * «5 أبيات», the تمييز «14 بيتًا») is already right in that position, so this
 * is `countedNoun` with one substitution rather than a second table.
 */
export function countedNounGenitive(n: number, forms: CountedNounForms): string {
  const k = Math.abs(Math.trunc(n))
  if (k === 2 && forms.twoGenitive) return forms.twoGenitive
  return countedNoun(n, forms)
}

export const BAYT_FORMS: CountedNounForms = {
  zero: "لا أبيات",
  one: "بيت واحد",
  two: "بيتان",
  twoGenitive: "بيتين",
  few: "أبيات",
  many: "بيتًا",
}

export const QASIDA_FORMS: CountedNounForms = {
  zero: "لا قصائد",
  one: "قصيدة واحدة",
  two: "قصيدتان",
  twoGenitive: "قصيدتين",
  few: "قصائد",
  many: "قصيدة",
}

export const SHAIR_FORMS: CountedNounForms = {
  zero: "لا شعراء",
  one: "شاعر واحد",
  two: "شاعران",
  twoGenitive: "شاعرين",
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
 * The unit WORD alone, for a layout that has already put the digits on screen
 * — a stat tile's caption, a big due-count, a coloured number span.
 *
 * Only two of the five forms can appear there: جمع التكسير after 3–10 («5
 * بطاقات») and the singular تمييز everywhere else («1 بطاقة», «12 بطاقة»). The
 * word-numbers («بطاقة واحدة», «بطاقتان») are exactly what a caller who prints
 * the digits himself cannot use, so `countedNoun` is the wrong function there.
 */
export function countedUnit(n: number, forms: CountedNounForms): string {
  const k = Math.abs(Math.trunc(n))
  const mod100 = k % 100
  return k >= 3 && mod100 >= 3 && mod100 <= 10 ? forms.few : forms.many
}

/** «لا نتائج» · «نتيجة واحدة» · «4 نتائج» · «129 نتيجة» — the search count. */
export const NATIJA_FORMS: CountedNounForms = {
  zero: "لا نتائج",
  one: "نتيجة واحدة",
  two: "نتيجتان",
  twoGenitive: "نتيجتين",
  few: "نتائج",
  many: "نتيجة",
}

/** نقاط المساجلة — «5 نقاط», «247 نقطة». */
export const NUQTA_FORMS: CountedNounForms = {
  zero: "لا نقاط",
  one: "نقطة واحدة",
  two: "نقطتان",
  twoGenitive: "نقطتين",
  few: "نقاط",
  many: "نقطة",
}

/** بطاقات المذاكرة — «10 بطاقات», «11 بطاقة». */
export const BITAQA_FORMS: CountedNounForms = {
  zero: "لا بطاقات",
  one: "بطاقة واحدة",
  two: "بطاقتان",
  twoGenitive: "بطاقتين",
  few: "بطاقات",
  many: "بطاقة",
}

/** كلمات الجواب في المذاكرة — «3 كلمات», «12 كلمة». */
export const KALIMA_FORMS: CountedNounForms = {
  zero: "لا كلمات",
  one: "كلمة واحدة",
  two: "كلمتان",
  twoGenitive: "كلمتين",
  few: "كلمات",
  many: "كلمة",
}

/** سلسلة المذاكرة — «3 أيام متتالية» vs «12 يومًا متتاليًا» (see `dayStreak`). */
export const YAWM_FORMS: CountedNounForms = {
  zero: "لا أيام",
  one: "يوم واحد",
  two: "يومان",
  twoGenitive: "يومين",
  few: "أيام",
  many: "يومًا",
}

export function formatResults(n: number): string {
  return countedNoun(n, NATIJA_FORMS)
}

export function formatCards(n: number): string {
  return countedNoun(n, BITAQA_FORMS)
}

export function formatWords(n: number): string {
  return countedNoun(n, KALIMA_FORMS)
}

/**
 * A counted noun with its نعت — «بيت واحد جديد», «بيتان جديدان», «5 أبيات
 * جديدة», «12 بيتًا جديدًا».
 *
 * The adjective has to agree with the معدود in number, case AND (for a جمع
 * تكسير of a non-human) gender, which is exactly the agreement that goes wrong
 * when a phrase is assembled by concatenation. The four forms are given by the
 * caller because only the caller knows the word.
 */
export interface AdjectiveForms {
  /** مع المفرد — «جديد» */
  one: string
  /** مع المثنى — «جديدان» */
  two: string
  /** مع جمع التكسير (3–10) — «جديدة» */
  few: string
  /** مع التمييز المنصوب (11 فأكثر) — «جديدًا» */
  many: string
}

export function countedNounWithAdjective(n: number, forms: CountedNounForms, adj: AdjectiveForms): string {
  const k = Math.abs(Math.trunc(n))
  const noun = countedNoun(k, forms)
  if (k === 0) return noun
  if (k === 1) return `${noun} ${adj.one}`
  if (k === 2) return `${noun} ${adj.two}`
  const mod100 = k % 100
  return `${noun} ${mod100 >= 3 && mod100 <= 10 ? adj.few : adj.many}`
}

/** «يومان متتاليان» · «3 أيام متتالية» · «12 يومًا متتاليًا». */
export function formatDayStreak(n: number): string {
  return countedNounWithAdjective(n, YAWM_FORMS, {
    one: "متتالٍ",
    two: "متتاليان",
    few: "متتالية",
    many: "متتاليًا",
  })
}

/**
 * «2–3», «128+» — the caption on an أطوال القصائد histogram bin.
 *
 * The client derives it from `min`/`max` instead of reading the `label` the
 * artefact carries, because a `data/qarid.db` built before 2026-08-24 baked
 * that label with Arabic-Indic digits («٢–٣») into `meta.stats_json`. Deriving
 * it needs no re-ingest; `scripts/ingest/build.ts` calls the same function so a
 * rebuilt artefact agrees with what is on screen.
 *
 * The range dash is NEUTRAL, so a bare «2–3» inside an RTL paragraph renders
 * back to front. StatsView puts the caption in its own LTR run (`<bdi dir="ltr">`).
 */
export function histogramLabel(bin: { min: number; max: number | null }): string {
  if (bin.max === null) return `${formatNumber(bin.min)}+`
  if (bin.max === bin.min) return formatNumber(bin.min)
  return `${formatNumber(bin.min)}–${formatNumber(bin.max)}`
}

/**
 * Copying a بيت into a Latin-first chat app scrambles its punctuation unless
 * the clipboard text opens with a RIGHT-TO-LEFT MARK. design-ux.md §3 makes
 * this prefix mandatory on every copy path, so it lives next to the formatter.
 * It matters MORE now that the numbers are Latin: an RTL paragraph that opens
 * on a digit is otherwise typed as an LTR paragraph by the receiving app.
 */
export const RLM = "‏"

/** The one join used for copied verse: صدر … عجز on a single logical line. */
export function copyableBayt(sadr: string, ajuz: string | null | undefined): string {
  return RLM + (ajuz ? `${sadr} … ${ajuz}` : sadr)
}
