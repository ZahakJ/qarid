/**
 * #/search — the segmented control's decision layer, kept pure and out of the
 * view so it can be tested without React.
 *
 * The three modes are NOT three values of one parameter, and that is the whole
 * point of this file:
 *
 *   كلمات    sends NO `mode` at all. That is what arms the server's
 *            AND-then-OR fallback, which is what makes «لا نتيجة بكل الكلمات
 *            — هذه نتائج بعضها» possible (design-ux.md §3).
 *   أي كلمة  PINS `mode=or` and disables the fallback.
 *   عبارة    is not a mode. It is QUOTING — `q="…"` — which `ftsQuery` in
 *            shared/arabic.ts turns into a phrase term. Because it lives in
 *            the query string it round-trips through the URL for free, which
 *            is why a pasted `#/search?q="الخيل والليل"` comes back as a
 *            phrase search rather than as three loose words.
 */
import type { SearchMode } from "../../shared/schema.ts"

export type SearchMode3 = "words" | "phrase" | "any"

export const SEARCH_MODES: readonly { value: SearchMode3; label: string }[] = [
  { value: "words", label: "كلمات" },
  { value: "phrase", label: "عبارة" },
  { value: "any", label: "أي كلمة" },
]

/** Both quote pairs the server's `ftsQuery` recognises as a phrase. */
const QUOTED = /^\s*(?:"([^]*)"|«([^]*)»)\s*$/

/** The bare text of a query, with any surrounding phrase quotes taken off. */
export function unquote(raw: string): string {
  const m = QUOTED.exec(raw)
  return (m ? (m[1] ?? m[2] ?? "") : raw).trim()
}

/** A quoted query IS a phrase search — that is how عبارة survives a reload. */
export function modeOfQuery(q: string): SearchMode3 {
  return QUOTED.test(q) && unquote(q).length > 0 ? "phrase" : "words"
}

/** The `q` to put in the URL (and on the wire) for a mode the reader picked. */
export function queryFor(raw: string, mode: SearchMode3): string {
  const bare = unquote(raw)
  if (!bare) return ""
  return mode === "phrase" ? `"${bare}"` : bare
}

/** The `mode` parameter, or undefined to leave the server's fallback armed. */
export function modeParam(mode: SearchMode3): SearchMode | undefined {
  return mode === "any" ? "or" : undefined
}
