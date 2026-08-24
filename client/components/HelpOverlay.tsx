/**
 * `?` opens this anywhere (design-ux.md §1). Phase-0 stub: it already renders
 * the real keymap from client/data/shortcuts.ts, so the map and the help can
 * never drift; the per-view sections grow as the views land.
 */
import { useEffect } from "react"
import { SCOPE_LABEL, SHORTCUTS, type Shortcut } from "../data/shortcuts.ts"
import { Rule } from "./Ornaments.tsx"

const SCOPES: Shortcut["scope"][] = ["global", "poem", "duel", "browse"]

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="اختصارات لوحة المفاتيح" onClick={onClose}>
      <div className="overlay__card" onClick={(e) => e.stopPropagation()}>
        <h2 className="view__title" style={{ fontSize: "var(--fs-ui-5)" }}>
          الاختصارات
        </h2>
        <Rule />
        {SCOPES.map((scope) => {
          const items = SHORTCUTS.filter((s) => s.scope === scope)
          if (items.length === 0) return null
          return (
            <section key={scope} style={{ marginBlockStart: "var(--sp-5)" }}>
              <h3 className="panel__note">{SCOPE_LABEL[scope]}</h3>
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
        <div style={{ marginBlockStart: "var(--sp-6)", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            إغلاق
          </button>
        </div>
      </div>
    </div>
  )
}
