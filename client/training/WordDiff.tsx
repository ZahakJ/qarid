/**
 * The عجز, word by word, marked against what was typed (design-ux.md §5:
 * «correct text-1, missing text-3, wrong danger»).
 *
 * It is set in the verse face, at verse leading, because the reader is about to
 * compare it with the line they just wrote — a diff set in the UI face would be
 * a different line from the one they are learning. What they typed in place of
 * a wrong word rides underneath in the UI face, small, so the two are never
 * confused for each other.
 */
import type { DiffToken } from "./grade.ts"

const STATE_LABEL: Record<DiffToken["state"], string> = {
  ok: "أصبت",
  wrong: "خطأ",
  missing: "لم تكتبه",
}

export function WordDiff({ tokens }: { tokens: readonly DiffToken[] }) {
  if (tokens.length === 0) return null
  return (
    <p className="worddiff" dir="rtl" lang="ar">
      {tokens.map((t, i) => (
        <span className="worddiff__w" data-state={t.state} key={`${t.text}-${i}`} title={STATE_LABEL[t.state]}>
          {t.text}
          {t.typed ? <span className="worddiff__typed">كتبتَ: {t.typed}</span> : null}
        </span>
      ))}
    </p>
  )
}
