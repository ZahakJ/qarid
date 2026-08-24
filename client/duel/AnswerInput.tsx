/**
 * The answer field (design-ux.md §4 Play): an auto-growing RTL textarea, Enter
 * submits, Shift+Enter breaks a line, and a full بيت or a صدر alone are both
 * accepted (the server's exact ladder tries `h_full` then `h_sadr`).
 *
 * amendments.md §13 — the wrong-letter pre-check happens HERE, with no server
 * call at all: `firstLetterOf` is the same function the server judges with, so
 * a mismatched first letter is refused instantly and locally. The server stays
 * the authority on acceptance; the client is only allowed to say "not yet".
 *
 * v2.md §1 — «صدر only» was the app's best-kept secret: it was true, it was
 * tested, and the only place it was WRITTEN was a grey line at the far end of
 * the actions row, after «Shift+Enter لسطر جديد», where the owner never saw it.
 * It now sits directly under the field, on every device, as `.answer__help` —
 * and the placeholder says it too (client/duel/placeholders.ts). A rule nobody
 * reads is a rule nobody has.
 *
 * v2.md §2 — in وضع التدريب the field also carries `AssistRail` underneath.
 * That is the ONLY difference between the two modes here: `useAssist` returns
 * nothing at all when `assist` is false, and the rail is not rendered.
 */
import { useEffect, useRef, type KeyboardEvent } from "react"
import { firstLetterOf } from "../../shared/arabic.ts"
import { ASSIST } from "../../shared/constants.ts"
import { assistNeedle, useAssist } from "./assist.ts"
import { AssistRail } from "./AssistRail.tsx"
import { verdictOf } from "./LetterIndicator.tsx"

/** Always under the field, on every device — v2.md §1's "UNMISSABLE". */
export const SADR_HELP = "يكفي أن تكتب الصدر وحده — سنجد البيت ونُتمّ لك عجزه"

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
  /** وضع التدريب: grow the suggestion rail under the field (v2.md §2) */
  assist?: boolean
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
  assist = false,
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

  const suggestions = useAssist({ enabled: assist, letter: required, draft: value })

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

  // A chosen بيت lands in the field and hands the caret straight back: the
  // player still decides, still edits, and still presses «أجب».
  const pick = (text: string) => {
    onChange(text)
    ref.current?.focus()
  }

  return (
    <div className="answer-block">
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
          aria-describedby="answer-help"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="btn btn--primary answer__send"
          onClick={submit}
          disabled={disabled || !value.trim()}
        >
          أجب
        </button>
      </div>

      <p className="answer__help" id="answer-help">
        {SADR_HELP}
      </p>

      {assist ? (
        <AssistRail
          items={suggestions.items}
          loading={suggestions.loading}
          letter={required}
          hasQuery={[...assistNeedle(value)].length >= ASSIST.minChars}
          onPick={pick}
        />
      ) : null}
    </div>
  )
}
