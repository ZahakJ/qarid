/**
 * The شعراء index's alphabet rail (design-ux.md §3 Poets, redesigned at
 * v2.md §6): a BAND across the top of the page — twenty-eight equal cells
 * under the hero — that becomes a scrolling strip below 860px. Same component,
 * same DOM as the 6.5rem side column it replaced; only poets.css moves it.
 *
 * The active letter is enlarged in Aref Ruqaa gold, and that is a TRANSFORM,
 * not a font-size: the band reserves its height once (`--rail-key-h`), so
 * picking a letter grows the glyph out of the alphabet without moving the
 * 6,941 شاعر underneath it by a pixel.
 *
 * The letter is the شهرة letter: `sortName()` in shared/arabic.ts strips a
 * leading ال and folds, which is exactly how `poets.letter` was computed at
 * ingest. The client never recomputes it; it renders `PoetSummary.letter`.
 */
import { useEffect, useRef } from "react"
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
  const railRef = useRef<HTMLElement | null>(null)

  /**
   * On a phone the band scrolls and shows eight of its twenty-eight keys, so a
   * reader who arrived on ?letter=م must be shown where م is rather than left
   * to guess that the strip continues. Harmless on the wide layout, where the
   * whole alphabet is already in view.
   */
  useEffect(() => {
    if (!active) return
    const key = railRef.current?.querySelector<HTMLElement>('[data-active="1"]')
    key?.scrollIntoView({ block: "nearest", inline: "center" })
  }, [active])

  return (
    <nav className="letter-rail" aria-label={label} ref={railRef}>
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
