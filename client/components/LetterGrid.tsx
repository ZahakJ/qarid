/**
 * The 7×4 circular letter grid — الروي and حرف البداية in the browse facet rail,
 * and the shape the arsenal heatmap will reuse in Phase 4 (design-ux.md §3, §5).
 *
 * Every cell is a روي-style well: a 1.9em circle in Amiri behind a lapis
 * hairline, with its count in Plex Mono underneath. All 28 letters are always
 * present; zero disables rather than hides (see ./letterGrid.ts).
 */
import { formatCount } from "../../shared/format.ts"
import { letterCellRows, type LetterCell } from "./letterGrid.ts"
import type { LetterFacet } from "../../shared/schema.ts"

export function LetterGrid({
  label,
  counts,
  active,
  onPick,
  showCounts = true,
}: {
  label: string
  /** null while the counts are still in flight — cells stay enabled and bare */
  counts: readonly LetterFacet[] | null
  active?: string | null
  onPick: (letter: string) => void
  showCounts?: boolean
}) {
  const rows = letterCellRows(counts, active)
  return (
    <div className="letter-grid" role="group" aria-label={label}>
      {rows.map((row, i) => (
        <div className="letter-grid__row" key={i}>
          {row.map((cell) => (
            <LetterWell key={cell.letter} cell={cell} onPick={onPick} showCount={showCounts && counts != null} />
          ))}
        </div>
      ))}
    </div>
  )
}

function LetterWell({
  cell,
  onPick,
  showCount,
}: {
  cell: LetterCell
  onPick: (letter: string) => void
  showCount: boolean
}) {
  return (
    <button
      type="button"
      className="letter-well"
      data-active={cell.active ? "1" : undefined}
      disabled={cell.disabled}
      aria-pressed={cell.active}
      aria-label={`${cell.name}${showCount ? ` — ${formatCount(cell.count)}` : ""}`}
      title={cell.name}
      onClick={() => onPick(cell.letter)}
    >
      <span className="letter-well__ch" aria-hidden="true">
        {cell.letter}
      </span>
      {showCount ? (
        <span className="letter-well__n" aria-hidden="true">
          {formatCount(cell.count)}
        </span>
      ) : null}
    </button>
  )
}
