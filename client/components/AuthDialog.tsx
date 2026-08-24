/**
 * «دخول / حساب جديد» (v2.md §4).
 *
 * One card, two forms, and a line at the top that answers the question a
 * reader actually has in front of a sign-up form on a poetry site: what do I
 * lose by not doing this? (Nothing — the ديوان is open and solo play is saved
 * in this browser. An account is for مساجلة with a friend, and for a page with
 * your name on it.)
 *
 * There is no email field, so there is no password reset: that is the whole
 * design, not an omission (v2.md §4 — the owner deletes a row). The dialog says
 * so under the password, because a reader who is told will pick a password they
 * can keep.
 *
 * Modal mechanics are HelpOverlay's: `aria-modal`, Escape closes, Tab is
 * trapped inside the card, focus returns to whatever opened it.
 */
import { useEffect, useRef, useState } from "react"
import { PasswordSchema, UsernameSchema } from "../../shared/schema.ts"
import { useAuth, type AuthMode } from "../store/authStore.ts"
import { Nib, PanelCorners, Rule } from "./Ornaments.tsx"
import { Segmented } from "./Segmented.tsx"

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const MODES: readonly { value: AuthMode; label: string }[] = [
  { value: "login", label: "دخول" },
  { value: "register", label: "حساب جديد" },
]

/**
 * The form validates ITSELF, in Arabic, and the `<form>` carries `noValidate`.
 *
 * `required` / `minLength` are not a free win here: the browser's own bubble is
 * written in the BROWSER's language, and «Please lengthen this text to 3
 * characters or more» in the middle of an all-Arabic dialog is exactly the
 * seam this app does not have anywhere else. The rules come from the SAME zod
 * schemas the server validates with (shared/schema.ts), so there is one
 * definition of a legal username and this is only its Arabic voice.
 */
function localProblem(mode: AuthMode, fields: { username: string; password: string; invite: string }, needsInvite: boolean): string | null {
  const username = fields.username.trim()
  if (!username) return "اكتب اسم المستخدم"
  if (mode === "register" && !UsernameSchema.safeParse(username).success) {
    return "اسم المستخدم: من 3 إلى 24 حرفًا بلا فراغ"
  }
  if (!fields.password) return "اكتب كلمة السر"
  if (mode === "register" && !PasswordSchema.safeParse(fields.password).success) {
    return "كلمة السر ثمانية أحرف فأكثر"
  }
  if (mode === "register" && needsInvite && !fields.invite.trim()) return "اكتب رمز الدعوة"
  return null
}

export function AuthDialog() {
  const mode = useAuth((s) => s.dialog)
  const busy = useAuth((s) => s.busy)
  const error = useAuth((s) => s.error)
  const requiresInvite = useAuth((s) => s.requiresInvite)
  const setMode = useAuth((s) => s.setMode)
  const setError = useAuth((s) => s.setError)
  const close = useAuth((s) => s.closeDialog)
  const register = useAuth((s) => s.register)
  const login = useAuth((s) => s.login)

  const cardRef = useRef<HTMLDivElement | null>(null)
  const firstFieldRef = useRef<HTMLInputElement | null>(null)
  const [username, setUsername] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [invite, setInvite] = useState("")

  const open = mode !== null

  useEffect(() => {
    if (!open) return
    const restore = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        close()
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
    firstFieldRef.current?.focus()
    return () => {
      window.removeEventListener("keydown", onKey)
      restore?.focus?.()
    }
  }, [open, close])

  if (!open) return null

  const registering = mode === "register"
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const problem = localProblem(mode, { username, password, invite }, requiresInvite)
    if (problem) {
      setError(problem)
      return
    }
    const ok = registering
      ? await register({ username, displayName, password, invite })
      : await login({ username, password })
    if (ok) {
      setPassword("")
      setInvite("")
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={registering ? "حساب جديد" : "دخول"} onClick={close}>
      <div className="overlay__card auth" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        {/* the four manuscript corners a Panel carries — this card is the one
            overlay that asks the reader for something, so it is illuminated */}
        <PanelCorners size={16} />
        <header className="auth__head">
          <span className="auth__nib" aria-hidden="true">
            <Nib size={22} />
          </span>
          <div className="auth__headings">
            <h2 className="auth__title">{registering ? "حساب جديد" : "دخول"}</h2>
            <p className="auth__lede">
              الديوان مفتوح بلا حساب، ولعبك المفرد محفوظ في متصفحك. إنما الحساب لمساجلة صديقٍ باسمك، ولصفحةٍ تحمله.
            </p>
          </div>
          <button type="button" className="btn btn--ghost auth__close" onClick={close} aria-label="إغلاق">
            ✕
          </button>
        </header>

        <Rule className="auth__rule" />

        <div className="auth__modes">
          <Segmented options={MODES} value={mode} onChange={setMode} label="دخول أو حساب جديد" />
        </div>

        <form className="auth__form" onSubmit={submit} noValidate>
          <label className="auth-field">
            <span className="auth-field__label">اسم المستخدم</span>
            <input
              ref={firstFieldRef}
              className="auth-field__input"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              spellCheck={false}
              maxLength={24}
              placeholder="لبيد"
            />
            <span className="auth-field__note">
              {registering ? "من 3 إلى 24 حرفًا بلا فراغ، عربيةً أو لاتينية — وهو عنوان صفحتك." : "كما كتبتَه عند التسجيل"}
            </span>
          </label>

          {registering ? (
            <label className="auth-field">
              <span className="auth-field__label">
                الاسم المعروض <span className="auth-field__optional">(اختياري)</span>
              </span>
              <input
                className="auth-field__input"
                name="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="nickname"
                maxLength={40}
                placeholder="لبيد بن ربيعة"
              />
              <span className="auth-field__note">ما يراه خصمك على لوح المساجلة. إن تركتَه فاسمُك هو.</span>
            </label>
          ) : null}

          <label className="auth-field">
            <span className="auth-field__label">كلمة السر</span>
            <input
              className="auth-field__input"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={registering ? "new-password" : "current-password"}
              maxLength={200}
            />
            <span className="auth-field__note">
              {registering ? "ثمانية أحرف فأكثر. ولا بريد هنا ولا استرجاع، فاحفظها." : "ثمانية أحرف فأكثر"}
            </span>
          </label>

          {registering && requiresInvite ? (
            <label className="auth-field">
              <span className="auth-field__label">رمز الدعوة</span>
              <input
                className="auth-field__input"
                name="invite"
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                spellCheck={false}
                maxLength={64}
              />
              <span className="auth-field__note">التسجيل في هذا الخادم بدعوة</span>
            </label>
          ) : null}

          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="auth__actions">
            <button type="submit" className="btn btn--primary auth__submit" disabled={busy}>
              {busy ? "لحظة…" : registering ? "أنشئ الحساب" : "ادخل"}
            </button>
            <button
              type="button"
              className="btn btn--ghost auth__switch"
              onClick={() => setMode(registering ? "login" : "register")}
            >
              {registering ? "لي حساب — أدخِلني" : "لا حساب لي — أنشئه"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
