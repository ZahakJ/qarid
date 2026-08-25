/**
 * The global palette's decision layer (v2.md §3), kept pure so the grouping,
 * the keymap and the footer's wildcard note can be tested without a DOM — the
 * same split `omnibox.ts` makes for the home field.
 *
 * What is decided here, and why it is not obvious:
 *
 *  • THE GROUPS ARE NOT THE OMNIBOX'S. The palette leads with أبيات — five of
 *    them — because a reader who hijacked Ctrl+F is looking for a LINE; قصائد
 *    and شعراء follow at four each. `groupSuggestions` in omnibox.ts does the
 *    shaping for both, so a بيت still links to its قصيدة at `?bayt=N` and an
 *    empty group is still dropped rather than rendered as a bare heading.
 *
 *  • A SELECTION ALWAYS EXISTS while there are results. The omnibox starts at
 *    −1 (it is a search FIELD first, and Enter there runs the full search); the
 *    palette starts at 0, because Enter opening the top hit is what a palette
 *    is for and «كل النتائج» has its own chord, Ctrl+Enter.
 *
 *  • THE ARROWS ARE MIRRORED — but only the horizontal pair, and only once the
 *    reader has left the text field behind. ↓/↑ walk the three groups as one
 *    list (a list is vertical in both directions, amendments §15's mirroring is
 *    about the READING axis), while ←/→ jump BETWEEN groups, ← forward and →
 *    back, exactly like browse pagination. They are inert until a row is
 *    highlighted, because until then those two keys belong to the caret sitting
 *    in the query the reader is still typing.
 */
import { logicalKey } from "../hooks/useKeyboard.ts"
import {
  GROUP_LABEL,
  groupSuggestions,
  type Suggestion,
  type SuggestionGroup,
  type SuggestionKind,
} from "./omnibox.ts"
import type { SearchResponse } from "../../shared/schema.ts"

/** Rows per group: 5 أبيات · 4 قصائد · 4 شعراء (v2.md §3). */
export const PALETTE_LIMITS: Record<SuggestionKind, number> = { bait: 5, poem: 4, poet: 4 }

/** Group order — the بيت first; see the header. */
export const PALETTE_ORDER: readonly SuggestionKind[] = ["bait", "poem", "poet"]

/**
 * The `limit` one request asks for. `/api/search` pages all three lists with
 * ONE limit, so the palette asks for the biggest group it renders and trims the
 * other two here — one round trip instead of three.
 */
export const PALETTE_FETCH_LIMIT = Math.max(...Object.values(PALETTE_LIMITS))

/** Shortest query worth a round trip — the omnibox's rule, kept. */
export const PALETTE_MIN_CHARS = 2

/** Quiet before a keystroke costs anything (v2.md §3: 200 ms). */
export const PALETTE_DEBOUNCE_MS = 200

export const PALETTE_LABEL = "البحث السريع"
export const PALETTE_PLACEHOLDER = "ابحث في الديوان: بيتٍ، أو قصيدةٍ، أو شاعرٍ"

/**
 * The same invitation, short enough to survive a phone — the omnibox's own
 * lesson (`OMNIBOX_PLACEHOLDER_NARROW`): a placeholder is the one string CSS
 * cannot shorten, it clips, and it clips mid-word. At 390 the long one read
 * «… أو قصيدةٍ، أو», which looks like a bug rather than a narrow screen.
 */
export const PALETTE_PLACEHOLDER_NARROW = "ابحث في الديوان"

export const PALETTE_IDLE = "اكتب كلمةً، أو نصفَ بيتٍ، أو اسمَ شاعرٍ."

/** No hit — and the one thing worth trying next, which the footer names. */
export const PALETTE_EMPTY = "لا شيء بهذا اللفظ. جرّب كلمةً أقصر، أو نجمةً في آخرها."

/**
 * The wildcard, documented where it is typed (v2.md §2/§3).
 *
 * A trailing `*` is the ONE piece of query syntax قريض honours — FTS5 prefix
 * matching — and it is documented in this footer rather than in a help page
 * because the palette is the only place a reader can act on knowing it. There
 * is no regex and there will not be one: `%…%` over 3.4M أبيات is a scan.
 *
 * The star is safe unwrapped in an RTL line: a neutral character at the end of
 * an Arabic run takes the paragraph direction and lands at the run's visual
 * left edge — which is where "the end of the word" is.
 */
export const PALETTE_WILDCARD_HINT = "كلمة* للبادئة"

/** The footer's «كل النتائج» door — a button AND a chord, one label for both. */
export const PALETTE_ALL_LABEL = "كل النتائج"
export const PALETTE_ALL_KEYS = ["Ctrl", "↵"]

/**
 * The footer's remaining key legends, in the order it prints them. Ctrl+↵ is
 * NOT among them: it is written on the «كل النتائج» button itself, and a
 * footer that says the same thing twice is a footer nobody reads.
 */
export const PALETTE_KEY_HINTS: { keys: string[]; label: string }[] = [
  { keys: ["↵"], label: "افتح" },
  { keys: ["↑", "↓"], label: "تنقّل" },
  { keys: ["Esc"], label: "إغلاق" },
]

export { GROUP_LABEL }
export type { Suggestion, SuggestionGroup, SuggestionKind }

/** The palette's three groups, capped per kind, empty ones dropped. */
export function paletteGroups(res: SearchResponse | null): SuggestionGroup[] {
  return groupSuggestions(res, PALETTE_LIMITS, PALETTE_ORDER)
}

/**
 * Move within the flat list, wrapping at BOTH ends and never landing on −1:
 * once there are results, something is always selected.
 */
export function movePaletteCursor(cursor: number, delta: number, length: number): number {
  if (length <= 0) return -1
  if (cursor < 0) return delta > 0 ? 0 : length - 1
  return (((cursor + delta) % length) + length) % length
}

/** The flat index of the first row of each group. */
export function groupStarts(groups: readonly SuggestionGroup[]): number[] {
  const starts: number[] = []
  let at = 0
  for (const g of groups) {
    starts.push(at)
    at += g.items.length
  }
  return starts
}

/**
 * ← / → : the first row of the NEXT (`+1`) or PREVIOUS (`−1`) group, wrapping.
 * From an unselected list it enters at the first group's head, so the mirrored
 * pair is also a way in and never a no-op with results on screen.
 */
export function jumpGroup(groups: readonly SuggestionGroup[], cursor: number, dir: 1 | -1): number {
  const starts = groupStarts(groups)
  if (starts.length === 0) return -1
  if (cursor < 0) return dir > 0 ? starts[0]! : starts[starts.length - 1]!
  let here = 0
  for (let i = 0; i < starts.length; i++) if (cursor >= starts[i]!) here = i
  const next = (((here + dir) % starts.length) + starts.length) % starts.length
  return starts[next]!
}

/** Every key the open palette answers to. */
export type PaletteAction = "close" | "next" | "prev" | "next-group" | "prev-group" | "open" | "all"

type KeyLike = {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/**
 * What one keystroke means to an OPEN palette. `hasCursor` is whether a row is
 * highlighted — it gates the mirrored pair only (see the header).
 */
export function paletteAction(e: KeyLike, hasCursor = false): PaletteAction | null {
  const mod = Boolean(e.ctrlKey || e.metaKey)
  switch (e.key) {
    case "Escape":
      return "close"
    case "Enter":
      return mod ? "all" : "open"
    case "ArrowDown":
      return "next"
    case "ArrowUp":
      return "prev"
    // Mirrored, RTL: ← is forward. Inert while the caret still owns them.
    case "ArrowLeft":
      return hasCursor ? "next-group" : null
    case "ArrowRight":
      return hasCursor ? "prev-group" : null
    case "Tab":
      return e.shiftKey ? "prev" : "next"
    default:
      return null
  }
}

/**
 * Does this keystroke open the palette? Ctrl+K and Ctrl+F, plus their Cmd
 * twins — the owner asked for the browser's own find to be hijacked (v2.md §3).
 *
 * Matched through `logicalKey`, so it fires on an Arabic layout too: Ctrl+K
 * reports «ن» there and Ctrl+F reports «ب», and a map written in Latin letters
 * would answer neither. Shift and Alt are excluded so Ctrl+Shift+K (the
 * browser's console) still belongs to the browser.
 */
export function opensPalette(e: KeyLike): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false
  if (e.shiftKey || e.altKey) return false
  const key = logicalKey({ key: e.key, code: e.code ?? "", shiftKey: false })
  return key === "k" || key === "f"
}

/** The row `open` acts on, if any. */
export function pick(flat: readonly Suggestion[], cursor: number): Suggestion | null {
  return cursor >= 0 && cursor < flat.length ? flat[cursor]! : null
}
