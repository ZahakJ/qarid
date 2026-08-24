/**
 * The omnibox's decision layer, kept pure so it can be tested without a DOM.
 *
 * `/api/search?scope=all&limit=4` answers three arrays. The dropdown shows them
 * as three labelled groups — شعراء · أبيات · قصائد, in that order (design-ux.md
 * §3) — and the arrow keys walk them as ONE list, because that is what a reader
 * pressing ↓ expects. Both facts come out of `groupSuggestions`: the groups for
 * rendering, and `flatten` for the cursor.
 */
import type { BaitHit, PoemHit, PoetHit, SearchResponse } from "../../shared/schema.ts"
import { routeHash, type Route } from "../router.ts"

/** Max rows per group in the dropdown (design-ux.md §3 Home). */
export const OMNIBOX_GROUP_LIMIT = 4

export type SuggestionKind = "poet" | "bait" | "poem"

export type Suggestion =
  | { kind: "poet"; id: string; hit: PoetHit; route: Route }
  | { kind: "bait"; id: string; hit: BaitHit; route: Route }
  | { kind: "poem"; id: string; hit: PoemHit; route: Route }

export type SuggestionGroup = {
  kind: SuggestionKind
  label: string
  items: Suggestion[]
}

/** Group headings, in the order the dropdown renders them. */
export const GROUP_LABEL: Record<SuggestionKind, string> = {
  poet: "شعراء",
  bait: "أبيات",
  poem: "قصائد",
}

const ORDER: readonly SuggestionKind[] = ["poet", "bait", "poem"]

/**
 * Three groups, each capped at `limit`, EMPTY GROUPS DROPPED — a heading with
 * nothing under it is noise, and the server sends all three arrays whatever the
 * query matched.
 *
 * A بيت links to its قصيدة at the right بيت (`?bayt=N`), never to a bare بيت
 * page: the reader asked for a line and wants to land on it inside its قصيدة.
 */
export function groupSuggestions(res: SearchResponse | null, limit = OMNIBOX_GROUP_LIMIT): SuggestionGroup[] {
  if (!res) return []
  const cap = Math.max(0, Math.floor(limit))
  const groups: SuggestionGroup[] = []

  for (const kind of ORDER) {
    const items = suggestionsOf(res, kind, cap)
    if (items.length > 0) groups.push({ kind, label: GROUP_LABEL[kind], items })
  }
  return groups
}

function suggestionsOf(res: SearchResponse, kind: SuggestionKind, cap: number): Suggestion[] {
  switch (kind) {
    case "poet":
      return res.poets.slice(0, cap).map((hit) => ({
        kind: "poet" as const,
        id: `poet:${hit.slug}`,
        hit,
        route: { view: "poet" as const, slug: hit.slug },
      }))
    case "bait":
      return res.baits.slice(0, cap).map((hit) => ({
        kind: "bait" as const,
        id: `bait:${hit.baytKey}`,
        hit,
        route: { view: "poem" as const, id: hit.poem.id, bayt: hit.position },
      }))
    case "poem":
      return res.poems.slice(0, cap).map((hit) => ({
        kind: "poem" as const,
        id: `poem:${hit.id}`,
        hit,
        route: { view: "poem" as const, id: hit.id },
      }))
  }
}

/** The groups as one list — the order ↓ and ↑ move through. */
export function flatten(groups: SuggestionGroup[]): Suggestion[] {
  return groups.flatMap((g) => g.items)
}

/**
 * Move the cursor by `delta`, wrapping at both ends. `-1` means "nothing
 * selected"; stepping back from the first row returns there rather than
 * jumping to the last, so ↑ out of the list puts focus back in the field.
 */
export function moveCursor(cursor: number, delta: number, length: number): number {
  if (length <= 0) return -1
  if (cursor < 0) return delta > 0 ? 0 : length - 1
  const next = cursor + delta
  if (next < 0) return -1
  if (next >= length) return 0
  return next
}

/** Where a suggestion navigates. */
export function suggestionHref(s: Suggestion): string {
  return routeHash(s.route)
}

/** The one line of text a row shows as its title. */
export function suggestionTitle(s: Suggestion): string {
  switch (s.kind) {
    case "poet":
      return s.hit.name
    case "bait":
      return s.hit.sadr
    case "poem":
      return s.hit.title
  }
}

/** The quieter second line: who said it, and where. */
export function suggestionNote(s: Suggestion): string {
  switch (s.kind) {
    case "poet":
      return s.hit.era?.name ?? (s.hit.location ?? "")
    case "bait":
      return s.hit.ajuz ?? s.hit.poet.name
    case "poem":
      return s.hit.poet.name
  }
}
