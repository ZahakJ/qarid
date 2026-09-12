/**
 * «دخول / حساب جديد» (v2.md §4).
 *
 * One card, two forms, and a line at the top that answers the question a
 * reader actually has in front of a sign-up form on a poetry site: what do I
 * lose by not doing this? (Nothing — the ديوان is open and solo play is saved
 * in this browser. An account is for مساجلة with a friend, and for a page with
 * your name on it.)
 *
 * There is no email, so recovery is a CODE, not a link (Play launch): a strong
 * string shown ONCE at registration and stored server-side only as a scrypt
 * hash. «نسيت كلمة السر؟» opens the reset form (username + that code + a new
 * password); a successful register or reset flips this card to the once-shown
 * «احفظ رمزك» panel before it closes.
 *
 * Modal mechanics are HelpOverlay's: `aria-modal`, Escape closes, Tab is
 * trapped inside the card, focus returns to whatever opened it.
 *
 * ON A PHONE it is the same form in a BOTTOM SHEET (client/components/Sheet.tsx).
 * A centred card that asks for a password puts its fields under the keyboard and
 * its ✕ in the corner furthest from the hand holding the device. The FORM is one
 * expression either way — only the furniture around it differs — so there is no
 * second sign-in screen to keep in step, and the desktop's dialog is untouched.
 */
import { useEffect, useRef, useState } from "react"
import { PasswordSchema, UsernameSchema } from "../../shared/schema.ts"
import { routeHash } from "../router.ts"
import { useNativeChrome } from "../hooks/useNativeChrome.ts"
import { useAuth, type AuthMode } from "../store/authStore.ts"
import { Nib, PanelCorners, Rule } from "./Ornaments.tsx"
import { RecoveryCodePanel } from "./RecoveryCode.tsx"
import { Segmented } from "./Segmented.tsx"
import { Sheet } from "./Sheet.tsx"
import { Overlay } from "./Overlay.tsx"

/** The form's id, so its submit can live in the sheet's pinned footer. */
const FORM_ID = "auth-form"

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
function localProblem(
  mode: AuthMode,
  fields: { username: string; password: string; invite: string; recoveryCode: string },
  needsInvite: boolean,
): string | null {
  const username = fields.username.trim()
  if (!username) return "اكتب اسم المستخدم"
  if (mode === "register" && !UsernameSchema.safeParse(username).success) {
    return "اسم المستخدم: من 3 إلى 24 حرفًا بلا فراغ"
  }
  if (mode === "reset") {
    if (!fields.recoveryCode.trim()) return "اكتب رمز الاستعادة"
    if (!PasswordSchema.safeParse(fields.password).success) return "كلمة السر الجديدة ثمانية أحرف فأكثر"
    return null
  }
  if (!fields.password) return "اكتب كلمة السر"
  if (mode === "register" && !PasswordSchema.safeParse(fields.password).success) {
    return "كلمة السر ثمانية أحرف فأكثر"
  }
  if (mode === "register" && needsInvite && !fields.invite.trim()) return "اكتب رمز الدعوة"
  return null
}

export function AuthDialog() {
  const native = useNativeChrome()
  const mode = useAuth((s) => s.dialog)
  const busy = useAuth((s) => s.busy)
  const error = useAuth((s) => s.error)
  const requiresInvite = useAuth((s) => s.requiresInvite)
  const recoveryCode = useAuth((s) => s.recoveryCode)
  const setMode = useAuth((s) => s.setMode)
  const setError = useAuth((s) => s.setError)
  const close = useAuth((s) => s.closeDialog)
  const register = useAuth((s) => s.register)
  const login = useAuth((s) => s.login)
  const resetPassword = useAuth((s) => s.resetPassword)
  const dismissRecovery = useAuth((s) => s.dismissRecovery)

  const cardRef = useRef<HTMLDivElement | null>(null)
  const firstFieldRef = useRef<HTMLInputElement | null>(null)
  const [username, setUsername] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [invite, setInvite] = useState("")
  const [recoveryInput, setRecoveryInput] = useState("")
  /**
   * Has the reader actually TAKEN the recovery code — copied it, or said in so
   * many words that they wrote it down?
   *
   * This is the one-and-only display of the only credential that can ever
   * recover a قريض account (there is no email), and the panel's own copy says
   * so. It used to carry a ✕, dismiss on its scrim and offer «حفظتُه — تابِع»
   * as one of three equally easy exits, so a reader who tapped ✕ out of habit
   * lost the account silently. Now the other two are gone and this gates the
   * third.
   */
  const [codeTaken, setCodeTaken] = useState(false)

  const open = mode !== null
  // The once-shown recovery panel takes over the whole card when it is set.
  const showingCode = recoveryCode !== null

  // A fresh code is a fresh acknowledgement — regenerating must not inherit the
  // «كتبتُه في مأمن» of the code it just replaced.
  useEffect(() => setCodeTaken(false), [recoveryCode])

  // The card's own modal mechanics. On a phone `Sheet` owns all three — Escape,
  // the Tab trap and the focus restore — so this effect stands down rather than
  // running a second trap over a card that is not in the document.
  useEffect(() => {
    if (!open || native) return
    const restore = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        // …except on the recovery step, where Escape is a third silent way to
        // lose the only credential that can recover the account. The sheet path
        // suppresses it the same way (`dismissible` in Sheet.tsx).
        if (!showingCode) close()
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
  }, [open, native, close, showingCode])

  if (!open) return null

  const registering = mode === "register"
  const resetting = mode === "reset"
  const title = showingCode ? "احفظ رمز استعادتك" : resetting ? "استعادة كلمة السر" : registering ? "حساب جديد" : "دخول"
  const lede = showingCode
    ? "هذا رمز استعادتك، ولن يظهر ثانيةً. به وحده تستعيد حسابك إن نسيتَ كلمة السر — فاحفظه في مأمن."
    : resetting
      ? "أدخِل اسمك ورمز الاستعادة الذي حُفظ لك، واختر كلمة سرٍّ جديدة."
      : "الديوان مفتوح بلا حساب، ولعبك المفرد محفوظ في متصفحك. إنما الحساب لمساجلة صديقٍ باسمك، ولصفحةٍ تحمله."

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const problem = localProblem(mode!, { username, password, invite, recoveryCode: recoveryInput }, requiresInvite)
    if (problem) {
      setError(problem)
      return
    }
    const ok = resetting
      ? await resetPassword({ username, recoveryCode: recoveryInput, newPassword: password })
      : registering
        ? await register({ username, displayName, password, invite })
        : await login({ username, password })
    if (ok) {
      // The recovery panel (register/reset) reads the fresh fields no more; a
      // plain login just closes. Either way, wipe the secrets from the form.
      setPassword("")
      setInvite("")
      setRecoveryInput("")
    }
  }

  // The FORM, and nothing around it. The desktop dresses it in a card with
  // manuscript corners; a phone puts the same nodes in a bottom sheet. One
  // definition, so a field added here cannot come to exist on only one of them.
  const body = (
    <>
      {showingCode ? (
        <div className="auth__recovery">
          <RecoveryCodePanel
            code={recoveryCode!}
            headline="رمز الاستعادة"
            note="اكتبه على ورق أو احفظه في مدير كلمات السر. لا بريد هنا يُرسله إليك ثانيةً، وليس عند الخادم إلا بصمته لا الرمز نفسه."
            onCopied={() => setCodeTaken(true)}
          />
          {/* The gate. «انسخ» satisfies it too (RecoveryCodePanel's onCopied),
              so a reader who took the code does not also have to tick a box. */}
          <label className="auth-ack">
            <input
              type="checkbox"
              className="auth-ack__box"
              checked={codeTaken}
              onChange={(e) => setCodeTaken(e.target.checked)}
            />
            <span className="auth-ack__label">كتبتُه في مأمن</span>
          </label>
        </div>
      ) : (
        <>
          {resetting ? null : (
            <div className="auth__modes">
              <Segmented options={MODES} value={mode!} onChange={setMode} label="دخول أو حساب جديد" />
            </div>
          )}

          <form id={FORM_ID} className="auth__form" onSubmit={submit} noValidate>
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
                {registering
                  ? "من 3 إلى 24 حرفًا بلا فراغ، عربيةً أو لاتينية — وهو عنوان صفحتك."
                  : "كما كتبتَه عند التسجيل"}
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

            {resetting ? (
              <label className="auth-field">
                <span className="auth-field__label">رمز الاستعادة</span>
                <input
                  className="auth-field__input num"
                  name="recoveryCode"
                  value={recoveryInput}
                  onChange={(e) => setRecoveryInput(e.target.value)}
                  autoComplete="one-time-code"
                  spellCheck={false}
                  dir="ltr"
                  maxLength={40}
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                />
                <span className="auth-field__note">الرمز الذي حُفظ لك عند التسجيل. الشُّرَط والحروف الكبيرة لا يُعتدّ بها.</span>
              </label>
            ) : null}

            <label className="auth-field">
              <span className="auth-field__label">{resetting ? "كلمة السر الجديدة" : "كلمة السر"}</span>
              <input
                className="auth-field__input"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={registering || resetting ? "new-password" : "current-password"}
                maxLength={200}
              />
              <span className="auth-field__note">
                {registering
                  ? "ثمانية أحرف فأكثر. ولا بريد هنا، فاحفظ كلمة السر ورمز الاستعادة الذي يليها."
                  : resetting
                    ? "ثمانية أحرف فأكثر. ستُنهى كل جلساتك على كل جهاز."
                    : "ثمانية أحرف فأكثر"}
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

            {/* The two buttons are NOT here: on a phone they are the sheet's
                pinned footer (see `acts` below), on the desktop they follow the
                form. One definition either way. */}

            {mode === "login" ? (
              <button type="button" className="auth__forgot" onClick={() => setMode("reset")}>
                نسيتَ كلمة السر؟
              </button>
            ) : null}

            {registering ? (
              <p className="auth__fineprint">
                بإنشاء حساب تُقِرّ بـ
                <a href={routeHash({ view: "privacy" })} onClick={close}>
                  سياسة الخصوصية
                </a>
                — ولك أن تحذف حسابك متى شئت.
              </p>
            ) : null}
          </form>
        </>
      )}
    </>
  )

  /* The primary action and its switch, defined ONCE.
     `.auth__actions` puts the primary on the reading edge, as every other pair
     in this app does. The submit lives outside the `<form>` on a phone, so it
     names its form: a `<button form=…>` submits the form it points at, which is
     what lets the action be PINNED while the fields scroll under it. */
  /* The reason rides WITH the action, not at the far end of a scrolling body.
     On a phone the fields scroll under a pinned footer, so an error left in the
     body is an error under the bar — which is exactly how «ادخل بحسابك أوّلًا»
     came to be invisible in the room sheet. */
  const problem = error ? (
    <p className="auth__error" role="alert">
      {error}
    </p>
  ) : null

  const acts = showingCode ? (
    <div className="auth__actions">
      <button
        type="button"
        className="btn btn--primary auth__submit"
        onClick={dismissRecovery}
        disabled={!codeTaken}
      >
        حفظتُه — تابِع
      </button>
    </div>
  ) : (
    <div className="auth__actions">
      <button type="submit" form={FORM_ID} className="btn btn--primary auth__submit" disabled={busy}>
        {busy ? "لحظة…" : resetting ? "غيّر كلمة السر" : registering ? "أنشئ الحساب" : "ادخل"}
      </button>
      <button
        type="button"
        className="btn btn--ghost auth__switch"
        onClick={() => setMode(resetting ? "login" : registering ? "login" : "register")}
      >
        {resetting ? "لي كلمة سرّي — أدخِلني" : registering ? "لي حساب — أدخِلني" : "لا حساب لي — أنشئه"}
      </button>
    </div>
  )

  if (native) {
    /* The action is the sheet's PINNED footer, the shape «غرفة مساجلة» already
       uses. Measured before: with the keyboard up the viewport shrinks 844 →
       420 and «ادخل» sat at y 475–519 — below the screen — so the primary
       action of the sheet could only be reached by scrolling the body while
       typing a password.

       `dismissible` is off on the recovery step alone: that panel shows the one
       credential that can recover the account, and a ✕ or a scrim tap there
       loses it silently. */
    return (
      <Sheet
        title={title}
        note={lede}
        onClose={close}
        className="sheet--auth"
        dismissible={!showingCode}
        footer={
          <div className="sheet__acts">
            {problem}
            {acts}
          </div>
        }
      >
        {body}
      </Sheet>
    )
  }

  return (
    <Overlay role="dialog" aria-modal aria-label={title} onClick={showingCode ? undefined : close}>
      <div className="overlay__card auth" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        {/* the four manuscript corners a Panel carries — this card is the one
            overlay that asks the reader for something, so it is illuminated */}
        <PanelCorners size={16} />
        <header className="auth__head">
          <span className="auth__nib" aria-hidden="true">
            <Nib size={22} />
          </span>
          <div className="auth__headings">
            <h2 className="auth__title">{title}</h2>
            <p className="auth__lede">{lede}</p>
          </div>
          {showingCode ? null : (
            <button type="button" className="btn btn--ghost auth__close" onClick={close} aria-label="إغلاق">
              ✕
            </button>
          )}
        </header>

        <Rule className="auth__rule" />

        {body}
        {problem}
        {acts}
      </div>
    </Overlay>
  )
}
