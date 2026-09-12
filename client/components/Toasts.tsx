/** Transient notices, centred at the block-end. Dismissible, never persisted. */
import { useToasts } from "../store/toastStore.ts"

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id} data-tone={t.tone}>
          <span>{t.text}</span>
          <button type="button" className="btn btn--ghost" onClick={() => dismiss(t.id)} aria-label="إغلاق">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
