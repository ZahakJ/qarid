/**
 * THE ONE PLACE الدواوين decide between a bottom sheet and a dialog.
 *
 * The app's rule is «every phone dialog is a bottom sheet, and the desktop never
 * renders a `.sheet` at all» (CLAUDE.md) — two DOMs, one app, and the decision
 * made in JS at each call site so `client/styles/sheet.css` can never reach the
 * desktop. الدواوين have FOUR modal surfaces (the picker, «حرّر الديوان», the
 * delete confirm, and «ديوانٌ جديد» in «دواويني»), and making that decision four
 * times is four chances to make it differently.
 *
 * So it is made here, once, and every album surface hands the same three slots —
 * title, body, footer — to whichever shell applies. The desktop shell is the
 * `.overlay__card` the auth dialog and «غرفة مساجلة» already wear, corners and
 * all; the phone shell is the shared `<Sheet>`, which owns Escape, the Tab trap,
 * the focus restore and the scroll freeze.
 */
import { useEffect, useRef, type ReactNode } from "react"

import { Overlay } from "../components/Overlay.tsx"
import { PanelCorners } from "../components/Ornaments.tsx"
import { Sheet } from "../components/Sheet.tsx"
import { useNativeChrome } from "../hooks/useNativeChrome.ts"

export type AlbumModalProps = {
  title: string
  note?: ReactNode
  /**
   * The ACTIONS, bare — buttons and nothing else.
   *
   * The wrapper is this component's, and that is load-bearing: `.sheet__acts`
   * is sheet.css's and it makes every child a full-width 3rem row, which is
   * right at the bottom edge of a phone and wrong in a centred dialog. Handing
   * the same wrapped node to both is exactly how a phone rule reaches the
   * desktop (sheet.css says so where the rule is declared), so the two shells
   * wrap the same bare buttons differently.
   */
  footer?: ReactNode
  /** an extra class, applied to the sheet or the card as appropriate */
  className?: string
  onClose: () => void
  children?: ReactNode
}

export function AlbumModal({ title, note, footer, className, onClose, children }: AlbumModalProps) {
  const native = useNativeChrome()
  const cardRef = useRef<HTMLDivElement | null>(null)

  // On a phone `Sheet` owns all of this. On the desktop the card owns it, and
  // the CARD takes focus rather than its first field — a dialog that opens with
  // the caret already in a text input reads as a form the reader has to finish.
  useEffect(() => {
    if (native) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    cardRef.current?.focus()
    return () => window.removeEventListener("keydown", onKey)
  }, [native, onClose])

  if (native) {
    return (
      <Sheet
        title={title}
        note={note}
        onClose={onClose}
        className={className}
        footer={footer ? <div className="sheet__acts">{footer}</div> : undefined}
      >
        {children}
      </Sheet>
    )
  }

  return (
    <Overlay onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={className ? `overlay__card dwmodal ${className}` : "overlay__card dwmodal"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={cardRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <PanelCorners size={16} />
        <header className="dwmodal__head">
          <div className="dwmodal__headings">
            <h2 className="dwmodal__title">{title}</h2>
            {note ? <p className="dwmodal__note">{note}</p> : null}
          </div>
          <button type="button" className="btn btn--ghost dwmodal__close" onClick={onClose} aria-label="أغلق">
            ✕
          </button>
        </header>
        <div className="dwmodal__body">{children}</div>
        {footer ? <div className="dwmodal__foot">{footer}</div> : null}
      </div>
    </Overlay>
  )
}
