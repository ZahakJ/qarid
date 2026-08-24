/**
 * The شعراء index's alphabet rail (design-ux.md §3 Poets): a vertical strip on
 * the inline-end edge on wide screens, a horizontal sticky strip under the era
 * chips on narrow ones. Same component, same DOM — only CSS moves it.
 *
 * The letter is the شهرة letter: `sortName()` in shared/arabic.ts strips a
 * leading ال and folds, which is exactly how `poets.letter` was computed at
 * ingest. The client never recomputes it; it renders `PoetSummary.letter`.
 */
import { formatCount } from "../../shared/format.ts"
import { HIJAI_LETTERS, LETTER_NAMES } from "../../shared/letters.ts"

export function LetterRail({
  counts,
  active,
  onPick,
  label = "حروف الشهرة",
}: {
  /** letter → poets under the current era filter; null while it is loading */
  counts: ReadonlyMap<string, number> | null
  active?: string | null
  onPick: (letter: string | undefined) => void
  label?: string
}) {
  return (
    <nav className="letter-rail" aria-label={label}>
      {HIJAI_LETTERS.map((letter) => {
        const n = counts?.get(letter)
        const empty = counts != null && !n
        const isActive = letter === active
        return (
          <button
            key={letter}
            type="button"
            className="letter-rail__key"
            data-active={isActive ? "1" : undefined}
            disabled={empty && !isActive}
            aria-pressed={isActive}
            aria-label={`${LETTER_NAMES[letter]}${n === undefined ? "" : ` — ${formatCount(n)}`}`}
            onClick={() => onPick(isActive ? undefined : letter)}
          >
            <span className="letter-rail__ch" aria-hidden="true">
              {letter}
            </span>
            {n === undefined ? null : (
              <span className="letter-rail__n" aria-hidden="true">
                {formatCount(n)}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
