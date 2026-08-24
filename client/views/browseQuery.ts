/**
 * #/browse — the translation layer between the URL (which OWNS the facet state,
 * design-ux.md §1) and the API.
 *
 * Two vocabularies meet here and they are deliberately not the same words:
 *
 *   URL / router     API              meaning
 *   ─────────────    ─────────────    ───────────────────────────────────────
 *   rawiyy           rhyme            the روي
 *   letter           first            the letter the مطلع opens on
 *   era/meter/theme  era/meter/theme  ascii slugs, server-supplied
 *
 * and one behaviour switch: with `rawiyy` or `letter` applied the UNIT of the
 * result stops being the قصيدة and becomes the بيت, so the list is served by
 * /api/baits and rendered as BaytPlates (design-ux.md §3 Browse). Everything
 * that decides either of those things is a pure function in this file, and
 * `browseQuery.test.ts` drives them round-trip.
 */
import type { BrowseQuery, BrowseSort } from "../router.ts"
import { browseQueryString, parseBrowseQuery } from "../router.ts"
import { LIMITS, type MetaResponse } from "../../shared/schema.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"

/** One page of browse results. 24 divides the 3-column poem grid evenly. */
export const BROWSE_PAGE = 24

/** The facet keys, in the order the applied-chips bar lists them. */
export const FACET_KEYS = ["era", "meter", "theme", "rawiyy", "letter"] as const
export type FacetKey = (typeof FACET_KEYS)[number]

/** Accordion headings in the facet rail, in order (design-ux.md §3). */
export const FACET_LABEL: Record<FacetKey, string> = {
  era: "العصر",
  meter: "البحر",
  theme: "الغرض",
  rawiyy: "الروي",
  letter: "حرف البداية",
}

/**
 * The sorts #/browse offers.
 *
 * DEVIATION from design-ux.md §3, which lists «الأحدث»: the corpus carries no
 * date on a قصيدة — `poems` has no year column and the source pages do not
 * supply one — so a "newest" order would be a lie about row insertion order.
 * The router's `BrowseSort` still parses `recent` (it is in the type), and a
 * URL carrying it degrades to الأشهر rather than erroring.
 */
export const BROWSE_SORTS: readonly { value: BrowseSort; label: string }[] = [
  { value: "fame", label: "الأشهر" },
  { value: "length", label: "الأطول" },
  { value: "random", label: "عشوائي" },
]

/** `sort=` as the API spells it. */
export function apiSort(sort: BrowseSort | undefined): "fame" | "length" | "random" {
  if (sort === "length") return "length"
  if (sort === "random") return "random"
  return "fame"
}

/** With a روي or a حرف البداية applied, the unit of the answer is the بيت. */
export function isBaytMode(q: BrowseQuery): boolean {
  return Boolean(q.rawiyy || q.letter)
}

/** True when no facet is applied — sort and page are not facets. */
export function hasFacets(q: BrowseQuery): boolean {
  return FACET_KEYS.some((k) => q[k] !== undefined)
}

export type ApiParams = Record<string, string | number | undefined>

/**
 * The facet half of the query as the API spells it — no paging, no sort, so
 * /api/facets and the list route can share it verbatim.
 */
export function facetParams(q: BrowseQuery): ApiParams {
  const p: ApiParams = {}
  if (q.era) p.era = q.era
  if (q.meter) p.meter = q.meter
  if (q.theme) p.theme = q.theme
  if (q.rawiyy) p.rhyme = q.rawiyy
  if (q.letter) p.first = q.letter
  return p
}

/**
 * The exact inverse of `facetParams`. Round-tripping these two is what keeps
 * «امسح الكل» and the applied-chips bar honest about which chip a count belongs
 * to; `browseQuery.test.ts` pins it over every facet combination.
 */
export function fromFacetParams(p: ApiParams): BrowseQuery {
  const q: BrowseQuery = {}
  if (typeof p.era === "string" && p.era) q.era = p.era
  if (typeof p.meter === "string" && p.meter) q.meter = p.meter
  if (typeof p.theme === "string" && p.theme) q.theme = p.theme
  if (typeof p.rhyme === "string" && p.rhyme) q.rawiyy = p.rhyme
  if (typeof p.first === "string" && p.first) q.letter = p.first
  return q
}

/**
 * The full list request. `seed` is only sent for sort=random and is derived
 * from the FACET STATE, not the page — that is what makes a shuffled browse
 * stable as the reader pages through it (design-ux.md §3).
 */
export function listParams(q: BrowseQuery, page: number, limit = BROWSE_PAGE): ApiParams {
  const p: ApiParams = { ...facetParams(q), page, limit: Math.min(limit, LIMITS.maxLimit) }
  if (isBaytMode(q)) return p
  const sort = apiSort(q.sort)
  p.sort = sort
  if (sort === "random") p.seed = seedOf(q)
  return p
}

/** A stable seed for `sort=random`: the facet state, and nothing else. */
export function seedOf(q: BrowseQuery): string {
  const { sort: _sort, page: _page, ...facets } = q
  return `browse:${browseQueryString(facets)}`
}

/** Set/clear one facet; changing any facet always returns to page 1. */
export function withFacet(q: BrowseQuery, key: FacetKey, value: string | undefined): BrowseQuery {
  const next: BrowseQuery = { ...q }
  if (value === undefined || value === "" || next[key] === value) delete next[key]
  else next[key] = value
  delete next.page
  return next
}

/** «امسح الكل» — keeps the sort, drops every facet and the page. */
export function clearFacets(q: BrowseQuery): BrowseQuery {
  const next: BrowseQuery = {}
  if (q.sort) next.sort = q.sort
  return next
}

export type AppliedChip = { key: FacetKey; value: string; label: string; kind: "era" | "meter" | "theme" | "letter" }

/**
 * The dismissible chips above the results. Slugs are resolved to their Arabic
 * names through /api/meta; an unknown slug still gets a chip carrying the raw
 * value, because the server answers an unknown slug with an empty result rather
 * than a 400 and the reader must be able to take it back off.
 */
export function appliedChips(q: BrowseQuery, meta: MetaResponse | null): AppliedChip[] {
  const out: AppliedChip[] = []
  if (q.era) out.push({ key: "era", value: q.era, kind: "era", label: nameOf(meta?.eras, q.era) })
  if (q.meter) out.push({ key: "meter", value: q.meter, kind: "meter", label: nameOf(meta?.meters, q.meter) })
  if (q.theme) out.push({ key: "theme", value: q.theme, kind: "theme", label: displayOf(meta, q.theme) })
  if (q.rawiyy)
    out.push({ key: "rawiyy", value: q.rawiyy, kind: "letter", label: `قافية ${letterName(q.rawiyy)}` })
  if (q.letter)
    out.push({ key: "letter", value: q.letter, kind: "letter", label: `مطلع بـ${letterName(q.letter)}` })
  return out
}

function nameOf(rows: readonly { slug: string; name: string }[] | undefined, slug: string): string {
  return rows?.find((r) => r.slug === slug)?.name ?? slug
}

function displayOf(meta: MetaResponse | null, slug: string): string {
  const t = meta?.themes.find((r) => r.slug === slug)
  return t?.display ?? t?.name ?? slug
}

export function letterName(letter: string): string {
  return LETTER_NAMES[letter as HijaiLetter] ?? letter
}

/** Hash string → BrowseQuery, for the tests and for anything reading a link. */
export function browseQueryFromString(qs: string): BrowseQuery {
  return parseBrowseQuery(new URLSearchParams(qs))
}
