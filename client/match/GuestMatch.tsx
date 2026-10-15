/**
 * «مساجلة بلا حساب» — the door into `#/match/<CODE>` from the duel setup
 * screen: a name, the three rules, and the server draws the opening بيت.
 */
import { useEffect, useRef, useState } from "react"

import { ApiError } from "../api/client.ts"
import { PanelCorners } from "../components/Ornaments.tsx"
import { Overlay } from "../components/Overlay.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { Sheet } from "../components/Sheet.tsx"
import { useNativeChrome } from "../hooks/useNativeChrome.ts"
import { navigate } from "../router.ts"
import { formatNumber } from "../../shared/format.ts"
import { MATCH_ERRORS, MATCH_NAME_MAX } from "../../shared/match.ts"
import { ROOM_STRIKES_DEFAULT, ROOM_TIMERS, type ChainMode } from "../../shared/schema.ts"
import { createMatch } from "./api.ts"
import { lastName, rememberName, saveSeat } from "./seats.ts"

type TimerChoice = "off" | "30" | "60" | "90"

const CHAIN_OPTIONS: readonly { value: ChainMode; label: string }[] = [
  { value: "rhyme", label: "الرويّ" },
  { value: "literal", label: "الحرف الأخير" },
]
const TIMER_OPTIONS: readonly { value: TimerChoice; label: string }[] = [
  { value: "off", label: "بلا وقت" },
  ...ROOM_TIMERS.map((s) => ({ value: String(s) as TimerChoice, label: formatNumber(s) })),
]
const STRIKE_OPTIONS = [1, 2, 3].map((n) => ({ value: String(n), label: formatNumber(n) }))

/** The button, and the dialog it opens. */
export function GuestMatchButton({ primary }: { primary: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={primary ? "btn btn--primary btn--lg" : "btn btn--ghost"}
        onClick={() => setOpen(true)}
      >
        {primary ? "افتح مساجلة" : "أو مساجلة بلا حساب"}
      </button>
      {open ? <GuestMatchDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function GuestMatchDialog({ onClose }: { onClose: () => void }) {
  const native = useNativeChrome()
  const [name, setName] = useState(lastName)
  const [mode, setMode] = useState<ChainMode>("rhyme")
  const [timer, setTimer] = useState<TimerChoice>("60")
  const [strikes, setStrikes] = useState(String(ROOM_STRIKES_DEFAULT))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (native) return
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [native, onClose])

  const create = async () => {
    setBusy(true)
    setError(null)
    const clean = name.trim() || null
    rememberName(clean)
    try {
      const res = await createMatch({
        name: clean,
        mode,
        timerS: timer === "off" ? null : (Number(timer) as 30 | 60 | 90),
        strikes: Number(strikes),
      })
      saveSeat(res.state.code, { secret: res.secret, shareUrl: res.shareUrl })
      onClose()
      navigate({ view: "match", code: res.state.code })
    } catch (err) {
      setBusy(false)
      setError(err instanceof ApiError ? ((err.code ? MATCH_ERRORS[err.code] : undefined) ?? err.message) : "تعذّر فتح المساجلة")
    }
  }

  const body = (
    <div className="friend-dialog__body">
      <section className="friend-sect">
        <h3 className="friend-sect__title">اسمك</h3>
        <p className="friend-sect__lede">يراه خصمك وحده. اتركه فارغًا إن شئت.</p>
        <div className="friend-search">
          <input
            className="friend-search__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="اسمك (اختياري)"
            maxLength={MATCH_NAME_MAX}
            dir="auto"
            autoComplete="nickname"
            aria-label="اسمك"
          />
        </div>
      </section>
      <section className="friend-sect">
        <h3 className="friend-sect__title">القاعدة</h3>
        <div className="friend-row">
          <span className="friend-row__label">السلسلة</span>
          <Segmented label="قاعدة السلسلة" value={mode} onChange={setMode} options={CHAIN_OPTIONS} />
        </div>
        <div className="friend-row">
          <span className="friend-row__label">الوقت للبيت</span>
          <Segmented label="الوقت" value={timer} onChange={setTimer} options={TIMER_OPTIONS} />
        </div>
        <div className="friend-row">
          <span className="friend-row__label">الضربات</span>
          <Segmented label="الضربات" value={strikes} onChange={setStrikes} options={STRIKE_OPTIONS} />
        </div>
        <p className="friend-row__note">المطلع يختاره الديوان من مشاهير الأبيات، ويُجيب عنه صاحبك أوّلًا.</p>
      </section>
      {error ? (
        <p className="friend-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )

  const acts = (
    <>
      <button type="button" className="btn btn--primary btn--lg" onClick={() => void create()} disabled={busy}>
        {busy ? "…تُفتح" : "افتح المساجلة"}
      </button>
      <button type="button" className="btn btn--ghost" onClick={onClose}>
        رجوع
      </button>
    </>
  )

  if (native) {
    return (
      <Sheet
        title="مساجلة بلا حساب"
        note="افتحها، ثم ابعث الرابط إلى صاحبك."
        onClose={onClose}
        className="sheet--friend"
        footer={<div className="sheet__acts">{acts}</div>}
      >
        {body}
      </Sheet>
    )
  }

  return (
    <Overlay onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="overlay__card friend-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-match-title"
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <PanelCorners size={16} />
        <header className="friend-dialog__head">
          <h2 className="friend-dialog__title" id="guest-match-title">
            مساجلة بلا حساب
          </h2>
          <button type="button" className="btn btn--ghost friend-dialog__close" onClick={onClose} aria-label="أغلق">
            ✕
          </button>
        </header>
        {body}
        <footer className="friend-dialog__foot">{acts}</footer>
      </div>
    </Overlay>
  )
}
