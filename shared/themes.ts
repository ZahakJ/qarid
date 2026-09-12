/**
 * الأغراض — the 18 distinct `poem theme` values, slugged and ordered.
 *
 * amendment 11 splits them in two: sixteen are real أغراض a reader browses by,
 * and two — «قصيدة قصيره» (25,911 poems) and «قصيدة عامه» (20,611) — are
 * BUCKETS, aldiwan's own filing cabinet rather than a subject. Together they
 * are half of every themed poem in the corpus, so leaving them in the filter
 * chips would bury غزل and رثاء under two labels that mean nothing. They stay
 * browsable by URL (`#/browse?theme=qasira`) and stay out of the chip row.
 *
 * `display` is the raw value minus its «قصيدة » prefix, per design-server.md §4
 * — the corpus's own spellings, warts and all («رومنسيه», «حزينه»), because the
 * facet label has to match what a search for that word finds.
 */

import { cleanText, normalizeArabic } from "./arabic.ts"

export type ThemeKind = "theme" | "bucket"

export interface ThemeRow {
  slug: string
  /** The raw corpus value, verbatim — this is `themes.name` and the join key. */
  name: string
  /** What the UI shows: `name` without its «قصيدة » prefix. */
  display: string
  sort: number
  kind: ThemeKind
}

/** Sorted by corpus frequency within each kind; buckets last. */
export const THEMES: readonly ThemeRow[] = [
  { slug: "madh", name: "قصيدة مدح", display: "مدح", sort: 1, kind: "theme" },
  { slug: "romansi", name: "قصيدة رومنسيه", display: "رومنسيه", sort: 2, kind: "theme" },
  { slug: "hazin", name: "قصيدة حزينه", display: "حزينه", sort: 3, kind: "theme" },
  { slug: "itab", name: "قصيدة عتاب", display: "عتاب", sort: 4, kind: "theme" },
  { slug: "hija", name: "قصيدة هجاء", display: "هجاء", sort: 5, kind: "theme" },
  { slug: "ghazal", name: "قصيدة غزل", display: "غزل", sort: 6, kind: "theme" },
  { slug: "diniya", name: "قصيدة دينية", display: "دينية", sort: 7, kind: "theme" },
  { slug: "ritha", name: "قصيدة رثاء", display: "رثاء", sort: 8, kind: "theme" },
  { slug: "shawq", name: "قصيدة شوق", display: "شوق", sort: 9, kind: "theme" },
  { slug: "firaq", name: "قصيدة فراق", display: "فراق", sort: 10, kind: "theme" },
  { slug: "dhamm", name: "قصيدة ذم", display: "ذم", sort: 11, kind: "theme" },
  { slug: "wataniya", name: "قصيدة وطنيه", display: "وطنيه", sort: 12, kind: "theme" },
  { slug: "anashid", name: "قصيدة الاناشيد", display: "الاناشيد", sort: 13, kind: "theme" },
  { slug: "siyasiya", name: "قصيدة سياسية", display: "سياسية", sort: 14, kind: "theme" },
  { slug: "muallaqat", name: "قصيدة المعلقات", display: "المعلقات", sort: 15, kind: "theme" },
  { slug: "itidhar", name: "قصيدة اعتذار", display: "اعتذار", sort: 16, kind: "theme" },
  { slug: "qasira", name: "قصيدة قصيره", display: "قصيره", sort: 90, kind: "bucket" },
  { slug: "amma", name: "قصيدة عامه", display: "عامه", sort: 91, kind: "bucket" },
]

export const THEMES_BY_SLUG: ReadonlyMap<string, ThemeRow> = new Map(
  THEMES.map((t) => [t.slug, t] as const),
)

const RAW_TO_THEME: ReadonlyMap<string, ThemeRow> = new Map(
  THEMES.map((t) => [normalizeArabic(t.name), t] as const),
)

/** The chips the browse rail renders — أغراض only, never the two buckets. */
export const FILTERABLE_THEMES: readonly ThemeRow[] = THEMES.filter((t) => t.kind === "theme")

/** raw `poem theme` → the canonical row, or `null` (187,110 rows are null). */
export function normalizeTheme(raw: string | null | undefined): ThemeRow | null {
  const key = normalizeArabic(raw)
  if (key === "") return null
  return RAW_TO_THEME.get(key) ?? null
}

export function themeBySlug(slug: string | null | undefined): ThemeRow | null {
  if (!slug) return null
  return THEMES_BY_SLUG.get(slug) ?? null
}

/**
 * `poem language type` has five spellings for two ideas (design-server.md §6):
 * فصحى and فصيح are the same, شعبي and عامي are the same, and a literal "-"
 * (32 rows) is nothing at all.
 */
export function normalizeLangType(raw: string | null | undefined): "فصيح" | "عامي" | null {
  const key = normalizeArabic(raw)
  if (key === "فصيح" || key === "فصحي") return "فصيح"
  if (key === "عامي" || key === "شعبي") return "عامي"
  return null
}

/**
 * `poet location` has 22 values and one duplicate country: سورية (4,499) and
 * سوريا (2,060) are the same place. design-server.md §4 does not mention the
 * merge; the profiler found it, and a facet that lists Syria twice is a bug a
 * reader sees immediately.
 */
export function normalizeLocation(raw: string | null | undefined): string | null {
  const cleaned = cleanText(raw)
  if (cleaned === "") return null
  return LOCATION_CANONICAL.get(normalizeArabic(cleaned)) ?? cleaned
}

/** normalised spelling → the ONE display form that survives into the facet. */
const LOCATION_CANONICAL: ReadonlyMap<string, string> = new Map(
  ([["\u0633\u0648\u0631\u064a\u0627", "\u0633\u0648\u0631\u064a\u0629"], ["\u0633\u0648\u0631\u064a\u0629", "\u0633\u0648\u0631\u064a\u0629"]] as const).map(
    ([from, to]) => [normalizeArabic(from), to as string] as const,
  ),
)
