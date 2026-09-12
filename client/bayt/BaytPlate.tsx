/**
 * BaytPlate — THE only بيت renderer in قريض (CLAUDE.md, design-ux.md §6).
 * Poem page, home hero, search hit, duel exchange, summary, drill card: all of
 * them come through here. A second place that lays out a صدر and a عجز is a bug.
 *
 * The geometry (design-ux.md §3):
 *
 *     ┌ 1fr ────────────┬ gutter ┬──────────── 1fr ┐
 *     │ صدر (start)     │  شمسة  │     (end) عجز   │
 *     └─────────────────┴────────┴─────────────────┘
 *
 * DOM order is sadr → gutter → ajuz. Under RTL the first column is the
 * right-hand one, so the two hemistichs are pushed to the OUTER margins and the
 * empty gutter becomes the quiet centre channel of a printed ديوان. Below
 * 860px the grid collapses to one column and the عجز steps in behind a
 * hairline instead.
 *
 * Two variants:
 *  • `row`   — a line of a قصيدة: number in the inline-start margin, action
 *              quad in the inline-end margin, both reserved so hover shifts
 *              nothing. Keyboard: j/k move between rows, c copies, f favourites,
 *              s opens the card.
 *  • `plate` — the framed standalone بيت (hero, duel exchange), with a meta row
 *              underneath for chips and a horizontal action rail.
 *
 * Everything is prop-driven — no store subscription — so the same component can
 * be driven by settings on the poem page, by a duel's fixed presentation, and
 * by a headless test.
 */
import { useCallback, useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { Shamsa } from "../components/Ornaments.tsx"
import { BaytActions } from "./BaytActions.tsx"
import { formatBayt, writeClipboard } from "./copy.ts"
import { formatNumber } from "../../shared/format.ts"
import { markedText } from "./highlight.tsx"
import { splitRawiyy } from "./rawiyy.ts"
import { displayText, displayTextOrNull, hasMarks } from "./tashkeel.ts"

export type BaytSize = "sm" | "md" | "lg"

export type BaytPlateProps = {
  sadr: string
  /** null for the final بيت of an odd hemistich count (`isPartial`) */
  ajuz?: string | null
  size?: BaytSize
  /** 1-based بيت number, rendered in Western digits in the inline-start margin */
  number?: number | null
  /** render the lapis underline under the روي */
  showRawiyy?: boolean
  /** the peeled روي from the API — BaytPlate never derives it */
  rawiyy?: string | null
  /**
   * Search-hit words to underline, already extracted from the server's »…«
   * snippet by `markedTerms` in ./highlight.tsx. They are matched against the
   * DISPLAYED text through `foldedIndex`, so the marks land correctly whether
   * or not تشكيل is on.
   */
  highlight?: readonly string[] | null
  /** false strips marks with the shared `stripTashkeel` */
  tashkeel?: boolean
  /**
   * The drill card (design-ux.md §5): keep the بيت's geometry but replace the
   * عجز with a ruled blank of its own honest width. The عجز TEXT never reaches
   * the DOM in this mode — the answer is not hidden behind a colour, it is
   * simply not there to inspect.
   */
  blankAjuz?: boolean
  variant?: "row" | "plate"
  /** duel provenance: lapis hairline for the opponent, gold for you */
  side?: "you" | "them"
  /** DOM id — the `?bayt=N` scroll anchor */
  anchorId?: string
  active?: boolean
  /** pulses twice, for the deep-linked بيت */
  pulse?: boolean
  /** chips / attribution under a framed plate */
  meta?: ReactNode
  /** what نسخ puts on the clipboard; defaults to the displayed بيت */
  copyText?: string
  onCopy?: (e: MouseEvent) => void
  onCard?: () => void
  favorite?: boolean
  onFavorite?: () => void
  /** أضِف إلى ديوان — see `BaytActions`; undefined for an unanchorable بيت */
  onAlbum?: () => void
  duelHref?: string
  onDuel?: () => void
  /** accessible name for the action group ("البيت 7") */
  label?: string
  /** fired after a successful clipboard write, for the toast */
  onCopied?: (text: string) => void
  className?: string
}

/**
 * The عجز with its روي wrapped, or the plain string when the letter cannot be
 * located (missing عجز, or a stale cached بيت).
 */
function Ajuz({
  text,
  rawiyy,
  marked,
  terms,
}: {
  text: string
  rawiyy: string | null | undefined
  marked: boolean
  terms?: readonly string[] | null
}) {
  const split = useMemo(() => (marked ? splitRawiyy(text, rawiyy) : null), [marked, text, rawiyy])
  if (!split) return <>{markedText(text, terms)}</>
  return (
    <>
      {markedText(split.head, terms)}
      <span className="rawiyy-mark">{split.letter}</span>
      {markedText(split.tail, terms)}
    </>
  )
}

/**
 * The ruled blank's measure, as a PERCENTAGE of the شطر's own track.
 *
 * A percentage and not `em` on purpose. An `em` width is a definite size, so it
 * feeds the grid track's automatic minimum — and a 38-character عجز then
 * demanded 16em of a 340px phone and dragged the whole DOCUMENT sideways.
 * A percentage resolves against the track and contributes nothing to intrinsic
 * sizing, so the blank can never widen the page it sits on. The length is still
 * honest: it rises with the عجز's own character count until it fills the track.
 */
function blankWidth(ajuz: string): number {
  return Math.min(100, Math.max(18, ajuz.trim().length * 2.4))
}

export function BaytPlate({
  sadr,
  ajuz = null,
  size = "md",
  number = null,
  showRawiyy = false,
  rawiyy = null,
  highlight = null,
  tashkeel = true,
  blankAjuz = false,
  variant = "row",
  side,
  anchorId,
  active = false,
  pulse = false,
  meta,
  copyText,
  onCopy,
  onCard,
  favorite = false,
  onFavorite,
  onAlbum,
  duelHref,
  onDuel,
  label,
  onCopied,
  className,
}: BaytPlateProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  const sadrText = displayText(sadr, tashkeel)
  const ajuzText = displayTextOrNull(ajuz, tashkeel)
  const partial = ajuzText === null || ajuzText === ""
  // The taller leading follows the LINE, not the poem: `hasTashkeel` is a 3%
  // poem-level threshold, so a bare بيت inside a vocalized قصيدة must not be
  // given 2.30 leading it does not need.
  const vocalized = tashkeel && (hasMarks(sadrText) || hasMarks(ajuzText))

  const clipboard = copyText ?? formatBayt(sadrText, ajuzText)

  const doCopy = useCallback(
    (e: MouseEvent) => {
      if (onCopy) {
        onCopy(e)
        return
      }
      void writeClipboard(clipboard).then((ok) => {
        if (ok) onCopied?.(clipboard)
      })
    },
    [onCopy, clipboard, onCopied],
  )

  /** j/k walk the sibling أبيات; c/f/s fire the rail (design-ux.md §3). */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
      switch (e.key) {
        case "j":
        case "k": {
          const root = rootRef.current
          const list = root?.closest("[data-bayt-list]")
          if (!root || !list) return
          const rows = [...list.querySelectorAll<HTMLElement>("[data-bayt-row]")]
          const i = rows.indexOf(root)
          const next = rows[i + (e.key === "j" ? 1 : -1)]
          if (!next) return
          e.preventDefault()
          next.focus()
          break
        }
        case "c":
          e.preventDefault()
          void writeClipboard(clipboard).then((ok) => {
            if (ok) onCopied?.(clipboard)
          })
          break
        case "f":
          if (!onFavorite) return
          e.preventDefault()
          onFavorite()
          break
        case "s":
          if (!onCard) return
          e.preventDefault()
          onCard()
          break
        default:
      }
    },
    [clipboard, onCopied, onFavorite, onCard],
  )

  const bayt = (
    <div
      className="bayt"
      data-size={size}
      data-tashkeel={vocalized ? "1" : undefined}
      data-partial={partial ? "1" : undefined}
    >
      <span className="sadr">{markedText(sadrText, highlight)}</span>
      <span className="gutter" aria-hidden="true">
        <Shamsa size={12} />
      </span>
      {partial ? null : blankAjuz ? (
        <span className="ajuz ajuz--blank" aria-label="العجز محجوب — اكتبه">
          {/* Width in `em` off the عجز's own character count: a blank the same
              length whatever the line is would be a lie the reader can lean on. */}
          <span className="ajuz-blank" style={{ inlineSize: `${blankWidth(ajuzText)}%` }} />
        </span>
      ) : (
        <span className="ajuz">
          <Ajuz text={ajuzText} rawiyy={rawiyy} marked={showRawiyy} terms={highlight} />
        </span>
      )}
    </div>
  )

  // A rail with only a نسخ button is still worth showing, but a caller that
  // passes no action at all gets a clean بيت and no reserved affordances.
  const rail =
    onCopy || onCard || onFavorite || onAlbum || duelHref || onDuel ? (
      <BaytActions
        layout={variant === "row" ? "quad" : "row"}
        onCopy={doCopy}
        onCard={onCard}
        favorite={favorite}
        onFavorite={onFavorite}
        onAlbum={onAlbum}
        duelHref={duelHref}
        onDuel={onDuel}
        label={label}
      />
    ) : null

  if (variant === "plate") {
    const classes = ["bayt-plate"]
    if (className) classes.push(className)
    return (
      <div className={classes.join(" ")} data-side={side} id={anchorId} ref={rootRef}>
        {bayt}
        {meta || rail ? (
          <div className="bayt-plate__meta">
            {meta}
            {rail ? <div className="bayt-plate__actions">{rail}</div> : null}
          </div>
        ) : null}
      </div>
    )
  }

  const classes = ["bayt-row"]
  if (className) classes.push(className)
  return (
    <div
      className={classes.join(" ")}
      id={anchorId}
      ref={rootRef}
      data-bayt-row=""
      data-side={side}
      data-active={active ? "1" : undefined}
      data-pulse={pulse ? "1" : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <span className="bayt-num" aria-hidden="true">
        {number === null ? "" : formatNumber(number)}
      </span>
      {bayt}
      <div className="bayt-rail">{rail}</div>
    </div>
  )
}
