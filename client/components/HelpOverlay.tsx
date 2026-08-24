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

const SCOPES: Shortcut["scope"][] = ["global", "browse", "poem", "duel"]

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    cardRef.current?.focus()
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="اختصارات لوحة المفاتيح" onClick={onClose}>
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
          فتمشيان مع ترتيب الأبيات لا مع اتجاه الكتابة، فلا تنعكسان.
        </p>
      </div>
    </div>
  )
}
