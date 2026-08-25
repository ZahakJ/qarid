/**
 * `#/u/<username>` — a page with your name on it (v2.md §4).
 *
 * What it shows, and why in this order: WHO (the نِيب disc, the display name in
 * Aref Ruqaa, the day you joined), then the مساجلة record — which is the whole
 * reason accounts exist — then the أبيات you have recited against a human, then
 * the ترسانة you chose to publish.
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
import { useEffect, useState } from "react"
import { ApiError } from "../api/client.ts"
import { getProfile, syncArsenal, updateProfile } from "../api/queries.ts"
import { EmptyState } from "../components/EmptyState.tsx"
import { Nib, Rule } from "../components/Ornaments.tsx"
import { Panel } from "../components/Panel.tsx"
import { routeHash } from "../router.ts"
import { initialOf, useAuth } from "../store/authStore.ts"
import { toast } from "../store/toastStore.ts"
import { trainingSlice, useTraining } from "../store/trainingStore.ts"
import {
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

/** Gregorian months in Arabic. `Intl` would give Arabic-Indic digits. */
const MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
]

/**
 * «24 أغسطس 2026». The YEAR is `String(...)`, never `formatNumber` — that one
 * groups thousands and would print «2,026».
 */
function dateLabel(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return "—"
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""} ${d.getFullYear()}`
}

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
  const setUser = useAuth((s) => s.setUser)
  const signOut = useAuth((s) => s.signOut)
  // `qarid:v1:training` has two writers, so every training-aware view reloads
  // on mount (CLAUDE.md) — otherwise «زامِن» could publish a stale ترسانة.
  const reload = useTraining((s) => s.reload)

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

  const { user, stats, recent, arsenal, isSelf } = page

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
        <span className="profile-hero__disc" aria-hidden="true">
          <span className="profile-hero__initial">{initialOf(user.displayName)}</span>
          <span className="profile-hero__nib">
            <Nib size={14} />
          </span>
        </span>

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
            <button type="button" className="btn btn--ghost" onClick={() => void signOut()}>
              اخرج
            </button>
          </div>
        ) : null}
      </header>

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
                <span className="match-row__foe">{m.opponent ?? "بانتظار خصم"}</span>
                {/* «3 أبيات», never a bare «3» — a digit standing alone in a
                    ledger row names nothing (CLAUDE.md, العدد والمعدود). */}
                <span className="match-row__turns num">{countedNoun(m.turns, BAYT_FORMS)}</span>
                <span className="match-row__when">{dateLabel(m.endedAt ?? m.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

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
    </div>
  )
}
