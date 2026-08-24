/**
 * Search-hit highlighting inside a بيت (design-ux.md §3 Search, amendments §14).
 *
 * The server sends `highlight`: an FTS5 snippet of the NORMALIZED text, with
 * every matched token wrapped in »…«. That string is never rendered — it has no
 * tashkeel, so painting it would silently strip the vocalization the reader
 * asked to see. What we take from it is the WORDS, and those words are then
 * located in the ORIGINAL `sadr`/`ajuz` through `foldedIndex` in
 * shared/arabic.ts, whose whole purpose is that a fold is consulted rather than
 * materialised, so a hit found in the folded form maps back onto untouched
 * offsets.
 *
 * The mark itself is a lapis UNDERLINE, never a background fill — amendment 14,
 * enforced by `.bayt mark` in client/styles/bayt.css.
 */
import type { ReactNode } from "react"
import { findFolded, foldedIndex, type FoldMatch } from "../../shared/arabic.ts"
import { isMark } from "./tashkeel.ts"

/** The snippet delimiters the server passes to `snippet(baits_fts, …)`. */
export const SNIPPET_OPEN = "»"
export const SNIPPET_CLOSE = "«"

const MARKED_RE = /»([^«»]{1,120})«/g

/**
 * The distinct »marked« words of a snippet, longest first so that a term which
 * contains another wins the overlap resolution below.
 */
export function markedTerms(highlight: string | null | undefined): string[] {
  if (!highlight) return []
  const seen = new Set<string>()
  for (const m of highlight.matchAll(MARKED_RE)) {
    const term = m[1]!.trim()
    if (term) seen.add(term)
  }
  return [...seen].sort((a, b) => b.length - a.length)
}

/**
 * Every occurrence of every term, in ORIGINAL offsets, sorted and with overlaps
 * dropped. Overlaps are real: «الخيل» and «خيل» both match the same word, and
 * two nested `<mark>`s would double the underline.
 */
export function markRanges(text: string, terms: readonly string[]): FoldMatch[] {
  if (!text || terms.length === 0) return []
  const idx = foldedIndex(text)
  const hits: FoldMatch[] = []
  for (const term of terms) {
    for (const hit of findFolded(idx, term, 40)) hits.push({ ...hit, end: withMarks(text, hit.end) })
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end)

  const out: FoldMatch[] = []
  let cursor = -1
  for (const h of hits) {
    if (h.start < cursor) continue
    out.push(h)
    cursor = h.end
  }
  return out
}

/**
 * Extend an end offset over the تشكيل that belongs to the letter before it.
 *
 * The fold DELETES marks, so an offset that came back from `findFolded` points
 * just past the BASE letter and any trailing حركة falls OUTSIDE the match:
 * React then renders `<mark>لَيل</mark>َ دانِ`, the fatha becomes the first
 * character of a separate text node, detaches from its ل and floats up and to
 * the left of the letter it belongs to. `splitRawiyy` in ./rawiyy.ts does
 * exactly this for the روي underline, and for exactly this reason.
 */
function withMarks(text: string, end: number): number {
  let at = end
  while (at < text.length && isMark(text[at]!)) at++
  return at
}

/**
 * `text` with each matched run wrapped in `<mark>`. Returns the bare string
 * when nothing matched, so a non-search caller pays nothing.
 */
export function markedText(text: string, terms: readonly string[] | null | undefined): ReactNode {
  if (!terms || terms.length === 0) return text
  const ranges = markRanges(text, terms)
  if (ranges.length === 0) return text

  const nodes: ReactNode[] = []
  let at = 0
  ranges.forEach((r, i) => {
    if (r.start > at) nodes.push(text.slice(at, r.start))
    nodes.push(<mark key={`m${i}`}>{text.slice(r.start, r.end)}</mark>)
    at = r.end
  })
  if (at < text.length) nodes.push(text.slice(at))
  return <>{nodes}</>
}
