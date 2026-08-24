/**
 * The answer field (design-ux.md §4 Play): an auto-growing RTL textarea, Enter
 * submits, Shift+Enter breaks a line, and a full بيت or a صدر alone are both
 * accepted (the server's exact ladder tries `h_full` then `h_sadr`).
 *
 * amendments.md §13 — the wrong-letter pre-check happens HERE, with no server
 * call at all: `firstLetterOf` is the same function the server judges with, so
 * a mismatched first letter is refused instantly and locally. The server stays
 * the authority on acceptance; the client is only allowed to say "not yet".
 */
import { useEffect, useRef, type KeyboardEvent } from "react"
import { firstLetterOf } from "../../shared/arabic.ts"
import { verdictOf } from "./LetterIndicator.tsx"

export type AnswerInputProps = {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  /** blocked while verifying / reciting */
  disabled?: boolean
  placeholder?: string
  required: string | null
  alsoAccepted: readonly string[]
  /** shakes and marks the field — set when the local pre-check refuses */
  invalid?: boolean
  onPrecheckFail?: (typed: string | null) => void
  autoFocus?: boolean
}

export function AnswerInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder,
  required,
  alsoAccepted,
  invalid = false,
  onPrecheckFail,
  autoFocus = true,
}: AnswerInputProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // auto-grow: the field is as tall as the بيت it holds, never taller
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [value])

  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus()
  }, [autoFocus, disabled])

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    // amendments.md §13: instant local refusal, no request spent
    const typed = firstLetterOf(text)
    const verdict = verdictOf(required, alsoAccepted, typed)
    if (verdict === "miss") {
      onPrecheckFail?.(typed)
      return
    }
    onSubmit()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="answer" data-invalid={invalid ? "1" : undefined}>
      <textarea
        ref={ref}
        className="answer__field"
        dir="rtl"
        lang="ar"
        rows={1}
        enterKeyHint="send"
        /* the same hardening the omnibox carries — a timed answer field must
           not be offered form-history suggestions */
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="أجب ببيت يبدأ بالحرف المطلوب"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="btn btn--primary answer__send" onClick={submit} disabled={disabled || !value.trim()}>
        أجب
      </button>
    </div>
  )
}
