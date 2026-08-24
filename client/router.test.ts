import { describe, expect, it } from "vitest"
import {
  browseQueryString,
  isEmptyBrowseQuery,
  parseBrowseQuery,
  pageKey,
  parseHash,
  routeHash,
  routeTitle,
  type BrowseQuery,
  type Route,
} from "./router.ts"

/** Every canonical route, one of each shape in design-ux.md §1. */
const CANONICAL: Route[] = [
  { view: "home" },
  { view: "poets" },
  { view: "poets", era: "abbasi" },
  { view: "poets", era: "abbasi", letter: "م" },
  { view: "poets", letter: "ع" },
  { view: "poet", slug: "almutanabbi" },
  { view: "poet", slug: "المتنبي" },
  { view: "poem", id: "16182" },
  { view: "poem", id: "q4211" },
  { view: "poem", id: "16182", bayt: 7 },
  { view: "browse", query: {} },
  { view: "browse", query: { era: "jahili" } },
  { view: "browse", query: { era: "jahili", meter: "tawil", theme: "madh", rawiyy: "ل", letter: "ب" } },
  { view: "browse", query: { meter: "kamil", sort: "random", page: 3 } },
  { view: "search", q: "", page: 1 },
  { view: "search", q: "الخيل والليل", page: 1 },
  { view: "search", q: "قافية", page: 4 },
  { view: "wander" },
  { view: "duel" },
  { view: "duel-play" },
  { view: "duel-summary" },
  { view: "daily" },
  { view: "train" },
  { view: "train-drill" },
  { view: "train-drill", letter: "ظ" },
  { view: "train-arsenal" },
  { view: "stats" },
  { view: "favorites" },
  { view: "favorites", collection: "المفضلة الأولى" },
  { view: "rules" },
  { view: "profile", username: "labid" },
  { view: "profile", username: "المتنبي" },
]

describe("parseHash / routeHash", () => {
  it("round-trips every canonical route", () => {
    for (const r of CANONICAL) {
      expect(parseHash(routeHash(r)), routeHash(r)).toEqual(r)
    }
  })

  it("is idempotent — canonicalizing twice changes nothing", () => {
    for (const r of CANONICAL) {
      const once = routeHash(r)
      expect(routeHash(parseHash(once))).toBe(once)
    }
  })

  it("accepts a bare or missing hash as home", () => {
    for (const h of ["", "#", "#/", "/", "#//"]) {
      expect(parseHash(h)).toEqual({ view: "home" })
    }
  })

  it("falls back to home on anything unknown", () => {
    for (const h of ["#/nope", "#/poet", "#/poem", "#/poem/../etc", "#/%%%", "#/duel/nonsense/deep"]) {
      const r = parseHash(h)
      expect(["home", "duel"]).toContain(r.view)
    }
    expect(parseHash("#/nope")).toEqual({ view: "home" })
    expect(parseHash("#/poet")).toEqual({ view: "home" })
    expect(parseHash("#/poem")).toEqual({ view: "home" })
  })

  it("maps duel and train sub-paths, and unknown sub-paths to the hub", () => {
    expect(parseHash("#/duel/play").view).toBe("duel-play")
    expect(parseHash("#/duel/summary").view).toBe("duel-summary")
    expect(parseHash("#/duel/xyz").view).toBe("duel")
    expect(parseHash("#/train/drill").view).toBe("train-drill")
    expect(parseHash("#/train/arsenal").view).toBe("train-arsenal")
    expect(parseHash("#/train/xyz").view).toBe("train")
  })

  it("keeps a poem's bayt anchor and drops a nonsense one", () => {
    expect(parseHash("#/poem/16182?bayt=7")).toEqual({ view: "poem", id: "16182", bayt: 7 })
    expect(parseHash("#/poem/16182?bayt=0")).toEqual({ view: "poem", id: "16182" })
    expect(parseHash("#/poem/16182?bayt=abc")).toEqual({ view: "poem", id: "16182" })
  })

  it("rejects a poem id that is not <digits> or q<digits>", () => {
    expect(parseHash("#/poem/../../secret")).toEqual({ view: "home" })
    expect(parseHash("#/poem/abc")).toEqual({ view: "home" })
    expect(parseHash("#/poem/q12")).toEqual({ view: "poem", id: "q12" })
  })

  it("carries a non-ascii poet slug through the URL intact", () => {
    const hash = routeHash({ view: "poet", slug: "أبو-الطيب" })
    expect(hash.startsWith("#/poet/")).toBe(true)
    expect(parseHash(hash)).toEqual({ view: "poet", slug: "أبو-الطيب" })
  })

  it("gives every route an Arabic title", () => {
    for (const r of CANONICAL) {
      const t = routeTitle(r)
      expect(t.length).toBeGreaterThan(0)
      expect(/[؀-ۿ]/.test(t)).toBe(true)
    }
  })
})

describe("browse facet encoding", () => {
  const full: BrowseQuery = {
    era: "abbasi",
    meter: "tawil",
    theme: "madh",
    rawiyy: "ر",
    letter: "ب",
    sort: "length",
    page: 5,
  }

  it("round-trips a full facet set", () => {
    const qs = browseQueryString(full)
    expect(parseBrowseQuery(new URLSearchParams(qs))).toEqual(full)
  })

  it("emits keys in a stable order so one state has one URL", () => {
    expect(browseQueryString(full)).toBe(
      "era=abbasi&meter=tawil&theme=madh&rawiyy=%D8%B1&letter=%D8%A8&sort=length&p=5",
    )
    // key order in the input object must not matter
    const shuffled: BrowseQuery = { page: 5, sort: "length", letter: "ب", rawiyy: "ر", theme: "madh", meter: "tawil", era: "abbasi" }
    expect(browseQueryString(shuffled)).toBe(browseQueryString(full))
  })

  it("omits page 1 and an empty facet set", () => {
    expect(browseQueryString({ page: 1 })).toBe("")
    expect(browseQueryString({})).toBe("")
    expect(routeHash({ view: "browse", query: {} })).toBe("#/browse")
  })

  it("drops invalid facet values instead of guessing", () => {
    const q = parseBrowseQuery(
      new URLSearchParams("era=ABBASI&meter=tawil&theme=&rawiyy=x&letter=أ&sort=bogus&p=-4"),
    )
    expect(q).toEqual({ meter: "tawil" })
  })

  it("only counts facets, not sort or page, as 'applied'", () => {
    expect(isEmptyBrowseQuery({})).toBe(true)
    expect(isEmptyBrowseQuery({ sort: "random", page: 9 })).toBe(true)
    expect(isEmptyBrowseQuery({ rawiyy: "م" })).toBe(false)
  })

  it("accepts all 28 folded letters as رويّ and rejects unfolded forms", () => {
    for (const l of "ابتثجحخدذرزسشصضطظعغفقكلمنهوي") {
      expect(parseBrowseQuery(new URLSearchParams(`rawiyy=${encodeURIComponent(l)}`)).rawiyy).toBe(l)
    }
    for (const l of ["أ", "إ", "آ", "ة", "ى", "ؤ", "ئ", "ء"]) {
      expect(parseBrowseQuery(new URLSearchParams(`rawiyy=${encodeURIComponent(l)}`)).rawiyy).toBeUndefined()
    }
  })
})

describe("search route", () => {
  it("keeps the query verbatim, including spaces", () => {
    const r = parseHash(routeHash({ view: "search", q: "الخيل والليل والبيداء", page: 1 }))
    expect(r).toEqual({ view: "search", q: "الخيل والليل والبيداء", page: 1 })
  })

  it("clamps a bad page to 1", () => {
    expect(parseHash("#/search?q=x&p=0")).toEqual({ view: "search", q: "x", page: 1 })
    expect(parseHash("#/search?q=x&p=nope")).toEqual({ view: "search", q: "x", page: 1 })
    expect(parseHash("#/search?q=x&p=2")).toEqual({ view: "search", q: "x", page: 2 })
  })
})

describe("pageKey — what counts as arriving somewhere new (App.tsx scroll reset)", () => {
  it("is stable while a reader pages or refilters INSIDE one view", () => {
    // «المزيد» writes `?p=2` into the hash; jumping to the top there would
    // throw away the position of the rows it just loaded.
    expect(pageKey({ view: "browse", query: {} })).toBe(pageKey({ view: "browse", query: { era: "abbasi", page: 4 } }))
    expect(pageKey({ view: "search", q: "الخيل", page: 1 })).toBe(pageKey({ view: "search", q: "الخيل", page: 3 }))
    expect(pageKey({ view: "poem", id: "q1", bayt: 1 })).toBe(pageKey({ view: "poem", id: "q1", bayt: 40 }))
  })

  it("changes for every navigation a reader would call a new page", () => {
    const keys = [
      pageKey({ view: "home" }),
      pageKey({ view: "poets" }),
      pageKey({ view: "poets", letter: "م" }),
      pageKey({ view: "poet", slug: "mutanabi" }),
      pageKey({ view: "poet", slug: "albohtry" }),
      pageKey({ view: "poem", id: "q1" }),
      pageKey({ view: "poem", id: "q2" }),
      pageKey({ view: "browse", query: {} }),
      pageKey({ view: "search", q: "أ", page: 1 }),
      pageKey({ view: "search", q: "ب", page: 1 }),
      pageKey({ view: "train-drill" }),
      pageKey({ view: "train-drill", letter: "ر" }),
      pageKey({ view: "favorites" }),
      pageKey({ view: "favorites", collection: "c1" }),
      pageKey({ view: "duel" }),
      pageKey({ view: "duel-summary" }),
      pageKey({ view: "profile", username: "labid" }),
      pageKey({ view: "profile", username: "khansa" }),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("#/u/<username> (v2.md §4)", () => {
  it("round-trips a Latin and an Arabic handle", () => {
    expect(parseHash("#/u/labid")).toEqual({ view: "profile", username: "labid" })
    expect(routeHash({ view: "profile", username: "المتنبي" })).toBe(`#/u/${encodeURIComponent("المتنبي")}`)
    expect(parseHash(routeHash({ view: "profile", username: "المتنبي" }))).toEqual({
      view: "profile",
      username: "المتنبي",
    })
  })

  it("falls back to home for anything that is not a legal username", () => {
    // The shape is UsernameSchema's, so the router refuses what the API would.
    for (const bad of ["#/u/", "#/u/ab", "#/u/-nope", "#/u/" + "x".repeat(25)]) {
      expect(parseHash(bad)).toEqual({ view: "home" })
    }
  })

  it("is titled الحساب", () => {
    expect(routeTitle({ view: "profile", username: "labid" })).toBe("الحساب")
  })
})
