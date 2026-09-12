import { describe, expect, it } from "vitest"
import {
  browseQueryString,
  isEmptyBrowseQuery,
  parseBrowseQuery,
  pageKey,
  parseHash,
  parseQafiyaQuery,
  qafiyaQueryString,
  routeHash,
  routeTitle,
  sharePathToHash,
  type BrowseQuery,
  type QafiyaQuery,
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
  { view: "poem", id: "16182", read: true },
  { view: "poem", id: "q4211", bayt: 12, read: true },
  { view: "browse", query: {} },
  { view: "browse", query: { era: "jahili" } },
  { view: "browse", query: { era: "jahili", meter: "tawil", theme: "madh", rawiyy: "ل", letter: "ب" } },
  { view: "browse", query: { meter: "kamil", sort: "random", page: 3 } },
  { view: "qafiya", query: {} },
  { view: "qafiya", query: { rawiyy: "ر" } },
  { view: "qafiya", query: { rawiyy: "ب", meter: "tawil", era: "abbasi" } },
  { view: "qafiya", query: { rawiyy: "م", page: 3 } },
  { view: "buhur" },
  { view: "buhur", bahr: "tawil" },
  { view: "buhur", bahr: "mutadarik" },
  { view: "search", q: "", page: 1 },
  { view: "search", q: "الخيل والليل", page: 1 },
  { view: "search", q: "قافية", page: 4 },
  { view: "wander" },
  { view: "duel" },
  { view: "duel", poet: "mutanabi" },
  { view: "duel", poet: "الاخطل-الصغير" },
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
  { view: "anthology" },
  { view: "anthology-shelf", slug: "muallaqat" },
  { view: "anthology-shelf", slug: "sair" },
  { view: "privacy" },
  { view: "diwans" },
  { view: "diwan", code: "BADIRUMAKE" },
  { view: "profile", username: "labid" },
  { view: "profile", username: "المتنبي" },
  { view: "room", code: "BADIRU" },
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

  it("reads `?read=1` as وضع القراءة, and anything else as not it", () => {
    expect(parseHash("#/poem/16182?read=1")).toEqual({ view: "poem", id: "16182", read: true })
    expect(parseHash("#/poem/16182?bayt=3&read=1")).toEqual({ view: "poem", id: "16182", bayt: 3, read: true })
    // the flag is a switch: only its one canonical value turns it on
    expect(parseHash("#/poem/16182?read=0")).toEqual({ view: "poem", id: "16182" })
    expect(parseHash("#/poem/16182?read=true")).toEqual({ view: "poem", id: "16182" })
    expect(parseHash("#/poem/16182?read=")).toEqual({ view: "poem", id: "16182" })
  })

  it("entering and leaving a reading is not arriving at a new page", () => {
    // pageKey decides whether the window jumps to the top (App.tsx); a قصيدة
    // being read is the same قصيدة, and its own offset is restored by the store.
    expect(pageKey({ view: "poem", id: "q1", read: true })).toBe(pageKey({ view: "poem", id: "q1" }))
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
      pageKey({ view: "room", code: "BADIRU" }),
      pageKey({ view: "room", code: "KOSEMA" }),
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

describe("#/room/<code> (v2.md §5)", () => {
  it("accepts a code however it was typed and canonicalizes it to upper", () => {
    // The code is SPOKEN before it is typed, so «badiru» off a phone call and
    // «BADIRU» off the share link have to be the same room — one URL, though.
    expect(parseHash("#/room/badiru")).toEqual({ view: "room", code: "BADIRU" })
    expect(parseHash("#/room/BaDiRu")).toEqual({ view: "room", code: "BADIRU" })
    expect(routeHash({ view: "room", code: "BADIRU" })).toBe("#/room/BADIRU")
  })

  it("carries the invite key out of the share link and back into the hash", () => {
    // `#/room/<CODE>?k=<key>` — the code names the room and is spoken aloud;
    // the key is what proves you were given the link (server/rooms.ts).
    expect(parseHash("#/room/badiru?k=abc23xyz")).toEqual({ view: "room", code: "BADIRU", key: "abc23xyz" })
    expect(routeHash({ view: "room", code: "BADIRU", key: "abc23xyz" })).toBe("#/room/BADIRU?k=abc23xyz")
    // A room reached without one is still a room — the server decides what it
    // will show a reader who has no key.
    expect(parseHash("#/room/BADIRU")).toEqual({ view: "room", code: "BADIRU" })
  })

  it("falls back to home for anything that is not six letters", () => {
    for (const bad of ["#/room/", "#/room/ABC", "#/room/ABCDEFG", "#/room/BAD1RU", "#/room/بديرو"]) {
      expect(parseHash(bad)).toEqual({ view: "home" })
    }
  })

  it("is titled مساجلة الأصدقاء", () => {
    expect(routeTitle({ view: "room", code: "BADIRU" })).toBe("مساجلة الأصدقاء")
  })
})

describe("#/anthology — المختارات المنظومة", () => {
  it("takes a shelf slug the curated table actually names", () => {
    expect(parseHash("#/anthology/muallaqat")).toEqual({ view: "anthology-shelf", slug: "muallaqat" })
    expect(parseHash("#/anthology/sair")).toEqual({ view: "anthology-shelf", slug: "sair" })
  })

  it("falls back to the shelf strip for an unknown slug, not to home", () => {
    // A mistyped shelf is still a request for المختارات المنظومة; throwing the
    // reader back to `#/` would lose the section they asked for. An unknown
    // شاعر slug goes home because there is no index of one شاعر to fall to.
    expect(parseHash("#/anthology/mualaqat")).toEqual({ view: "anthology" })
    expect(parseHash("#/anthology/")).toEqual({ view: "anthology" })
  })

  it("titles the shelf page with the SHELF's own name", () => {
    expect(routeTitle({ view: "anthology" })).toBe("المختارات المنظومة")
    expect(routeTitle({ view: "anthology-shelf", slug: "muallaqat" })).toBe("المعلقات")
    expect(routeTitle({ view: "anthology-shelf", slug: "sair" })).toBe("مئة بيت سائر")
  })

  it("makes each shelf its own PAGE, so switching shelves starts at the top", () => {
    expect(pageKey({ view: "anthology-shelf", slug: "muallaqat" })).not.toBe(
      pageKey({ view: "anthology-shelf", slug: "sair" }),
    )
  })
})

describe("#/qafiya — باحث القافية", () => {
  const parse = (qs: string): QafiyaQuery => parseQafiyaQuery(new URLSearchParams(qs))

  it("keeps the روي, the بحر and the عصر, and drops nothing else silently", () => {
    expect(parse("rawiyy=ر&meter=kamil&era=abbasi&p=2")).toEqual({
      rawiyy: "ر",
      meter: "kamil",
      era: "abbasi",
      page: 2,
    })
  })

  it("emits its keys in one stable order, so one hunt has one URL", () => {
    const q: QafiyaQuery = { era: "jahili", page: 4, meter: "wafir", rawiyy: "ل" }
    expect(qafiyaQueryString(q)).toBe("rawiyy=%D9%84&meter=wafir&era=jahili&p=4")
  })

  it("omits page 1 and an empty hunt", () => {
    expect(qafiyaQueryString({})).toBe("")
    expect(qafiyaQueryString({ rawiyy: "د", page: 1 })).toBe("rawiyy=%D8%AF")
    expect(routeHash({ view: "qafiya", query: {} })).toBe("#/qafiya")
  })

  it("takes only a real بحر — a قافية is not hunted on الموشح", () => {
    // «الموشح» and «شعر التفعيلة» are legal `meters` rows and legal
    // `#/browse?meter=` values; they are not بحور, and this page's بحر
    // narrowing is a list of sixteen.
    expect(parse("rawiyy=ب&meter=muwashah")).toEqual({ rawiyy: "ب" })
    expect(parse("rawiyy=ب&meter=taf3ila")).toEqual({ rawiyy: "ب" })
    expect(parse("rawiyy=ب&meter=tawil")).toEqual({ rawiyy: "ب", meter: "tawil" })
  })

  it("drops an unfolded or invented روي instead of asking the server about it", () => {
    for (const bad of ["ة", "أ", "ى", "x", "بب", ""]) {
      expect(parse(`rawiyy=${encodeURIComponent(bad)}`), bad).toEqual({})
    }
  })

  it("is ONE page while the poet refines the hunt — the روي grid is at its top", () => {
    // Same rule as #/browse: choosing another روي or pressing «المزيد» must not
    // throw the reader back to the top of a list they are reading.
    expect(pageKey({ view: "qafiya", query: { rawiyy: "ر" } })).toBe(
      pageKey({ view: "qafiya", query: { rawiyy: "م", meter: "tawil", page: 3 } }),
    )
  })

  it("is titled باحث القافية", () => {
    expect(routeTitle({ view: "qafiya", query: {} })).toBe("باحث القافية")
  })
})

describe("#/duel?poet= — مساجلة في ديوان شاعرٍ بعينه", () => {
  it("carries a شاعر into the setup screen, and drops what is not one", () => {
    expect(parseHash("#/duel?poet=mutanabi")).toEqual({ view: "duel", poet: "mutanabi" })
    // a poet slug is not ascii — 92K rows fall back to one derived from the name
    expect(parseHash("#/duel?poet=%D8%A7%D9%84%D8%AE%D9%86%D8%B3%D8%A7%D8%A1")).toEqual({
      view: "duel",
      poet: "الخنساء",
    })
    expect(parseHash("#/duel?poet=")).toEqual({ view: "duel" })
    expect(parseHash("#/duel?poet=has%20a%20space")).toEqual({ view: "duel" })
    expect(parseHash("#/duel?poet=a/b")).toEqual({ view: "duel" })
    // …and the two sub-screens never take one: they read the session, not a URL
    expect(parseHash("#/duel/play?poet=mutanabi")).toEqual({ view: "duel-play" })
    expect(parseHash("#/duel/summary?poet=mutanabi")).toEqual({ view: "duel-summary" })
  })

  it("writes the شاعر back, and nothing when there is none", () => {
    expect(routeHash({ view: "duel" })).toBe("#/duel")
    expect(routeHash({ view: "duel", poet: "mutanabi" })).toBe("#/duel?poet=mutanabi")
    expect(routeHash({ view: "duel", poet: "الخنساء" })).toBe(
      "#/duel?poet=%D8%A7%D9%84%D8%AE%D9%86%D8%B3%D8%A7%D8%A1",
    )
  })

  it("stays ONE page — choosing a شاعر is not arriving somewhere new", () => {
    // The chip is set and cleared in place (and the setup screen keeps the hash
    // honest with a `replace`), so a jump to the top would throw the reader off
    // the control they just used.
    expect(pageKey({ view: "duel", poet: "mutanabi" })).toBe(pageKey({ view: "duel" }))
  })
})

describe("#/buhur — صفحة البحور", () => {
  it("opens on one of the SIXTEEN, and drops anything else", () => {
    expect(parseHash("#/buhur?b=khafif")).toEqual({ view: "buhur", bahr: "khafif" })
    // real `meters` rows, but not بحور — this page has no card for them
    expect(parseHash("#/buhur?b=muwashah")).toEqual({ view: "buhur" })
    expect(parseHash("#/buhur?b=amudi")).toEqual({ view: "buhur" })
    expect(parseHash("#/buhur?b=nope")).toEqual({ view: "buhur" })
    expect(parseHash("#/buhur")).toEqual({ view: "buhur" })
  })

  it("stays ONE page whichever card it opens on — `?b=` is a scroll target", () => {
    // The other fifteen cards are still on the screen; jumping to the top on a
    // `?b=` change would undo the very scroll the parameter asked for.
    expect(pageKey({ view: "buhur", bahr: "tawil" })).toBe(pageKey({ view: "buhur" }))
  })

  it("is titled البحور", () => {
    expect(routeTitle({ view: "buhur" })).toBe("البحور")
  })
})

describe("الدواوين (#/diwans, #/diwan/<CODE>)", () => {
  it("upper-cases a spoken code, the way a room code is canonicalized", () => {
    // A ديوان's link is read aloud and photographed too, so «badirumake» and
    // «BADIRUMAKE» must be one URL and one shelf.
    expect(parseHash("#/diwan/badirumake")).toEqual({ view: "diwan", code: "BADIRUMAKE" })
    expect(routeHash(parseHash("#/diwan/badirumake"))).toBe("#/diwan/BADIRUMAKE")
  })

  it("takes TEN letters and refuses a room's six", () => {
    // The room code is a NAME with `join_key` behind it; here the code IS the
    // capability, so the two shapes must not be confusable.
    expect(parseHash("#/diwan/BADIRU")).toEqual({ view: "diwans" })
    expect(parseHash("#/diwan/BADIRUMAK3")).toEqual({ view: "diwans" })
    expect(parseHash("#/diwan/AAAAAAAAAA")).toEqual({ view: "diwans" })
  })

  it("falls back to «دواويني» rather than home — a bad code is still this feature", () => {
    expect(parseHash("#/diwan/")).toEqual({ view: "diwans" })
  })

  it("keys a shelf on its code, so two دواوين are two pages", () => {
    expect(pageKey({ view: "diwan", code: "BADIRUMAKE" })).not.toBe(pageKey({ view: "diwan", code: "ZOTELUFIKA" }))
  })
})

describe("sharePathToHash", () => {
  it("folds a shared /p/<id> link into the app's own hash route", () => {
    expect(sharePathToHash("/p/16182", "")).toBe("/#/poem/16182")
    expect(sharePathToHash("/p/16182/", "")).toBe("/#/poem/16182")
  })

  it("leaves every other path alone", () => {
    for (const p of ["/", "/poem/16182", "/p", "/p/", "/p/a/b", "/assets/index.js"]) {
      expect(sharePathToHash(p, "")).toBeNull()
    }
  })

  it("defers to an explicit hash, which is the more specific instruction", () => {
    expect(sharePathToHash("/p/16182", "#/poem/99?bayt=4")).toBeNull()
  })

  it("hands back a path the router can parse", () => {
    const folded = sharePathToHash("/p/16182", "")!
    expect(parseHash(folded.slice(1))).toEqual({ view: "poem", id: "16182" })
  })
})
