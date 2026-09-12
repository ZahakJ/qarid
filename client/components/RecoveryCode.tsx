/**
 * The once-shown RECOVERY CODE panel (no-email account recovery — Play launch).
 *
 * قريض has no email, so a forgotten password is recovered with a code, not a
 * link. The server keeps ONLY a scrypt hash of it, so this — the moment right
 * after a register, a reset, or a regeneration — is the ONE time the plaintext
 * exists on this screen. Hence the panel's whole job: show it big and mono,
 * make it one tap to copy, and say plainly that it will not be shown again.
 *
 * It renders no secret to any store or log; the caller holds the string in
 * component state and drops it the instant the reader dismisses the panel.
 */
import { useState } from "react"

import { writeClipboard } from "../bayt/copy.ts"
import { Nib } from "./Ornaments.tsx"

export function RecoveryCodePanel({
  code,
  headline,
  note,
  onCopied,
}: {
  code: string
  /** the one-line «what this is» above the code */
  headline: string
  /** the fuller warning under the code */
  note: string
  /**
   * Fired once the code has actually reached the clipboard. The register step
   * uses it to unlock its «حفظتُه — تابِع» — the panel does not know what the
   * caller wants to gate, only that the reader took the code.
   */
  onCopied?: () => void
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const ok = await writeClipboard(code)
    setCopied(ok)
    if (ok) {
      onCopied?.()
      window.setTimeout(() => setCopied(false), 2200)
    }
  }

  return (
    <div className="recovery" role="group" aria-label="رمز الاستعادة">
      <p className="recovery__headline">
        <span className="recovery__nib" aria-hidden="true">
          <Nib size={16} />
        </span>
        {headline}
      </p>
      <div className="recovery__code-row">
        <code className="recovery__code num" dir="ltr">
          {code}
        </code>
        <button type="button" className="btn recovery__copy" onClick={() => void copy()} aria-live="polite">
          {copied ? "نُسخ" : "انسخ"}
        </button>
      </div>
      <p className="recovery__note">{note}</p>
    </div>
  )
}
