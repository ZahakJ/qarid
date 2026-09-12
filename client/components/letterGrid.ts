/**
 * The 7×4 letter grid's decision layer, pure so the "disabled at zero" rule can
 * be tested without a DOM.
 *
 * Two grids use it (design-ux.md §3 Browse): الروي and حرف البداية. Both render
 * ALL 28 letters in هجائي order — a letter with no قصائد under the current
 * filter is DISABLED and dimmed, never hidden, because a grid that changes shape
 * as you filter stops being a map of the alphabet. That is also why
 * /api/facets returns zeros (FacetsResponseSchema).
 */
import { HIJAI_LETTERS, LETTER_NAMES, LETTER_ROWS, type HijaiLetter } from "../../shared/letters.ts"
import type { LetterFacet } from "../../shared/schema.ts"

export type LetterCell = {
  letter: HijaiLetter
  name: string
  count: number
  /** no result under the current filter — dimmed, not clickable */
  disabled: boolean
  active: boolean
}

/** `[{letter,count}]` → letter → count, tolerating a missing or partial list. */
export function countMap(counts: readonly LetterFacet[] | null | undefined): Map<string, number> {
  const m = new Map<string, number>()
  for (const c of counts ?? []) m.set(c.letter, c.count)
  return m
}

/**
 * All 28 cells in هجائي order.
 *
 * `counts === null` means "we have not asked yet": every cell is enabled and
 * shows no number, because greying the whole alphabet out while a facets
 * request is in flight would read as «لا شيء هنا» (design-ux.md §6 — facet
 * counts are optimistic, stale ones are marked, absent ones are not invented).
 *
 * The ACTIVE letter is never disabled, whatever its count says: the reader must
 * always be able to take a filter back off.
 */
export function letterCells(
  counts: readonly LetterFacet[] | null | undefined,
  active?: string | null,
): LetterCell[] {
  const known = counts != null
  const m = countMap(counts)
  return HIJAI_LETTERS.map((letter) => {
    const count = m.get(letter) ?? 0
    const isActive = letter === active
    return {
      letter,
      name: LETTER_NAMES[letter],
      count,
      disabled: known && count === 0 && !isActive,
      active: isActive,
    }
  })
}

/** The same cells, cut into the four rows of seven the grid renders. */
export function letterCellRows(
  counts: readonly LetterFacet[] | null | undefined,
  active?: string | null,
): LetterCell[][] {
  const cells = letterCells(counts, active)
  const byLetter = new Map(cells.map((c) => [c.letter, c] as const))
  return LETTER_ROWS.map((row) => row.map((l) => byLetter.get(l)!))
}

/** True when the grid has nothing to offer at all — every letter is at zero. */
export function gridIsEmpty(counts: readonly LetterFacet[] | null | undefined): boolean {
  if (counts == null) return false
  return counts.every((c) => c.count === 0)
}
