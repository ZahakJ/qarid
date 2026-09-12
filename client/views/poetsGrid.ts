/**
 * The شعراء index's row maths — pure, so the windowing contract can be tested
 * without a DOM (vitest runs in `environment: node`).
 *
 * TWO NUMBERS AND A FOLD. `useWindowedList` is a pure function of a FIXED row
 * height, so the grid of cards is folded into ROWS of `cols` cards first and a
 * letter heading takes a whole row of its own. The heights below are the same
 * contract as `--row-poet` / `--row-poet-narrow` in client/styles/poets.css,
 * written twice on purpose (JS needs the number, CSS needs the layout) —
 * `poetsGrid.test.ts` reads the stylesheet and fails if the two ever drift.
 */
import type { PoetSummary } from "../../shared/schema.ts"
import type { HijaiLetter } from "../../shared/letters.ts"

/**
 * A card is the name (up to two lines of Aref Ruqaa at 1.7) + the meta line +
 * two lines of ترجمة, inside `--sp-4` padding, plus the row's own `--sp-3` gap:
 * 54 + 28 + 42 + 16 gaps + 32 padding + 12 = 184, and four px of slack. Raised from 156 at v2 — at 156 the second line of a
 * ترجمة was sliced in half by the card's `overflow: hidden`, because the clamp
 * allowed two lines and the box only had room for one and a half.
 */
export const ROW_POET = 188
/**
 * ≤860px the grid is ONE column, so the card is 300–800px wide: the name never
 * wraps, and poets.css drops the أبيات count from the meta line below 640 so
 * that line cannot wrap either. 27 + 28 + 42 + 16 gaps + 32 padding + 12 = 157,
 * plus slack for a two-line name on the narrowest phone.
 */
export const ROW_POET_NARROW = 172

export type PoetRow =
  | { kind: "head"; letter: HijaiLetter }
  | { kind: "poets"; poets: PoetSummary[] }

/**
 * Cards folded into rows of `cols`, with a heading row inserted whenever the
 * شهرة letter changes. A section never continues on the previous section's
 * row — a half-full row before a heading is correct, not a bug.
 */
export function gridRows(items: readonly PoetSummary[], cols: number, grouped: boolean): PoetRow[] {
  const width = Math.max(1, Math.floor(cols))
  const out: PoetRow[] = []
  let current: string | null = null
  let bucket: PoetSummary[] = []

  const flush = () => {
    if (bucket.length > 0) out.push({ kind: "poets", poets: bucket })
    bucket = []
  }

  for (const poet of items) {
    if (grouped && poet.letter !== current) {
      flush()
      current = poet.letter
      out.push({ kind: "head", letter: poet.letter })
    }
    bucket.push(poet)
    if (bucket.length === width) flush()
  }
  flush()
  return out
}

/** Stagger steps are capped at eight (v2.md §6); past that everything lands together. */
export const MAX_STAGGER = 8

/**
 * The step index a row animates on. Only the FIRST window of a list staggers:
 * a row created while the reader scrolls is built six rows outside the
 * viewport, so delaying it would either be invisible or — mid-flick — arrive
 * late under the reader's eye.
 */
export function enterIndex(rowIndex: number, windowStart: number): number {
  if (windowStart > 0) return 0
  return Math.min(Math.max(0, Math.floor(rowIndex)), MAX_STAGGER - 1)
}
