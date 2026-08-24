/**
 * The omnibox's decision layer (design-ux.md §3 Home): three groups —
 * شعراء · أبيات · قصائد, at most four rows each — walked by ↓/↑ as ONE list.
 *
 * Two things worth pinning beyond the obvious grouping:
 *  • an empty group is DROPPED, not rendered as a bare heading — the server
 *    sends all three arrays whatever the query matched;
 *  • a بيت suggestion navigates to its قصيدة at `?bayt=N`, never to a bare بيت
 *    page: the reader asked for a line and wants to land on it in context.
 */
import { describe, expect, it } from "vitest"
import {
  GROUP_LABEL,
  OMNIBOX_GROUP_LIMIT,
  flatten,
  groupSuggestions,
  moveCursor,
  suggestionHref,
  suggestionNote,
  suggestionTitle,
} from "./omnibox.ts"
import { SearchResponseSchema, type SearchResponse } from "../../shared/schema.ts"

// ── fixtures shaped exactly like /api/search?scope=all ─────────────────────

function poet(slug: string, name: string, era: string | null = "العصر العباسي") {
  return {
    slug,
    name,
    letter: "م",
    era: era ? { slug: "abbasi", name: era, sort: 5 } : null,
    location: "العراق",
    description: null,
    fame: 3,
    poemCount: 519,
    baitCount: 12_000,
    highlight: null,
    score: 9,
  }
}

function bait(id: number, poemId: string, position: number, sadr: string, ajuz: string | null) {
  return {
    id,
    baytKey: `${poemId}:${position}`,
    position,
    sadr,
    ajuz,
    rawiyy: "م",
    lastLetter: "م",
    firstLetter: "ا",
    isPartial: false,
    poem: { id: poemId, title: "بلا عنوان" },
    poet: { slug: "mutanabi", name: "المتنبي" },
    meter: { slug: "tawil", name: "الطويل", variant: null },
    era: null,
    highlight: "»الخيل« والليل",
    score: 7,
  }
}

function poem(id: string, title: string) {
  return {
    id,
    title,
    poet: { slug: "mutanabi", name: "المتنبي" },
    meter: null,
    theme: null,
    era: null,
    langType: null,
    rhyme: "م",
    rhymeShare: 1,
    firstLetter: "ا",
    baitCount: 12,
    hasTashkeel: true,
    previewSadr: "الخيل والليل",
    previewAjuz: "والبيداء تعرفني",
    highlight: null,
    score: 4,
  }
}

/**
 * Everything goes through the real schema — a fixture that would not survive
 * `client.ts` is not a fixture, it is a wish. The override bag is deliberately
 * loose: zod, not TypeScript, is what decides whether these rows are legal, so
 * a fixture that has drifted from the contract fails here as a THROWN parse
 * error rather than as a red squiggle the test could have been widened past.
 */
function response(over: Record<string, unknown> = {}): SearchResponse {
  return SearchResponseSchema.parse({
    q: "الخيل",
    scope: "all",
    mode: "and",
    baits: [],
    poems: [],
    poets: [],
    total: 0,
    page: 1,
    limit: 4,
    ms: 3.2,
    ...over,
  })
}

describe("groupSuggestions", () => {
  it("returns nothing at all before the first response", () => {
    expect(groupSuggestions(null)).toEqual([])
    expect(flatten(groupSuggestions(null))).toEqual([])
  })

  it("orders the groups شعراء · أبيات · قصائد", () => {
    const groups = groupSuggestions(
      response({
        poets: [poet("mutanabi", "المتنبي")],
        baits: [bait(1, "16182", 3, "الخيل والليل", "والبيداء تعرفني")],
        poems: [poem("q1", "على قدر أهل العزم")],
      }),
    )
    expect(groups.map((g) => g.kind)).toEqual(["poet", "bait", "poem"])
    expect(groups.map((g) => g.label)).toEqual([GROUP_LABEL.poet, GROUP_LABEL.bait, GROUP_LABEL.poem])
  })

  it("drops an empty group rather than rendering a bare heading", () => {
    const groups = groupSuggestions(response({ poets: [poet("mutanabi", "المتنبي")] }))
    expect(groups).toHaveLength(1)
    expect(groups[0]!.kind).toBe("poet")
    // the server sent all three arrays; two of them were empty
    expect(groups.every((g) => g.items.length > 0)).toBe(true)
  })

  it("caps each group at four rows", () => {
    const many = Array.from({ length: 9 }, (_, i) => poet(`p${i}`, `شاعر ${i}`))
    const groups = groupSuggestions(response({ poets: many }))
    expect(OMNIBOX_GROUP_LIMIT).toBe(4)
    expect(groups[0]!.items).toHaveLength(4)
    expect(groups[0]!.items.map((s) => suggestionTitle(s))).toEqual(["شاعر 0", "شاعر 1", "شاعر 2", "شاعر 3"])
  })

  it("honours an explicit limit, including zero", () => {
    const many = Array.from({ length: 5 }, (_, i) => poet(`p${i}`, `شاعر ${i}`))
    expect(groupSuggestions(response({ poets: many }), 2)[0]!.items).toHaveLength(2)
    // a cap of 0 empties every group, and empty groups are dropped
    expect(groupSuggestions(response({ poets: many }), 0)).toEqual([])
  })

  it("gives every suggestion a key unique across the three groups", () => {
    const groups = groupSuggestions(
      response({
        poets: [poet("a", "أ"), poet("b", "ب")],
        baits: [bait(1, "q7", 1, "ص", "ع"), bait(2, "q7", 2, "ص٢", "ع٢")],
        poems: [poem("q7", "قصيدة")],
      }),
    )
    const ids = flatten(groups).map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("routing", () => {
  it("sends a بيت to its قصيدة at the right بيت, not to a bare بيت page", () => {
    const [s] = flatten(groupSuggestions(response({ baits: [bait(41, "16182", 7, "ص", "ع")] })))
    expect(s!.route).toEqual({ view: "poem", id: "16182", bayt: 7 })
    expect(suggestionHref(s!)).toBe("#/poem/16182?bayt=7")
  })

  it("sends a شاعر to their page, percent-encoding an Arabic slug", () => {
    const [s] = flatten(groupSuggestions(response({ poets: [poet("ابن-الرومي", "ابن الرومي")] })))
    expect(s!.route).toEqual({ view: "poet", slug: "ابن-الرومي" })
    // 73% of the corpus has no source URL, so the fallback slug is Arabic
    expect(suggestionHref(s!)).toBe(`#/poet/${encodeURIComponent("ابن-الرومي")}`)
  })

  it("sends a قصيدة to its own page with no anchor", () => {
    const [s] = flatten(groupSuggestions(response({ poems: [poem("q110964", "نيرون")] })))
    expect(suggestionHref(s!)).toBe("#/poem/q110964")
  })
})

describe("suggestion text", () => {
  it("titles a row with the thing the reader searched for", () => {
    const groups = groupSuggestions(
      response({
        poets: [poet("mutanabi", "المتنبي")],
        baits: [bait(1, "q1", 1, "الخيل والليل والبيداء", "والسيف والرمح")],
        poems: [poem("q1", "على قدر أهل العزم")],
      }),
    )
    const [p, b, q] = flatten(groups)
    expect(suggestionTitle(p!)).toBe("المتنبي")
    expect(suggestionTitle(b!)).toBe("الخيل والليل والبيداء")
    expect(suggestionTitle(q!)).toBe("على قدر أهل العزم")
  })

  it("notes who said it and where, and falls back when a عجز is missing", () => {
    const groups = groupSuggestions(
      response({
        poets: [poet("mutanabi", "المتنبي")],
        baits: [bait(1, "q1", 1, "صدر", null)],
        poems: [poem("q1", "عنوان")],
      }),
    )
    const [p, b, q] = flatten(groups)
    expect(suggestionNote(p!)).toBe("العصر العباسي")
    // an is_partial بيت has no عجز; the شاعر stands in
    expect(suggestionNote(b!)).toBe("المتنبي")
    expect(suggestionNote(q!)).toBe("المتنبي")
  })

  it("falls back to the بلد when a شاعر has no عصر", () => {
    const [s] = flatten(groupSuggestions(response({ poets: [poet("x", "س", null)] })))
    expect(suggestionNote(s!)).toBe("العراق")
  })
})

describe("moveCursor", () => {
  it("enters the list from the field with ↓ and from the end with ↑", () => {
    expect(moveCursor(-1, 1, 5)).toBe(0)
    expect(moveCursor(-1, -1, 5)).toBe(4)
  })

  it("steps back out of the list at the top, so ↑ returns focus to the field", () => {
    expect(moveCursor(0, -1, 5)).toBe(-1)
  })

  it("wraps to the first row at the bottom", () => {
    expect(moveCursor(4, 1, 5)).toBe(0)
  })

  it("walks the three groups as one list", () => {
    const groups = groupSuggestions(
      response({
        poets: [poet("a", "أ")],
        baits: [bait(1, "q1", 1, "ص", "ع")],
        poems: [poem("q1", "ق")],
      }),
    )
    const flat = flatten(groups)
    expect(flat).toHaveLength(3)
    // ↓ ↓ ↓ crosses from شعراء into أبيات into قصائد without a stop
    let c = -1
    const walked: string[] = []
    for (let i = 0; i < 3; i++) {
      c = moveCursor(c, 1, flat.length)
      walked.push(flat[c]!.kind)
    }
    expect(walked).toEqual(["poet", "bait", "poem"])
  })

  it("has nowhere to go in an empty list", () => {
    expect(moveCursor(-1, 1, 0)).toBe(-1)
    expect(moveCursor(3, -1, 0)).toBe(-1)
  })
})
