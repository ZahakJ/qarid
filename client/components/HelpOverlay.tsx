/**
 * `?` opens this anywhere (design-ux.md §1). The map itself is
 * client/data/shortcuts.ts, so the help and the handlers can never drift.
 *
 * The one thing worth spelling out on the page is the direction rule
 * (amendments §15), because it looks like a bug to anyone who does not know it:
 * the ARROWS are mirrored — in an RTL page ← moves FORWARD and → moves BACK —
 * while `j`/`k` are not, because they follow document order, not the page's
 * reading direction.
 */
import { useEffect, useRef } from "react"
import { SCOPE_LABEL, SHORTCUTS, type Shortcut } from "../data/shortcuts.ts"
import { Rule } from "./Ornaments.tsx"
import { Overlay } from "./Overlay.tsx"

const SCOPES: Shortcut["scope"][] = ["global", "browse", "poem", "duel", "train"]

/** Everything inside the card that Tab can reach. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement | null>(null)

  /**
   * `aria-modal="true"` tells assistive tech that nothing outside this card
   * exists — so Tab must not walk out onto the masthead links behind the scrim,
   * and focus must come back to whatever opened the overlay when it closes.
   */
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose()
        return
      }
      if (e.key !== "Tab") return
      const card = cardRef.current
      if (!card) return
      const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) {
        e.preventDefault()
        card.focus()
        return
      }
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
    cardRef.current?.focus()
    return () => {
      window.removeEventListener("keydown", onKey)
      restore?.focus?.()
    }
  }, [onClose])

  return (
    <Overlay role="dialog" aria-modal aria-label="اختصارات لوحة المفاتيح" onClick={onClose}>
      <div className="overlay__card help" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <header className="help__head">
          <h2 className="help__title">الاختصارات</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </header>
        <Rule />

        <div className="help__cols">
          {SCOPES.map((scope) => {
            const items = SHORTCUTS.filter((s) => s.scope === scope)
            if (items.length === 0) return null
            return (
              <section key={scope} className="help__section">
                <h3 className="help__scope">{SCOPE_LABEL[scope]}</h3>
                <dl className="keys">
                  {items.map((s) => (
                    <div key={s.keys.join("+") + s.label} style={{ display: "contents" }}>
                      <dt>
                        {s.keys.map((k) => (
                          <kbd key={k}>{k}</kbd>
                        ))}
                      </dt>
                      <dd>{s.label}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )
          })}
        </div>

        <p className="help__note">
          الأسهم معكوسة مع اتجاه الصفحة: <kbd>←</kbd> للتالي و<kbd>→</kbd> للسابق. أمّا <kbd>j</kbd> و<kbd>k</kbd>{" "}
          فتمشيان مع ترتيب الأبيات لا مع اتجاه الكتابة، فلا تنعكسان. والحروف هنا مواضعُ مفاتيحَ لا حروفًا، فتعمل على
          لوحة المفاتيح العربية كما تعمل على اللاتينية.
        </p>
      </div>
    </Overlay>
  )
}
