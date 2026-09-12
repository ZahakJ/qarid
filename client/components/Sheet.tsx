/**
 * THE BOTTOM SHEET — what a dialog is on a phone.
 *
 * A centred card with a scrim is a desktop idiom: it arrives from nowhere, it
 * sits where the thumb cannot reach it, and its close button is in the corner
 * furthest from the hand holding the device. Every modal surface in قريض that a
 * phone reader can open — «القيود», «حجم الخط», دخول, «غرفة مساجلة», البطاقة —
 * comes up from the bottom edge instead, anchored to the thumb, with a drag
 * handle to say which way it goes and a scrim that dismisses it.
 *
 * ONE primitive, five call sites, and the desktop keeps its dialogs untouched:
 * the decision is made in JS (`useNativeChrome()`) at each call site, so the
 * desktop never renders a `.sheet` at all and `client/styles/sheet.css` cannot
 * reach it — the same "two DOMs, one app" shape the two chromes already use.
 *
 * What this component owns, so no caller has to:
 *  • Escape closes, Tab is trapped inside, focus returns to whatever opened it.
 *  • The scrim dismisses on `mousedown` — a drag that STARTED inside the sheet
 *    and ended on the scrim is a text selection, not a dismissal (the palette
 *    learned this one first).
 *  • Scroll chaining stops at the sheet: the body is `overscroll-behavior:
 *    contain`, and `body[data-sheet="1"]` freezes the page underneath, so a
 *    flick inside «القيود» cannot scroll the قصائد behind it. The counter is
 *    what makes a sheet opened over a sheet release the page only once.
 *  • The safe-area bottom inset is padded for, so the last row of a sheet is
 *    never under the gesture bar.
 *  • IT IS A PORTAL ONTO `document.body`, and that is load-bearing, not tidiness
 *    (see the trap below).
 *
 * ── THE TRAP: a filled transform animation is a containing block ──────────
 *
 * `position: fixed` is measured against the viewport ONLY while no ancestor has
 * a transform. motion.css gives `.route-swap` — the wrapper App.tsx puts around
 * EVERY view — `animation: qr-rise … both`, and `both` means the animation goes
 * on filling its `to` keyframe after it ends. That keyframe says
 * `transform: none`, which Chromium resolves to the identity `matrix(1,0,0,1,0,0)`
 * — not to `none` — so the wrapper stays a containing block for the life of the
 * page. A sheet opened from inside a view was therefore laid out against the
 * VIEW's box: measured on #/browse, `inset: 0` put the scrim at y = −647 and the
 * sheet 1,199px down a 844px screen, i.e. nowhere. The page dimmed and nothing
 * came up.
 *
 * A modal does not belong inside the view that opened it anyway. The portal is
 * the fix and it is immune to whatever any future ancestor does.
 */
import { useEffect, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** How many sheets are open. The page is frozen while it is > 0. */
let openSheets = 0

export type SheetProps = {
  /** the sheet's own name — its heading and its accessible label */
  title: string
  onClose: () => void
  /** a quiet line under the title */
  note?: ReactNode
  /** pinned under the scrolling body: the sheet's own actions */
  footer?: ReactNode
  /** extra class on the sheet itself, for a call site that needs a measure */
  className?: string
  /**
   * `false` takes away the THREE easy ways out — the ✕, the scrim and Escape —
   * and leaves only whatever the caller puts in `footer`.
   *
   * Exactly one sheet wants this and it is not a convenience: the recovery-code
   * panel is the one-and-only display of the only credential that can ever
   * recover the account, and its own copy says so («ولن يظهر ثانيةً… لا بريد
   * هنا يُرسله إليك ثانيةً»). A reader who taps ✕ out of habit has silently
   * lost the account. Anything else is a dialog and stays dismissible.
   */
  dismissible?: boolean
  children?: ReactNode
}

export function Sheet({ title, onClose, note, footer, className, dismissible = true, children }: SheetProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null
    openSheets++
    document.body.dataset.sheet = "1"

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        if (dismissible) onClose()
        return
      }
      if (e.key !== "Tab") return
      const card = cardRef.current
      if (!card) return
      const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      const at = document.activeElement
      if (e.shiftKey && (at === first || at === card)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      } else if (!card.contains(at)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    // The CARD takes focus, not its first control: a sheet that opens with the
    // keyboard already up (because its first field was focused) hides half of
    // itself before the reader has read what it is for. The one sheet that
    // wants a caret — the search field — asks for it itself.
    cardRef.current?.focus()

    return () => {
      window.removeEventListener("keydown", onKey)
      openSheets = Math.max(0, openSheets - 1)
      if (openSheets === 0) delete document.body.dataset.sheet
      restore?.focus?.()
    }
  }, [onClose, dismissible])

  const classes = className ? `sheet ${className}` : "sheet"

  return createPortal(
    <div
      className="sheet-scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={classes}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={cardRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* The notch. It is not a control — the sheet is dismissed by the scrim,
            by Escape, and by its own ✕ — it is the sign that says which edge
            this surface belongs to. */}
        <span className="sheet__grab" aria-hidden="true" />
        <header className="sheet__head">
          <div className="sheet__headings">
            <h2 className="sheet__title">{title}</h2>
            {note ? <p className="sheet__note">{note}</p> : null}
          </div>
          {dismissible ? (
            <button type="button" className="sheet__close" onClick={onClose} aria-label="إغلاق">
              ✕
            </button>
          ) : null}
        </header>
        <div className="sheet__body">{children}</div>
        {footer ? <div className="sheet__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

/**
 * A sheet that asks one question and takes one of two answers.
 *
 * The destructive answer is FIRST, on the reading edge, the way every other
 * pair of actions in this app is laid out (`.auth__actions`, the walkthrough's
 * footer) — and it is the one that says what it does («انسحب»), never «نعم».
 */
export function ConfirmSheet({
  title,
  note,
  confirmLabel,
  cancelLabel = "تابِع المساجلة",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string
  note?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Sheet
      title={title}
      note={note}
      onClose={onClose}
      className="sheet--confirm"
      footer={
        <div className="sheet__acts">
          <button
            type="button"
            className={danger ? "btn btn--danger" : "btn btn--primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {cancelLabel}
          </button>
        </div>
      }
    />
  )
}
