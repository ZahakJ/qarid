/**
 * `#/u/<username>` — a page with your name on it (v2.md §4).
 *
 * What it shows, and why in this order: WHO (the نِيب disc, the display name in
 * Aref Ruqaa, the day you joined), then the مساجلة record — which is the whole
 * reason accounts exist — then the أبيات you have recited against a human, then
 * «دواوينه», then the ترسانة you chose to publish.
 *
 * The دواوين here are the PUBLIC ones and only those: making a ديوان «مفتوح» is
 * the publish gesture, and this is the page it publishes to. The section is
 * absent — not empty — for an account that has published none, because a
 * visitor should not be told what a stranger has not done.
 *
 * The duel numbers come from `rooms`/`match_turns` and read zero until §5's
 * multiplayer lands. That is deliberate and it is SAID on the page («لا مساجلة
 * بعد»), because a stat tile showing 0 with no explanation is indistinguishable
 * from a broken query.
 *
 * SOLO play is NOT here. `qarid:v1:profile` in this browser holds your
 * single-player record and stays the source of truth for it; the one thing that
 * crosses over is the ترسانة, and only when you press «زامِن».
 */
import { useEffect, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { getProfile, regenerateRecovery, syncArsenal, updateProfile } from "../api/queries.ts"
import { Avatar } from "../components/Avatar.tsx"
import { AvatarControl } from "../components/AvatarControl.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { ModerationActions } from "../components/Moderation.tsx"
import { BlockedList } from "../components/BlockedList.tsx"
import { Nib, PanelCorners, Rule } from "../components/Ornaments.tsx"
import { Panel } from "../components/Panel.tsx"
import { RecoveryCodePanel } from "../components/RecoveryCode.tsx"
import { HOME, navigate, routeHash } from "../router.ts"
import { useAuth, tookSessionExpiry } from "../store/authStore.ts"
import { toast } from "../store/toastStore.ts"
import { trainingSlice, useTraining } from "../store/trainingStore.ts"
import {
  arabicDate,
  BAYT_FORMS,
  FAWZ_FORMS,
  MUSAJALA_FORMS,
  countedNoun,
  countedNounWithAdjective,
  countedUnit,
  formatNumber,
} from "../../shared/format.ts"
import { HIJAI_LETTERS, LETTER_NAMES } from "../../shared/letters.ts"
import type { ProfileResponse } from "../../shared/schema.ts"
import { Overlay } from "../components/Overlay.tsx"
import { useChromeTitle } from "../components/AppBar.tsx"
import { DiwanCard } from "../albums/DiwanCard.tsx"

/**
 * «24 آب 2026» — `arabicDate` from shared/format.ts, the app's ONE calendar.
 *
 * This view used to keep a local, transliterated table («أغسطس»), so «انضمّ في
 * 24 أغسطس 2026» sat one tab away from #/daily's «تحدّي 24 آب».
 */
const dateLabel = arabicDate

/**
 * «بيت واحد محفوظ» · «بيتان محفوظان» · «5 أبيات محفوظة» · «12 بيتًا محفوظًا».
 *
 * The نعت has to agree with the معدود, which is exactly the agreement that
 * breaks when a phrase is assembled by concatenation — «3 محفوظًا» was what the
 * ترسانة cell's tooltip said (CLAUDE.md, العدد والمعدود live in format.ts).
 */
const MAHFUZ = { one: "محفوظ", two: "محفوظان", few: "محفوظة", many: "محفوظًا" } as const

const RESULT_LABEL: Record<"win" | "loss" | "open", string> = {
  win: "فوز",
  loss: "خسارة",
  open: "لم تُحسم",
}

export function ProfileView({ username }: { username: string }) {
  const [page, setPage] = useState<ProfileResponse | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const setUser = useAuth((s) => s.setUser)
  const signOut = useAuth((s) => s.signOut)
  const me = useAuth((s) => s.user)
  // `qarid:v1:training` has two writers, so every training-aware view reloads
  // on mount (CLAUDE.md) — otherwise «زامِن» could publish a stale ترسانة.
  const reload = useTraining((s) => s.reload)

  // The tab and the phone app bar both say WHOSE page this is — «المضيف —
  // قريض», not «الحساب — قريض» for every account there is. Hooks run before
  // the early returns below, so this one is declared here.
  useChromeTitle(page?.user.displayName ?? null)

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    const ac = new AbortController()
    setPage(null)
    setError(null)
    getProfile(username, { signal: ac.signal })
      .then((p) => {
        if (ac.signal.aborted) return
        setPage(p)
        setDraft(p.user.displayName)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر جلب الصفحة", "/api/profile"))
      })
    return () => ac.abort()
  }, [username])

  if (error) {
    const missing = error.status === 404
    return (
      <div className="view profile-view">
        <header className="view__head">
          <h1 className="view__title">الحساب</h1>
        </header>
        {missing ? (
          <EmptyState flavor="search-none" title="لا حساب بهذا الاسم">
            <p className="empty__note">لعلّه غيّر اسمه، أو لعلّك كتبتَه على غير وجهه.</p>
            <a className="btn" href={routeHash({ view: "home" })}>
              إلى الديوان
            </a>
          </EmptyState>
        ) : (
          <div className="view-error" role="alert">
            <p className="view-error__msg">{error.message}</p>
            <a className="btn" href={routeHash({ view: "home" })}>
              إلى الديوان
            </a>
          </div>
        )}
      </div>
    )
  }

  if (!page) {
    return (
      <div className="view profile-view">
        <div className="profile-hero" aria-hidden="true">
          <span className="skeleton profile-hero__disc-skeleton" />
          <span className="skeleton" style={{ blockSize: "1.9rem", inlineSize: "min(14rem, 60%)" }} />
        </div>
        <div className="stat-tiles" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span className="skeleton" key={i} style={{ blockSize: "5.5rem" }} />
          ))}
        </div>
      </div>
    )
  }

  const { user, stats, recent, arsenal, isSelf, albums } = page

  const save = async () => {
    const name = draft.trim()
    if (!name || name === user.displayName) {
      setRenaming(false)
      return
    }
    setBusy(true)
    try {
      const next = await updateProfile(name)
      setPage(next)
      setUser(next.user)
      setRenaming(false)
      toast("حُفظ الاسم", "ok")
    } catch (e: unknown) {
      if (tookSessionExpiry(e)) return
      toast(e instanceof ApiError ? e.message : "تعذّر حفظ الاسم", "danger")
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    setBusy(true)
    try {
      const res = await syncArsenal(trainingSlice().arsenal)
      setPage({ ...page, arsenal: res.arsenal })
      toast("نُشرت ترسانتك على صفحتك", "ok")
    } catch (e: unknown) {
      if (tookSessionExpiry(e)) return
      toast(e instanceof ApiError ? e.message : "تعذّرت المزامنة", "danger")
    } finally {
      setBusy(false)
    }
  }

  const tiles: { n: number; cap: string }[] = [
    { n: stats.matches, cap: countedUnit(stats.matches, MUSAJALA_FORMS) },
    { n: stats.wins, cap: countedUnit(stats.wins, FAWZ_FORMS) },
    { n: stats.turns, cap: countedUnit(stats.turns, BAYT_FORMS) },
    { n: stats.bestChain, cap: "أطول سلسلة" },
  ]

  return (
    <div className="view profile-view">
      <header className="profile-hero">
        {isSelf ? (
          // Your own picture IS the control: tap the disc to add, change or
          // remove it (the camera badge sits where the نيب sits for visitors).
          <AvatarControl
            name={user.displayName}
            avatar={user.avatar}
            onChanged={(next) => {
              const updated = { ...page.user, avatar: next }
              setPage({ ...page, user: updated })
              setUser(updated)
            }}
          />
        ) : (
          <span className="profile-hero__disc" aria-hidden="true">
            <Avatar name={user.displayName} src={user.avatar} initialClassName="profile-hero__initial" />
            <span className="profile-hero__nib">
              <Nib size={14} />
            </span>
          </span>
        )}

        <div className="profile-hero__id">
          {renaming ? (
            <div className="profile-rename">
              <input
                className="auth-field__input profile-rename__input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={40}
                aria-label="الاسم المعروض"
                autoFocus
              />
              <button type="button" className="btn btn--primary" onClick={save} disabled={busy}>
                احفظ
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setDraft(user.displayName)
                  setRenaming(false)
                }}
              >
                رجوع
              </button>
            </div>
          ) : (
            <h1 className="profile-hero__name">{user.displayName}</h1>
          )}
          <p className="profile-hero__meta">
            <span className="profile-hero__handle">{user.username}</span>
            <span className="profile-hero__sep" aria-hidden="true">
              ·
            </span>
            <span>انضمّ في {dateLabel(user.joinedAt)}</span>
          </p>
        </div>

        {isSelf ? (
          <div className="profile-hero__acts">
            <span className="profile-hero__you">هذه صفحتك</span>
            {renaming ? null : (
              <button type="button" className="btn" onClick={() => setRenaming(true)}>
                غيّر الاسم
              </button>
            )}
            {/* «دواويني» is an account thing — a ديوان has a code, a
                visibility and a curator, and this is the page that carries the
                curator's name. The list itself is a route, so it is a link. */}
            <a className="btn" href={routeHash({ view: "diwans" })}>
              دواويني
            </a>
            <button type="button" className="btn" onClick={() => setRecovering(true)}>
              رمز الاستعادة
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => void signOut()}>
              اخرج
            </button>
            <button
              type="button"
              className="btn btn--ghost profile-hero__danger"
              onClick={() => setDeleting(true)}
            >
              احذف حسابي
            </button>
          </div>
        ) : me ? (
          // Someone else's page, and you are signed in: the quiet «أبلغ» / «احظر»
          // pair (Track 3). Blocking is private, so the button reflects only your
          // own state, carried in `youBlocked`.
          <div className="profile-hero__acts">
            <ModerationActions
              username={user.username}
              displayName={user.displayName}
              blocked={page.youBlocked}
              context="الملف"
              onBlockChange={(b) => setPage({ ...page, youBlocked: b })}
            />
          </div>
        ) : null}
      </header>

      {deleting ? (
        <DeleteAccountDialog
          username={user.username}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false)
            toast("حُذف حسابك", "ok")
            navigate(HOME)
          }}
        />
      ) : null}

      {recovering ? <RecoveryCodeDialog onClose={() => setRecovering(false)} /> : null}

      <Rule className="profile-rule" />

      <section className="profile-section" aria-labelledby="profile-record">
        <h2 className="profile-section__title" id="profile-record">
          سجلّ المساجلة
        </h2>
        <div className="stat-tiles">
          {tiles.map((t) => (
            <div className="stat-tile" key={t.cap}>
              <span className="stat-tile__n num">{formatNumber(t.n)}</span>
              <span className="stat-tile__cap">{t.cap}</span>
            </div>
          ))}
        </div>
        <p className="profile-note">
          هذا سجلّ المساجلة مع الناس. أمّا مساجلتك للديوان وحدك فمحفوظة في متصفحك، لا هنا.
        </p>
      </section>

      <section className="profile-section" aria-labelledby="profile-matches">
        <h2 className="profile-section__title" id="profile-matches">
          آخر المساجلات
        </h2>
        {recent.length === 0 ? (
          <Panel quiet className="profile-empty">
            <div className="profile-empty__text">
              <p className="profile-empty__line">لا مساجلة بعد.</p>
              <p className="profile-empty__note">ادعُ صديقًا إلى بيتٍ واحد، وليُجِبْ عن رويّه.</p>
            </div>
            <a className="btn btn--primary" href={routeHash({ view: "duel" })}>
              إلى المساجلة
            </a>
          </Panel>
        ) : (
          <ul className="match-list">
            {recent.map((m, i) => (
              <li className="match-row" key={m.code ?? `${m.createdAt}:${i}`} data-result={m.result}>
                {/* The room is still THERE — a finished one shows its whole
                    transcript, an open one is waiting for somebody. So the
                    verdict word is the way back into it (v2.md §5) — but only
                    on your OWN page: the code is the room's credential and the
                    server sends it to nobody else (ProfileMatchSchema). */}
                {m.code === null ? (
                  <span className="match-row__result">{RESULT_LABEL[m.result]}</span>
                ) : (
                  <a className="match-row__result" href={routeHash({ view: "room", code: m.code })}>
                    {RESULT_LABEL[m.result]}
                  </a>
                )}
                {/* A null opponent on a room that never started is «بانتظار
                    خصم»; on a played match it is a player who deleted their
                    account — «لاعب محذوف», the same name the room transcript
                    shows for the emptied seat. */}
                <span className="match-row__foe">
                  {m.opponent ?? (m.status === "waiting" ? "بانتظار خصم" : "لاعب محذوف")}
                </span>
                {/* «3 أبيات», never a bare «3» — a digit standing alone in a
                    ledger row names nothing (CLAUDE.md, العدد والمعدود). */}
                <span className="match-row__turns num">{countedNoun(m.turns, BAYT_FORMS)}</span>
                <span className="match-row__when">{dateLabel(m.endedAt ?? m.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        «دواوينه» — the shelves this account PUBLISHED.
        The section is absent, not empty, for an account that has published
        none: a visitor should not be told what a stranger has not done, and
        the owner's own door to «دواويني» is in the actions above. Nothing
        `unlisted` or `private` reaches this list — the server sends only what
        was published (ProfileResponseSchema).
      */}
      {albums.length > 0 ? (
        <section className="profile-section" aria-labelledby="profile-albums">
          <h2 className="profile-section__title" id="profile-albums">
            {isSelf ? "دواويني المنشورة" : "دواوينه"}
          </h2>
          <p className="profile-note">
            {isSelf
              ? "هذه ما جعلتَه مفتوحًا، فهو يُقرأ باسمك هنا. وما كان «بالرابط» أو «لك وحدك» فليس في هذه الصفحة."
              : "أبياتٌ اختارها ورتّبها ونشرها باسمه."}
          </p>
          <div className="diwans-grid dwgrid--profile">
            {albums.map((a, i) => (
              /* The foot says WHEN, never «جَمَعه فلان»: this page carries his
                 name at the top of it, and repeating it on every card is the
                 one line on a card that says nothing. */
              <DiwanCard key={a.code} album={a} index={i} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="profile-section" aria-labelledby="profile-arsenal">
        <h2 className="profile-section__title" id="profile-arsenal">
          الترسانة
        </h2>
        {arsenal ? (
          <>
            <ul className="arsenal-strip">
              {HIJAI_LETTERS.map((letter) => {
                const cell = arsenal.letters[letter]
                const mastered = cell?.mastered ?? 0
                const level = mastered === 0 ? 0 : mastered < 3 ? 1 : mastered < 8 ? 2 : 3
                return (
                  <li
                    className="arsenal-cell"
                    key={letter}
                    data-level={level}
                    title={`${LETTER_NAMES[letter]} — ${countedNounWithAdjective(mastered, BAYT_FORMS, MAHFUZ)}`}
                  >
                    <span className="arsenal-cell__letter">{letter}</span>
                    {/* a wall of zeros is noise; the dot holds the row's
                        rhythm without pretending to be a number */}
                    <span className="arsenal-cell__n num">{mastered > 0 ? formatNumber(mastered) : "·"}</span>
                  </li>
                )
              })}
            </ul>
            <p className="profile-note">آخر مزامنة: {dateLabel(arsenal.updatedAt)}</p>
          </>
        ) : (
          <Panel quiet className="profile-empty">
            <div className="profile-empty__text">
              <p className="profile-empty__line">لا ترسانة منشورة.</p>
              <p className="profile-empty__note">
                {isSelf
                  ? "ترسانتك محفوظة في متصفحك. انشرها هنا إن شئتَ أن تُرى — ولك أن تعيد نشرها متى شئت."
                  : "لم ينشر صاحب هذه الصفحة ترسانته."}
              </p>
            </div>
          </Panel>
        )}
        {isSelf ? (
          <div className="profile-actions">
            <button type="button" className="btn" onClick={() => void publish()} disabled={busy}>
              {arsenal ? "أعد مزامنة الترسانة" : "زامِن ترسانتي"}
            </button>
            <a className="btn btn--ghost" href={routeHash({ view: "train-arsenal" })}>
              افتح الترسانة
            </a>
          </div>
        ) : null}
      </section>

      {isSelf ? (
        <section className="profile-section" aria-labelledby="profile-blocks">
          <h2 className="profile-section__title" id="profile-blocks">
            المحظورون
          </h2>
          <BlockedList />
        </section>
      ) : null}

      {isSelf ? (
        <p className="profile-privacy-link">
          <a href={routeHash({ view: "privacy" })}>سياسة الخصوصية</a>
        </p>
      ) : null}
    </div>
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * «احذف حسابي» — the irreversible, self-serve account deletion Google Play
 * requires (and its web URL: this dialog lives on your own `#/u/<name>` page).
 *
 * It states PLAINLY that the act is permanent, lists exactly what is removed,
 * and demands the password again — the same re-confirmation the server verifies
 * with scrypt, so a walked-away session cannot erase the account. On success the
 * caller clears local auth and returns to a signed-out home; a wrong password
 * keeps the reader here with the reason. Modal mechanics mirror AuthDialog:
 * `aria-modal`, Escape closes, Tab is trapped, focus returns on close.
 */
function DeleteAccountDialog({
  username,
  onClose,
  onDeleted,
}: {
  username: string
  onClose: () => void
  onDeleted: () => void
}) {
  const deleteAccount = useAuth((s) => s.deleteAccount)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const firstFieldRef = useRef<HTMLInputElement | null>(null)

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
    firstFieldRef.current?.focus()
    return () => {
      window.removeEventListener("keydown", onKey)
      restore?.focus?.()
    }
  }, [onClose])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!password) {
      setError("اكتب كلمة السر لتأكيد الحذف")
      return
    }
    setBusy(true)
    setError(null)
    const res = await deleteAccount(password)
    if (res.ok) {
      onDeleted()
    } else {
      setBusy(false)
      setError(res.message)
    }
  }

  return (
    <Overlay role="dialog" aria-modal aria-label="حذف الحساب" onClick={onClose}>
      <div className="overlay__card auth auth--danger" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <PanelCorners size={16} />
        <header className="auth__head">
          <div className="auth__headings">
            <h2 className="auth__title">حذف الحساب</h2>
            <p className="auth__lede">
              هذا الإجراء لا رجعة فيه. سيُمحى حسابك «{username}» ولا يمكن استرجاعه.
            </p>
          </div>
          <button type="button" className="btn btn--ghost auth__close" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </header>

        <Rule className="auth__rule" />

        <ul className="delete-list">
          <li>اسمك وكلمة سرّك، وكل جلساتك على كل جهاز.</li>
          <li>صورتك، وترسانتك المنشورة، وسجلّ مساجلاتك.</li>
          <li>غرفك المفتوحة تُغلَق، ويفوز خصمك في أي مساجلة جارية.</li>
          <li>في المساجلات المنتهية يظهر اسمك عند خصمك «لاعبًا محذوفًا».</li>
        </ul>

        <form className="auth__form" onSubmit={submit} noValidate>
          <label className="auth-field">
            <span className="auth-field__label">كلمة السر للتأكيد</span>
            <input
              ref={firstFieldRef}
              className="auth-field__input"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              maxLength={200}
            />
          </label>

          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="auth__actions">
            <button type="submit" className="btn btn--danger auth__submit" disabled={busy}>
              {busy ? "لحظة…" : "احذف حسابي نهائيًا"}
            </button>
            <button type="button" className="btn btn--ghost auth__switch" onClick={onClose}>
              رجوع
            </button>
          </div>
        </form>
      </div>
    </Overlay>
  )
}

/**
 * «رمز الاستعادة» — regenerate the once-shown recovery code from settings.
 *
 * The signup code may be lost, and the server keeps only its hash, so there is
 * no «view» — only «issue a fresh one». This states plainly that a new code
 * RETIRES the old, generates it on the reader's word, then shows it once with a
 * copy button. Modal mechanics mirror the other dialogs: `aria-modal`, Escape
 * closes, Tab is trapped, focus returns on close.
 */
function RecoveryCodeDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const firstRef = useRef<HTMLButtonElement | null>(null)

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
    firstRef.current?.focus()
    return () => {
      window.removeEventListener("keydown", onKey)
      restore?.focus?.()
    }
  }, [onClose])

  const generate = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await regenerateRecovery()
      setCode(res.recoveryCode)
    } catch (e: unknown) {
      if (tookSessionExpiry(e)) {
        onClose()
        return
      }
      setError(e instanceof ApiError ? e.message : "تعذّر توليد الرمز")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay role="dialog" aria-modal aria-label="رمز الاستعادة" onClick={onClose}>
      <div className="overlay__card auth" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <PanelCorners size={16} />
        <header className="auth__head">
          <span className="auth__nib" aria-hidden="true">
            <Nib size={22} />
          </span>
          <div className="auth__headings">
            <h2 className="auth__title">رمز الاستعادة</h2>
            <p className="auth__lede">
              {code
                ? "هذا رمزك الجديد، ولن يظهر ثانيةً. احفظه في مأمن — به وحده تستعيد حسابك إن نسيتَ كلمة السر."
                : "لا بريد هنا، فرمز الاستعادة وحده يعيد إليك حسابك. وليس عند الخادم إلا بصمته لا الرمز نفسه، فإن ضاع منك فولِّد غيره — ويبطل القديم."}
            </p>
          </div>
          <button type="button" className="btn btn--ghost auth__close" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </header>

        <Rule className="auth__rule" />

        {code ? (
          <div className="auth__recovery">
            <RecoveryCodePanel
              code={code}
              headline="رمزك الجديد"
              note="اكتبه على ورق أو احفظه في مدير كلمات السر. القديم بطل الآن."
            />
            <div className="auth__actions">
              <button type="button" className="btn btn--primary auth__submit" onClick={onClose}>
                حفظتُه — تم
              </button>
            </div>
          </div>
        ) : (
          <>
            {error ? (
              <p className="auth__error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="auth__actions">
              <button
                ref={firstRef}
                type="button"
                className="btn btn--primary auth__submit"
                onClick={() => void generate()}
                disabled={busy}
              >
                {busy ? "لحظة…" : "ولِّد رمزًا جديدًا"}
              </button>
              <button type="button" className="btn btn--ghost auth__switch" onClick={onClose}>
                رجوع
              </button>
            </div>
          </>
        )}
      </div>
    </Overlay>
  )
}
