/**
 * العصور — the corpus's 14 raw `poet era` values folded to the 12 the product
 * browses by, in chronological order.
 *
 * Two merges (design-server.md §4), both measured in `data/profile.json`:
 *   · «قبل الإسلام» (1,786) is «العصر الجاهلي» (1,873) under another name.
 *   · «العصر الأندلسي» (4,770) and «المغرب والأندلس» (6,614) are one place.
 * And one spelling fix: the corpus writes «المخضرمين»; the era is المخضرمون.
 *
 * amendment 11 gives each row a `kind`: eleven are periods on a timeline, one
 * — الأندلس والمغرب — is a REGION that overlaps الأموي through العثماني. The
 * timeline widget has to know that or it draws a lie.
 */

import { normalizeArabic } from "./arabic.ts"

export type EraKind = "period" | "region"

export interface EraRow {
  slug: string
  name: string
  /** Chronological. `poets.era_id` orders by this, never by id or by name. */
  sort: number
  kind: EraKind
  /** Rough Hijri/Gregorian bracket for the poet-page subtitle. `null` for the region. */
  span: string | null
}

export const ERAS: readonly EraRow[] = [
  { slug: "jahili", name: "العصر الجاهلي", sort: 1, kind: "period", span: "قبل 622 م" },
  { slug: "mukhadram", name: "المخضرمون", sort: 2, kind: "period", span: "622 – 661 م" },
  { slug: "islami", name: "العصر الإسلامي", sort: 3, kind: "period", span: "622 – 661 م" },
  { slug: "umawi", name: "العصر الأموي", sort: 4, kind: "period", span: "661 – 750 م" },
  { slug: "abbasi", name: "العصر العباسي", sort: 5, kind: "period", span: "750 – 1258 م" },
  { slug: "andalus", name: "الأندلس والمغرب", sort: 6, kind: "region", span: null },
  { slug: "fatimi", name: "العصر الفاطمي", sort: 7, kind: "period", span: "909 – 1171 م" },
  { slug: "ayyubi", name: "العصر الأيوبي", sort: 8, kind: "period", span: "1171 – 1260 م" },
  { slug: "mamluki", name: "العصر المملوكي", sort: 9, kind: "period", span: "1250 – 1517 م" },
  { slug: "baynadawlatayn", name: "عصر بين الدولتين", sort: 10, kind: "period", span: "1258 – 1517 م" },
  { slug: "uthmani", name: "العصر العثماني", sort: 11, kind: "period", span: "1517 – 1918 م" },
  { slug: "hadith", name: "العصر الحديث", sort: 12, kind: "period", span: "بعد 1798 م" },
]

export const ERAS_BY_SLUG: ReadonlyMap<string, EraRow> = new Map(
  ERAS.map((e) => [e.slug, e] as const),
)

/**
 * Every raw `poet era` string in the corpus → slug. Keyed on `normalizeArabic`
 * so «العصر الأموي» and a hamza-less «العصر الاموي» are the same key; the
 * corpus contains both kinds of sloppiness across its eight source sites.
 */
const RAW_TO_SLUG: ReadonlyMap<string, string> = new Map(
  (
    [
      ["العصر الجاهلي", "jahili"],
      ["قبل الإسلام", "jahili"],
      ["المخضرمين", "mukhadram"],
      ["المخضرمون", "mukhadram"],
      ["العصر الإسلامي", "islami"],
      ["العصر الأموي", "umawi"],
      ["العصر العباسي", "abbasi"],
      ["العصر الأندلسي", "andalus"],
      ["المغرب والأندلس", "andalus"],
      ["الأندلس والمغرب", "andalus"],
      ["العصر الفاطمي", "fatimi"],
      ["العصر الأيوبي", "ayyubi"],
      ["العصر المملوكي", "mamluki"],
      ["عصر بين الدولتين", "baynadawlatayn"],
      ["العصر العثماني", "uthmani"],
      ["العصر الحديث", "hadith"],
    ] as const
  ).map(([raw, slug]) => [normalizeArabic(raw), slug as string] as const),
)

/** The 14 values `data/profile.json` actually holds — the exhaustive test input. */
export const RAW_ERA_VALUES: readonly string[] = [
  "العصر الحديث", "العصر العباسي", "العصر المملوكي", "العصر العثماني",
  "المغرب والأندلس", "العصر الفاطمي", "العصر الأندلسي", "العصر الأموي",
  "العصر الأيوبي", "المخضرمين", "العصر الجاهلي", "قبل الإسلام",
  "عصر بين الدولتين", "العصر الإسلامي",
]

/** raw `poet era` → the canonical row, or `null` (107,209 rows are null). */
export function normalizeEra(raw: string | null | undefined): EraRow | null {
  const key = normalizeArabic(raw)
  if (key === "") return null
  const slug = RAW_TO_SLUG.get(key)
  return slug === undefined ? null : (ERAS_BY_SLUG.get(slug) ?? null)
}

export function eraBySlug(slug: string | null | undefined): EraRow | null {
  if (!slug) return null
  return ERAS_BY_SLUG.get(slug) ?? null
}

/** Chronological comparator for anything carrying an era slug. */
export function compareEras(a: string, b: string): number {
  return (eraBySlug(a)?.sort ?? 99) - (eraBySlug(b)?.sort ?? 99)
}
