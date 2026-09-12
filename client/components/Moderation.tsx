/**
 * Report and block — the two moderation affordances a reader has over another
 * account (Track 3). They sit, tastefully and small, wherever one real person
 * meets another: a profile page (`#/u/<name>`) and a live مساجلة (the opponent).
 * A ديوان gets the report half alone (`AlbumReportAction`, at the foot of this
 * file) — its اسم and وصف are UGC too, while blocking belongs to the person and
 * not to one of his shelves.
 *
 * BLOCKING IS PRIVATE. Nothing here ever tells the blocked account it was
 * blocked; the button only reflects the reader's OWN state («احظر» ↔ «ألغِ
 * الحظر»). REPORTING is a quiet note to the owner — a reason and an optional
 * line — and answers with a toast, never a running conversation.
 *
 * The dialogs reuse the app's modal mechanics (aria-modal, Escape closes, Tab
 * trapped, focus restored on close) so they feel like the auth and delete
 * dialogs, not a bolt-on.
 */
import { useEffect, useRef, useState } from "react"

import { ApiError } from "../api/client.ts"
import { blockUser, reportUser, unblockUser } from "../api/queries.ts"
import { toast } from "../store/toastStore.ts"
import type { ReportReason } from "../../shared/schema.ts"
import { PanelCorners, Rule } from "./Ornaments.tsx"
import { Overlay } from "./Overlay.tsx"

/** The report reasons, in the order the picker shows them. Machine → Arabic. */
export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: "harassment", label: "مضايقة أو إساءة" },
  { value: "hate", label: "كراهية أو تحقير" },
  { value: "spam", label: "إغراق أو دعاية" },
  { value: "impersonation", label: "انتحال شخصية" },
  { value: "inappropriate", label: "اسم أو صورة لا يليقان" },
  { value: "other", label: "غير ذلك" },
]

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Shared modal shell — the same trap the other قريض dialogs use. */
function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
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
    // Focus the first focusable in the card once it is mounted.
    const t = window.setTimeout(() => cardRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus(), 0)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.clearTimeout(t)
      restore?.focus?.()
    }
  }, [onClose])

  return (
    <Overlay role="dialog" aria-modal aria-label={label} onClick={onClose}>
      <div className="overlay__card auth" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <PanelCorners size={16} />
        {children}
      </div>
    </Overlay>
  )
}

/**
 * «أبلغ» — the report dialog. A reason (required, defaults to the first) and an
 * optional line, then one quiet «أرسِل البلاغ». `context` is a breadcrumb the
 * owner sees — «الملف» from a profile, the room code from a مساجلة.
 */
function ReportDialog({
  targetUsername,
  albumCode,
  displayName,
  heading,
  lede,
  context,
  onClose,
}: {
  targetUsername?: string
  /** set when what is reported is a ديوان — the server derives the account */
  albumCode?: string
  displayName: string
  heading?: string
  lede?: string
  context?: string
  onClose: () => void
}) {
  const [reason, setReason] = useState<ReportReason>("harassment")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await reportUser({
        ...(albumCode ? { albumCode } : { targetUsername: targetUsername! }),
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(context ? { context } : {}),
      })
      toast("وصل بلاغك — شكرًا لك", "ok")
      onClose()
    } catch (err) {
      setBusy(false)
      setError(err instanceof ApiError ? err.message : "تعذّر إرسال البلاغ")
    }
  }

  return (
    <Modal label={albumCode ? "الإبلاغ عن ديوان" : "الإبلاغ عن حساب"} onClose={onClose}>
      <header className="auth__head">
        <div className="auth__headings">
          <h2 className="auth__title">{heading ?? `الإبلاغ عن «${displayName}»`}</h2>
          <p className="auth__lede">
            {lede ?? "يصل بلاغك إلى القائمين على الديوان. لا يُخبَر صاحب الحساب بأنك أبلغت عنه."}
          </p>
        </div>
        <button type="button" className="btn btn--ghost auth__close" onClick={onClose} aria-label="إغلاق">
          ✕
        </button>
      </header>

      <Rule className="auth__rule" />

      <form className="auth__form" onSubmit={submit} noValidate>
        <label className="auth-field">
          <span className="auth-field__label">السبب</span>
          <select
            className="auth-field__input"
            value={reason}
            onChange={(e) => setReason(e.target.value as ReportReason)}
          >
            {REPORT_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="auth-field">
          <span className="auth-field__label">تفصيل (اختياري)</span>
          <textarea
            className="auth-field__input mod-report__note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="ما الذي دعاك للإبلاغ؟"
          />
        </label>

        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="auth__actions">
          <button type="submit" className="btn btn--primary auth__submit" disabled={busy}>
            {busy ? "لحظة…" : "أرسِل البلاغ"}
          </button>
          <button type="button" className="btn btn--ghost auth__switch" onClick={onClose}>
            رجوع
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** «احظر» — the confirm dialog. Unblocking needs no confirm; it only undoes. */
function BlockConfirm({
  displayName,
  busy,
  onConfirm,
  onClose,
}: {
  displayName: string
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal label="حظر حساب" onClose={onClose}>
      <header className="auth__head">
        <div className="auth__headings">
          <h2 className="auth__title">حظر «{displayName}»؟</h2>
          <p className="auth__lede">
            لن يستطيع الدخول إلى غرفك ولا مساجلتك، ولن يُخبَر بذلك. لك أن ترفع الحظر متى شئت.
          </p>
        </div>
        <button type="button" className="btn btn--ghost auth__close" onClick={onClose} aria-label="إغلاق">
          ✕
        </button>
      </header>

      <Rule className="auth__rule" />

      <div className="auth__actions">
        <button type="button" className="btn btn--danger auth__submit" onClick={onConfirm} disabled={busy}>
          {busy ? "لحظة…" : "احظره"}
        </button>
        <button type="button" className="btn btn--ghost auth__switch" onClick={onClose}>
          رجوع
        </button>
      </div>
    </Modal>
  )
}

/**
 * The «أبلغ» / «احظر» pair, small and quiet, for a profile page or a room.
 *
 * `blocked` is the reader's current state (from the profile DTO, or tracked by
 * the caller); `onBlockChange` lets the parent keep its own copy in step. A
 * signed-out reader gets nothing — the caller only mounts this when there is a
 * viewer and the target is someone else.
 */
export function ModerationActions({
  username,
  displayName,
  blocked,
  context,
  onBlockChange,
  className,
}: {
  username: string
  displayName: string
  blocked: boolean
  context?: string
  onBlockChange?: (blocked: boolean) => void
  className?: string
}) {
  const [reporting, setReporting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const doBlock = async () => {
    if (busy) return
    setBusy(true)
    try {
      await blockUser(username)
      onBlockChange?.(true)
      toast("حظرتَه", "ok")
      setConfirming(false)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "تعذّر الحظر", "danger")
    } finally {
      setBusy(false)
    }
  }

  const doUnblock = async () => {
    if (busy) return
    setBusy(true)
    try {
      await unblockUser(username)
      onBlockChange?.(false)
      toast("رفعتَ الحظر", "ok")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "تعذّر رفع الحظر", "danger")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`mod-actions${className ? ` ${className}` : ""}`}>
      <button type="button" className="btn btn--ghost mod-actions__btn" onClick={() => setReporting(true)}>
        أبلغ
      </button>
      {blocked ? (
        <button type="button" className="btn btn--ghost mod-actions__btn" onClick={() => void doUnblock()} disabled={busy}>
          ألغِ الحظر
        </button>
      ) : (
        <button type="button" className="btn btn--ghost mod-actions__btn" onClick={() => setConfirming(true)} disabled={busy}>
          احظر
        </button>
      )}

      {reporting ? (
        <ReportDialog
          targetUsername={username}
          displayName={displayName}
          context={context}
          onClose={() => setReporting(false)}
        />
      ) : null}
      {confirming ? (
        <BlockConfirm displayName={displayName} busy={busy} onConfirm={() => void doBlock()} onClose={() => setConfirming(false)} />
      ) : null}
    </div>
  )
}

/**
 * «أبلغ عن هذا الديوان» — the same door, over a shelf instead of an account.
 *
 * A ديوان's اسم and وصف are its curator's own words on a page carrying his
 * name, so they are UGC exactly as a display name is and they need the same
 * quiet affordance. What is deliberately NOT here is «احظر»: blocking is a
 * relation between two people and its place is the person's page, not one of
 * his shelves — the caller offers this to a signed-in non-owner only.
 *
 * The client sends the CODE and no username. The server derives the reported
 * account from the shelf's owner (server/routes/moderation.ts), so this
 * component cannot be made to file against somebody who does not own it.
 */
export function AlbumReportAction({
  code,
  title,
  curator,
  className,
}: {
  code: string
  title: string
  curator: string
  className?: string
}) {
  const [reporting, setReporting] = useState(false)
  return (
    <>
      <button
        type="button"
        className={`btn btn--ghost mod-actions__btn${className ? ` ${className}` : ""}`}
        onClick={() => setReporting(true)}
      >
        أبلغ عن هذا الديوان
      </button>
      {reporting ? (
        <ReportDialog
          albumCode={code}
          displayName={curator}
          heading={`الإبلاغ عن ديوان «${title}»`}
          /* «القائمين على قريض», not «على الديوان»: the account form's lede uses
             الديوان for the SITE, and on this dialog the same word is already
             the shelf being reported — one sentence, two senses. */
          lede="يصل بلاغك إلى القائمين على قريض، ومعه اسمُ هذا الديوان ووصفُه. لا يُخبَر جامعه بأنك أبلغت."
          context="ديوان"
          onClose={() => setReporting(false)}
        />
      ) : null}
    </>
  )
}
