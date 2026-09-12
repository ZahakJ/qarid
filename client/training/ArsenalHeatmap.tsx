/**
 * The ترسانة, 7×4 (design-ux.md §5).
 *
 * The same alphabet and the same four rows as the روي picker
 * (`shared/letters.ts` owns both), but a different reading: this grid is about
 * YOU, so the fill is what you hold — `min(1, supply / 12)` of the accent —
 * and a letter you have never answered on is a dashed outline, not a faded
 * circle. Reading the grid should feel like reading a page of your own
 * handwriting: the dark cells are the letters you own.
 *
 * `interactive` is what separates the arsenal page from the hub's thumbnail:
 * on the hub the grid is a picture and must not offer 28 tab stops.
 */
import { formatCount } from "../../shared/format.ts"
import { LETTER_NAMES, LETTER_ROWS, type HijaiLetter } from "../../shared/letters.ts"
import type { LetterStat } from "./arsenal.ts"

/** أبيات on one letter at which the cell reads as full. */
export const FULL_AT = 12

export function fillOf(supply: number): number {
  return Math.min(1, supply / FULL_AT)
}

export function ArsenalHeatmap({
  stats,
  active,
  onPick,
  interactive = true,
  compact = false,
}: {
  stats: readonly LetterStat[]
  active?: string | null
  onPick?: (letter: HijaiLetter) => void
  interactive?: boolean
  compact?: boolean
}) {
  const byLetter = new Map(stats.map((s) => [s.letter, s]))
  return (
    <div className="heatmap" data-compact={compact ? "1" : undefined} role="group" aria-label="الترسانة">
      {LETTER_ROWS.map((row, i) => (
        <div className="heatmap__row" key={i}>
          {row.map((letter) => {
            const stat = byLetter.get(letter)
            const supply = stat?.supply ?? 0
            const label = `${LETTER_NAMES[letter]} — ${formatCount(supply)}`
            const cell = (
              <>
                <span className="heatcell__ch" aria-hidden="true">
                  {letter}
                </span>
                {compact ? null : (
                  <span className="heatcell__n num" aria-hidden="true">
                    {supply}
                  </span>
                )}
              </>
            )
            const style = { "--fill": String(fillOf(supply)) } as React.CSSProperties
            return interactive ? (
              <button
                type="button"
                className="heatcell"
                key={letter}
                style={style}
                data-empty={supply === 0 ? "1" : undefined}
                data-active={active === letter ? "1" : undefined}
                aria-pressed={active === letter}
                aria-label={label}
                title={label}
                onClick={() => onPick?.(letter)}
              >
                {cell}
              </button>
            ) : (
              <span
                className="heatcell"
                key={letter}
                style={style}
                data-empty={supply === 0 ? "1" : undefined}
                title={label}
              >
                {cell}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}
