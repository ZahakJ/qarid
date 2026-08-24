/**
 * #/browse — the URL owns the facet state (design-ux.md §1, §3), so the
 * translation layer between the hash and the API is the thing that has to be
 * exactly reversible. Three round trips are pinned here:
 *
 *   hash string  ⇄  BrowseQuery      (router.parseBrowseQuery / browseQueryString)
 *   BrowseQuery  ⇄  API params       (facetParams / fromFacetParams)
 *   BrowseQuery  →  the unit of the answer (isBaytMode) and the sample seed
 *
 * Two vocabularies meet and are deliberately NOT the same words: the URL says
 * `rawiyy` and `letter`, the API says `rhyme` and `first`. Every test below
 * exists because getting that mapping backwards would silently filter on the
 * wrong dimension and still return plausible-looking قصائد.
 */
import { describe, expect, it } from "vitest"
import {
  BROWSE_PAGE,
  BROWSE_SORTS,
  FACET_KEYS,
  FACET_LABEL,
  apiSort,
  appliedChips,
  browseQueryFromString,
  clearFacets,
  facetParams,
  fromFacetParams,
  hasFacets,
  isBaytMode,
  letterName,
  listParams,
  seedOf,
  withFacet,
} from "./browseQuery.ts"
import { browseQueryString, parseHash, routeHash, type BrowseQuery } from "../router.ts"
import { LIMITS, type MetaResponse } from "../../shared/schema.ts"

/** Every shape a #/browse URL can legally carry. */
const CASES: BrowseQuery[] = [
  {},
  { era: "abbasi" },
  { meter: "tawil" },
  { theme: "madh" },
  { rawiyy: "م" },
  { letter: "ا" },
  { era: "jahili", meter: "kamil" },
  { era: "andalus", meter: "basit", theme: "ghazal" },
  { rawiyy: "ب", letter: "و" },
  { era: "abbasi", meter: "tawil", theme: "hija", rawiyy: "ل", letter: "ي" },
  { sort: "length" },
  { sort: "random", era: "umawi" },
  { era: "abbasi", page: 4 },
  { era: "abbasi", meter: "wafir", sort: "random", page: 12 },
]

describe("hash ⇄ BrowseQuery", () => {
  it("round-trips every facet combination through the query string", () => {
    for (const q of CASES) {
      expect(browseQueryFromString(browseQueryString(q)), JSON.stringify(q)).toEqual(q)
    }
  })

  it("round-trips through the full route hash", () => {
    for (const q of CASES) {
      const hash = routeHash({ view: "browse", query: q })
      expect(parseHash(hash), hash).toEqual({ view: "browse", query: q })
    }
  })

  it("gives one facet state exactly one URL, whatever order it was built in", () => {
    const a: BrowseQuery = { era: "abbasi", meter: "tawil", rawiyy: "م" }
    const b: BrowseQuery = { rawiyy: "م", meter: "tawil", era: "abbasi" }
    expect(browseQueryString(a)).toBe(browseQueryString(b))
  })

  it("drops values the server could never accept rather than guessing", () => {
    // page 1 is canonical and never written; an unknown sort and a non-letter
    // رويّ are dropped, so a hand-edited URL degrades instead of 400ing
    expect(browseQueryFromString("p=1")).toEqual({})
    expect(browseQueryFromString("sort=sideways")).toEqual({})
    expect(browseQueryFromString("rawiyy=xy")).toEqual({})
    expect(browseQueryFromString("letter=%D8%A3")).toEqual({}) // أ is not one of the 28 folded letters
    expect(browseQueryFromString("era=NOT A SLUG")).toEqual({})
  })

  it("keeps an unknown but well-formed slug — the server answers it empty, not 400", () => {
    expect(browseQueryFromString("era=nope")).toEqual({ era: "nope" })
  })
})

describe("BrowseQuery ⇄ API params", () => {
  it("round-trips the facet half in both directions", () => {
    for (const q of CASES) {
      const facets: BrowseQuery = {}
      for (const k of FACET_KEYS) if (q[k] !== undefined) facets[k] = q[k]
      expect(fromFacetParams(facetParams(q)), JSON.stringify(q)).toEqual(facets)
    }
  })

  it("renames رويّ → rhyme and حرف البداية → first", () => {
    expect(facetParams({ rawiyy: "م", letter: "ا" })).toEqual({ rhyme: "م", first: "ا" })
    expect(fromFacetParams({ rhyme: "م", first: "ا" })).toEqual({ rawiyy: "م", letter: "ا" })
  })

  it("never sends sort or page as a facet", () => {
    expect(facetParams({ era: "abbasi", sort: "random", page: 9 })).toEqual({ era: "abbasi" })
  })

  it("ignores empty and non-string values on the way back", () => {
    expect(fromFacetParams({ era: "", meter: undefined, rhyme: 7 })).toEqual({})
  })
})

describe("isBaytMode", () => {
  it("switches the unit of the answer to the بيت when رويّ or حرف is applied", () => {
    expect(isBaytMode({ rawiyy: "م" })).toBe(true)
    expect(isBaytMode({ letter: "ا" })).toBe(true)
    expect(isBaytMode({ rawiyy: "م", letter: "ا" })).toBe(true)
  })

  it("leaves the unit as the قصيدة for every other facet", () => {
    expect(isBaytMode({})).toBe(false)
    expect(isBaytMode({ era: "abbasi", meter: "tawil", theme: "madh" })).toBe(false)
    expect(isBaytMode({ sort: "random", page: 3 })).toBe(false)
  })
})

describe("listParams", () => {
  it("clamps the limit to what the server will serve", () => {
    expect(listParams({}, 1).limit).toBe(BROWSE_PAGE)
    expect(listParams({}, 1, 5000).limit).toBe(LIMITS.maxLimit)
  })

  it("carries a stable seed for sort=random, derived from the FACETS only", () => {
    const q: BrowseQuery = { sort: "random", era: "abbasi" }
    const p1 = listParams(q, 1)
    const p9 = listParams({ ...q, page: 9 }, 9)
    expect(p1.seed).toBeTypeOf("string")
    // the same shuffle must survive paging, or «المزيد» re-deals the deck
    expect(p9.seed).toBe(p1.seed)
    expect(p9.page).toBe(9)
  })

  it("re-seeds when the facets change, so a new filter is a new shuffle", () => {
    expect(seedOf({ sort: "random", era: "abbasi" })).not.toBe(seedOf({ sort: "random", era: "umawi" }))
    expect(seedOf({ sort: "random", era: "abbasi", page: 2 })).toBe(seedOf({ sort: "random", era: "abbasi" }))
  })

  it("sends no seed and no sort in بيت mode — /api/baits has neither", () => {
    const p = listParams({ rawiyy: "م", sort: "random" }, 2)
    expect(p.sort).toBeUndefined()
    expect(p.seed).toBeUndefined()
    expect(p).toMatchObject({ rhyme: "م", page: 2 })
  })

  it("maps every offered sort onto one the API knows", () => {
    for (const s of BROWSE_SORTS) expect(["fame", "length", "random"]).toContain(apiSort(s.value))
    // `recent` still parses out of a URL (the router's type has it) and
    // degrades to الأشهر — the corpus carries no date on a قصيدة
    expect(apiSort("recent")).toBe("fame")
    expect(apiSort(undefined)).toBe("fame")
  })
})

describe("withFacet / clearFacets / hasFacets", () => {
  it("sets, replaces and toggles a facet off", () => {
    expect(withFacet({}, "era", "abbasi")).toEqual({ era: "abbasi" })
    expect(withFacet({ era: "abbasi" }, "era", "umawi")).toEqual({ era: "umawi" })
    // clicking the ACTIVE chip clears it
    expect(withFacet({ era: "abbasi" }, "era", "abbasi")).toEqual({})
    expect(withFacet({ era: "abbasi" }, "era", undefined)).toEqual({})
    expect(withFacet({ era: "abbasi" }, "era", "")).toEqual({})
  })

  it("always returns to page 1 when any facet changes", () => {
    expect(withFacet({ era: "abbasi", page: 7 }, "meter", "tawil")).toEqual({ era: "abbasi", meter: "tawil" })
    expect(withFacet({ era: "abbasi", page: 7 }, "era", undefined)).toEqual({})
  })

  it("keeps the sort but drops every facet and the page on «امسح الكل»", () => {
    expect(clearFacets({ era: "abbasi", rawiyy: "م", sort: "length", page: 4 })).toEqual({ sort: "length" })
    expect(clearFacets({})).toEqual({})
  })

  it("does not count sort or page as a facet", () => {
    expect(hasFacets({})).toBe(false)
    expect(hasFacets({ sort: "random", page: 3 })).toBe(false)
    expect(hasFacets({ theme: "madh" })).toBe(true)
  })
})

describe("appliedChips", () => {
  const meta = {
    eras: [{ slug: "abbasi", name: "العصر العباسي" }],
    meters: [{ slug: "tawil", name: "الطويل" }],
    themes: [{ slug: "madh", name: "قصيدة مدح", display: "مدح" }],
  } as unknown as MetaResponse

  it("resolves slugs to their Arabic names", () => {
    const chips = appliedChips({ era: "abbasi", meter: "tawil", theme: "madh" }, meta)
    expect(chips.map((c) => c.label)).toEqual(["العصر العباسي", "الطويل", "مدح"])
    expect(chips.map((c) => c.key)).toEqual(["era", "meter", "theme"])
  })

  it("names the two letter facets differently — قافية is not مطلع", () => {
    const chips = appliedChips({ rawiyy: "م", letter: "ا" }, meta)
    expect(chips.map((c) => c.label)).toEqual([`قافية ${letterName("م")}`, `مطلع بـ${letterName("ا")}`])
    expect(chips.every((c) => c.kind === "letter")).toBe(true)
  })

  it("still gives an unknown slug a chip, so the reader can take it off", () => {
    // the server answers an unknown slug with an empty result, not a 400 —
    // a facet with no chip would be an un-undoable dead end
    const chips = appliedChips({ era: "nope" }, meta)
    expect(chips).toHaveLength(1)
    expect(chips[0]!.label).toBe("nope")
  })

  it("survives having no /api/meta yet", () => {
    expect(appliedChips({ era: "abbasi" }, null)[0]!.label).toBe("abbasi")
    expect(appliedChips({}, null)).toEqual([])
  })

  it("lists chips in the rail's own order, and one per applied facet", () => {
    const q: BrowseQuery = { letter: "ي", theme: "madh", era: "abbasi", rawiyy: "م", meter: "tawil" }
    expect(appliedChips(q, meta).map((c) => c.key)).toEqual([...FACET_KEYS])
    expect(Object.keys(FACET_LABEL)).toEqual([...FACET_KEYS])
  })

  it("gives every chip a value that removes exactly itself", () => {
    const q: BrowseQuery = { era: "abbasi", meter: "tawil", rawiyy: "م" }
    for (const chip of appliedChips(q, meta)) {
      const after = withFacet(q, chip.key, undefined)
      expect(after[chip.key]).toBeUndefined()
      expect(hasFacets(after)).toBe(true) // the other two survive
    }
  })
})
