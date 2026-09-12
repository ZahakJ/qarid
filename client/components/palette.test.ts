/**
 * The global palette's decision layer (v2.md §3).
 *
 * What is pinned here is everything the overlay itself only *renders*: which
 * groups exist and how many rows each may show, what one keystroke means to an
 * open palette (including the two chords that open it, on an Arabic layout as
 * well as a Latin one), and the one piece of query syntax the footer promises —
 * the trailing star. A footer that stops saying `*` is a feature that silently
 * disappears, so it is asserted like any other behaviour.
 */
import { describe, expect, it } from "vitest"
import {
  GROUP_LABEL,
  PALETTE_FETCH_LIMIT,
  PALETTE_ALL_KEYS,
  PALETTE_ALL_LABEL,
  PALETTE_KEY_HINTS,
  PALETTE_LIMITS,
  PALETTE_MIN_CHARS,
  PALETTE_ORDER,
  PALETTE_WILDCARD_HINT,
  jumpGroup,
  movePaletteCursor,
  opensPalette,
  paletteAction,
  paletteGroups,
  pick,
} from "./palette.ts"
import { flatten, suggestionHref, suggestionTitle } from "./omnibox.ts"
import { SearchResponseSchema, type SearchResponse } from "../../shared/schema.ts"

// ── fixtures shaped exactly like /api/search?scope=all ─────────────────────

function poet(slug: string, name: string) {
  return {
    slug,
    name,
    letter: "م",
    era: { slug: "abbasi", name: "العصر العباسي", sort: 5 },
    location: "العراق",
    description: null,
    fame: 3,
    poemCount: 364,
    baitCount: 12_000,
    highlight: null,
    score: 9,
  }
}

function bait(id: number, poemId: string, position: number, sadr: string, ajuz: string | null = "عجز") {
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
    poem: { id: poemId, poemId: id, title: "بلا عنوان" },
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

/** Through the real schema, like omnibox.test.ts: a fixture zod rejects is a wish. */
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
    limit: PALETTE_FETCH_LIMIT,
    ms: 3.2,
    ...over,
  })
}

const full = () =>
  response({
    baits: Array.from({ length: 8 }, (_, i) => bait(i + 1, "16182", i + 1, `بيت ${i}`)),
    poems: Array.from({ length: 8 }, (_, i) => poem(`q${i}`, `قصيدة ${i}`)),
    poets: Array.from({ length: 8 }, (_, i) => poet(`p${i}`, `شاعر ${i}`)),
  })

// ── grouping ───────────────────────────────────────────────────────────────

describe("paletteGroups", () => {
  it("leads with أبيات — the palette is not the omnibox", () => {
    expect(PALETTE_ORDER).toEqual(["bait", "poem", "poet"])
    const groups = paletteGroups(full())
    expect(groups.map((g) => g.kind)).toEqual(["bait", "poem", "poet"])
    expect(groups.map((g) => g.label)).toEqual([GROUP_LABEL.bait, GROUP_LABEL.poem, GROUP_LABEL.poet])
  })

  it("caps the groups at 5 أبيات · 4 قصائد · 4 شعراء", () => {
    expect(PALETTE_LIMITS).toEqual({ bait: 5, poem: 4, poet: 4 })
    const groups = paletteGroups(full())
    expect(groups.map((g) => g.items.length)).toEqual([5, 4, 4])
    // …and one request is enough for the biggest of them
    expect(PALETTE_FETCH_LIMIT).toBe(5)
  })

  it("drops an empty group instead of rendering a bare heading", () => {
    const groups = paletteGroups(response({ poets: [poet("mutanabi", "المتنبي")] }))
    expect(groups).toHaveLength(1)
    expect(groups[0]!.kind).toBe("poet")
  })

  it("has nothing to show before the first response", () => {
    expect(paletteGroups(null)).toEqual([])
    expect(flatten(paletteGroups(null))).toEqual([])
  })

  it("keeps the omnibox's routing: a بيت opens its قصيدة at that بيت", () => {
    const [s] = flatten(paletteGroups(response({ baits: [bait(41, "16182", 7, "صدر")] })))
    expect(s!.route).toEqual({ view: "poem", id: "16182", bayt: 7 })
    expect(suggestionHref(s!)).toBe("#/poem/16182?bayt=7")
  })

  it("preserves the server's شعراء order — fame-first is decided upstream", () => {
    // `rankedPoetRefs` (server/search.ts) orders name-hit → fame → bm25; the
    // palette must not re-sort what it was handed.
    const groups = paletteGroups(
      response({ poets: [poet("mutanabi", "المتنبي"), poet("namesake", "صديق المتنبي")] }),
    )
    expect(groups[0]!.items.map((s) => suggestionTitle(s))).toEqual(["المتنبي", "صديق المتنبي"])
  })
})

// ── the cursor ─────────────────────────────────────────────────────────────

describe("movePaletteCursor", () => {
  it("wraps at both ends — a selection always exists while there are rows", () => {
    expect(movePaletteCursor(0, 1, 3)).toBe(1)
    expect(movePaletteCursor(2, 1, 3)).toBe(0)
    expect(movePaletteCursor(0, -1, 3)).toBe(2)
  })

  it("has no selection at all with no rows", () => {
    expect(movePaletteCursor(0, 1, 0)).toBe(-1)
    expect(pick([], 0)).toBeNull()
  })

  it("enters the list from either end when nothing is selected", () => {
    expect(movePaletteCursor(-1, 1, 4)).toBe(0)
    expect(movePaletteCursor(-1, -1, 4)).toBe(3)
  })
})

describe("jumpGroup", () => {
  const groups = paletteGroups(full()) // 5 + 4 + 4

  it("moves to the head of the next group and wraps", () => {
    expect(jumpGroup(groups, 0, 1)).toBe(5)
    expect(jumpGroup(groups, 5, 1)).toBe(9)
    expect(jumpGroup(groups, 9, 1)).toBe(0)
  })

  it("moves back to the head of the previous group", () => {
    expect(jumpGroup(groups, 9, -1)).toBe(5)
    expect(jumpGroup(groups, 2, -1)).toBe(9)
  })

  it("is a way IN when nothing is selected, and inert with no groups", () => {
    expect(jumpGroup(groups, -1, 1)).toBe(0)
    expect(jumpGroup([], 3, 1)).toBe(-1)
  })
})

// ── the keymap ─────────────────────────────────────────────────────────────

describe("paletteAction", () => {
  it("Enter opens the highlighted row; Ctrl/Cmd+Enter opens the full search", () => {
    expect(paletteAction({ key: "Enter" }, true)).toBe("open")
    expect(paletteAction({ key: "Enter", ctrlKey: true }, true)).toBe("all")
    expect(paletteAction({ key: "Enter", metaKey: true }, true)).toBe("all")
  })

  it("Escape closes", () => {
    expect(paletteAction({ key: "Escape" }, true)).toBe("close")
    expect(paletteAction({ key: "Escape" }, false)).toBe("close")
  })

  it("↓/↑ walk the three groups as one list, in document order", () => {
    expect(paletteAction({ key: "ArrowDown" }, false)).toBe("next")
    expect(paletteAction({ key: "ArrowUp" }, true)).toBe("prev")
  })

  it("←/→ are MIRRORED: ← is forward, → is back (amendments §15)", () => {
    expect(paletteAction({ key: "ArrowLeft" }, true)).toBe("next-group")
    expect(paletteAction({ key: "ArrowRight" }, true)).toBe("prev-group")
  })

  it("…but leaves them to the caret until a row is highlighted", () => {
    expect(paletteAction({ key: "ArrowLeft" }, false)).toBeNull()
    expect(paletteAction({ key: "ArrowRight" }, false)).toBeNull()
  })

  it("traps Tab inside the list instead of letting focus walk out", () => {
    expect(paletteAction({ key: "Tab" }, true)).toBe("next")
    expect(paletteAction({ key: "Tab", shiftKey: true }, true)).toBe("prev")
  })

  it("leaves every other key to the query", () => {
    expect(paletteAction({ key: "ا" }, true)).toBeNull()
    expect(paletteAction({ key: "Backspace" }, true)).toBeNull()
    expect(paletteAction({ key: " " }, true)).toBeNull()
  })
})

describe("opensPalette", () => {
  it("answers Ctrl+K and Ctrl+F, and their Cmd twins", () => {
    expect(opensPalette({ key: "k", code: "KeyK", ctrlKey: true })).toBe(true)
    expect(opensPalette({ key: "f", code: "KeyF", ctrlKey: true })).toBe(true)
    expect(opensPalette({ key: "k", code: "KeyK", metaKey: true })).toBe(true)
    expect(opensPalette({ key: "f", code: "KeyF", metaKey: true })).toBe(true)
  })

  it("fires on an Arabic layout, where those keys report «ن» and «ب»", () => {
    expect(opensPalette({ key: "ن", code: "KeyK", ctrlKey: true })).toBe(true)
    expect(opensPalette({ key: "ب", code: "KeyF", ctrlKey: true })).toBe(true)
  })

  it("leaves the browser its own chords", () => {
    // no modifier: `k` and `f` belong to the page (BaytPlate owns f)
    expect(opensPalette({ key: "k", code: "KeyK" })).toBe(false)
    expect(opensPalette({ key: "f", code: "KeyF" })).toBe(false)
    // Ctrl+Shift+K is the console, Ctrl+Alt+K is a system chord
    expect(opensPalette({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true })).toBe(false)
    expect(opensPalette({ key: "k", code: "KeyK", ctrlKey: true, altKey: true })).toBe(false)
    // and no other Ctrl chord is ours
    expect(opensPalette({ key: "c", code: "KeyC", ctrlKey: true })).toBe(false)
    expect(opensPalette({ key: "p", code: "KeyP", metaKey: true })).toBe(false)
  })
})

// ── the footer's promises ──────────────────────────────────────────────────

describe("the footer", () => {
  it("documents the trailing-star wildcard, in Arabic and with the star", () => {
    expect(PALETTE_WILDCARD_HINT).toContain("*")
    // trailing, not leading: `%…%` over 3.4M أبيات is a scan and is refused
    expect(PALETTE_WILDCARD_HINT.trimEnd().endsWith("*")).toBe(false)
    expect(PALETTE_WILDCARD_HINT).toMatch(/\S\*/u)
    // It has to SAY what the star does, not just point at it — «للبادئة»
    // had no verb to attach to and taught a reader who did not already know.
    expect(PALETTE_WILDCARD_HINT).toContain("ما بدأ بها")
  })

  it("advertises the keys the palette actually answers to", () => {
    const flatKeys = PALETTE_KEY_HINTS.flatMap((h) => h.keys)
    expect(flatKeys).toContain("↵")
    expect(flatKeys).toContain("Esc")
    // Ctrl+↵ is written on the «كل النتائج» button, and only there
    expect(PALETTE_ALL_KEYS).toEqual(["Ctrl", "↵"])
    expect(flatKeys).not.toContain("Ctrl")
    expect(PALETTE_KEY_HINTS.some((h) => h.label === PALETTE_ALL_LABEL)).toBe(false)
    // every hint says what it does, in Arabic
    for (const h of PALETTE_KEY_HINTS) expect(h.label).toMatch(/[؀-ۿ]/u)
  })

  it("never uses Arabic-Indic digits in a rendered string (CLAUDE.md)", () => {
    const strings = [PALETTE_WILDCARD_HINT, PALETTE_ALL_LABEL, ...PALETTE_KEY_HINTS.map((h) => h.label)]
    for (const s of strings) expect(s).not.toMatch(/[٠-٩۰-۹]/u)
  })

  it("asks for two characters before it costs a round trip", () => {
    expect(PALETTE_MIN_CHARS).toBe(2)
  })
})
