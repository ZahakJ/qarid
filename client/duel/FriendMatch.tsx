/**
 * «ضد صديق» — opening a 1v1 مساجلة room from the duel setup screen (v2.md §5).
 *
 * The host makes four decisions and one of them is the interesting one: WHICH
 * بيت opens the مساجلة. That is not a setting, it is a gesture — you choose the
 * بيت you want to hear answered — so it gets the whole top of the dialog: a
 * search field over the ديوان (the same `/api/search` the palette runs, scoped
 * to أبيات) and a «عشوائي» button that asks the server for one from a شاعر it
 * considers known (fame ≥ 2). The chosen بيت is shown as a plate, exactly as it
 * will appear in the room, before anything is created.
 *
 * The other three are the room's rules, and each says what it costs in words:
 * الرويّ vs الحرف الأخير, the clock, and how many misses end it.
 *
 * Everything here refuses to pretend: with no account the dialog is one line
 * and one button, because a room needs two named people and there is no way to
 * make that softer without lying about it.
 */
import { useEffect, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { getRoomOpening, getRoomPlayable, search } from "../api/queries.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { navigate } from "../router.ts"
import { useAuth } from "../store/authStore.ts"
import { createRoom } from "../store/roomStore.ts"
import { ROOM_STRIKES_DEFAULT, ROOM_TIMERS, type BaitDto, type ChainMode } from "../../shared/schema.ts"
import { formatNumber } from "../../shared/format.ts"

/** The debounce the palette uses; the same field, the same server. */
const SEARCH_MS = 220

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

export function FriendMatch() {
  const [open, setOpen] = useState(false)
  const user = useAuth((s) => s.user)
  const authStatus = useAuth((s) => s.status)
  const available = useAuth((s) => s.available)
  const openAuth = useAuth((s) => s.openDialog)

  if (authStatus === "ready" && !available) return null

  return (
    <section className="setup-sect setup-sect--friend" aria-labelledby="setup-friend">
      <h2 className="setup-sect__title" id="setup-friend">
        ضدّ صديق
      </h2>
      <p className="setup-sect__lede">
        غرفةٌ لاثنين: تختار المطلع، ويصلك رمزٌ ورابط تبعثه إلى صاحبك. تُجيبان بيتًا ببيت، والديوان بينكما حَكَم.
      </p>
      <div className="friend-cta">
        {user ? (
          <button type="button" className="btn btn--primary btn--lg" onClick={() => setOpen(true)}>
            افتح غرفة
          </button>
        ) : (
          <button type="button" className="btn btn--primary btn--lg" onClick={() => openAuth("login")}>
            ادخل بحسابك لتفتح غرفة
          </button>
        )}
        <span className="friend-cta__note">
          {user ? "تبدأ المساجلة لحظة دخول صاحبك، وهو الذي يُجيب أوّلًا." : "المساجلة بين اثنين، فلا بدّ أن يُعرف كلٌّ منكما باسمه."}
        </span>
      </div>
      {open ? <FriendDialog onClose={() => setOpen(false)} /> : null}
    </section>
  )
}

function FriendDialog({ onClose }: { onClose: () => void }) {
  const [bait, setBait] = useState<BaitDto | null>(null)
  const [q, setQ] = useState("")
  const [hits, setHits] = useState<BaitDto[]>([])
  const [searching, setSearching] = useState(false)
  const [mode, setMode] = useState<ChainMode>("rhyme")
  const [timer, setTimer] = useState<TimerChoice>("60")
  const [strikes, setStrikes] = useState(String(ROOM_STRIKES_DEFAULT))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Escape closes, exactly as it does over the palette and the auth dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  // The بيت search: debounced, aborted on every keystroke, أبيات only.
  useEffect(() => {
    const needle = q.trim()
    if (needle.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    const ac = new AbortController()
    setSearching(true)
    const t = setTimeout(() => {
      search({ q: needle, scope: "baits", limit: 8 }, { signal: ac.signal })
        .then(async (res) => {
          if (ac.signal.aborted) return
          // Only أبيات the مساجلة can actually be built on: half the ديوان is
          // outside the game pool (no عجز, or a قصيدة the pool drops), and
          // offering one of those would be a refusal three clicks later.
          const playable = await getRoomPlayable(
            res.baits.map((b) => b.id),
            { signal: ac.signal },
          )
          if (ac.signal.aborted) return
          const allowed = new Set(playable.ids)
          setHits(res.baits.filter((b) => allowed.has(b.id)).slice(0, 5))
          setSearching(false)
        })
        .catch(() => {
          if (!ac.signal.aborted) setSearching(false)
        })
    }, SEARCH_MS)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [q])

  const rollRandom = async () => {
    setError(null)
    try {
      // The server's own picker, so what the host is shown is exactly what he
      // would have been given: the شاعر tier, fame ≥ 2, and always a بيت the
      // game pool can chain on (v2.md §5).
      const found = await getRoomOpening()
      setBait(found.bait)
      setHits([])
      setQ("")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر اختيار بيت")
    }
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const state = await createRoom({
        ...(bait ? { baitId: bait.id } : {}),
        mode,
        ...(timer === "off" ? {} : { timerS: Number(timer) as 30 | 60 | 90 }),
        strikes: Number(strikes),
      })
      onClose()
      navigate({ view: "room", code: state.code })
    } catch (err) {
      setBusy(false)
      setError(err instanceof ApiError ? err.message : "تعذّر فتح الغرفة")
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="overlay__card friend-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="friend-title"
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="friend-dialog__head">
          <h2 className="friend-dialog__title" id="friend-title">
            غرفة مساجلة
          </h2>
          <button type="button" className="btn btn--ghost friend-dialog__close" onClick={onClose} aria-label="أغلق">
            ✕
          </button>
        </header>

        <div className="friend-dialog__body">
          <section className="friend-sect">
            <h3 className="friend-sect__title">المطلع</h3>
            <p className="friend-sect__lede">
              البيت الذي تُنشده أنت، ويُجيب عنه صاحبك. اتركه لنا وسنختار من مشاهير الأبيات.
            </p>

            {bait ? (
              <div className="friend-pick">
                <BaytPlate variant="plate" size="sm" sadr={bait.sadr} ajuz={bait.ajuz} side="you" />
                <div className="friend-pick__meta">
                  {bait.poet ? <span className="friend-pick__poet">{bait.poet.name}</span> : null}
                  <button type="button" className="btn btn--ghost" onClick={() => setBait(null)}>
                    غيّره
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="friend-search">
                  <input
                    className="friend-search__input"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="ابحث عن بيت في الديوان…"
                    dir="rtl"
                    lang="ar"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="ابحث عن مطلع"
                  />
                  <button type="button" className="btn" onClick={() => void rollRandom()}>
                    عشوائي
                  </button>
                </div>
                {searching ? <p className="friend-search__state">…يبحث</p> : null}
                {hits.length > 0 ? (
                  <ul className="friend-hits">
                    {hits.map((hit) => (
                      <li key={hit.id}>
                        <button type="button" className="friend-hit" onClick={() => setBait(hit)}>
                          <BaytPlate variant="plate" size="sm" sadr={hit.sadr} ajuz={hit.ajuz} />
                          {hit.poet ? <span className="friend-hit__poet">{hit.poet.name}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!searching && q.trim().length >= 2 && hits.length === 0 ? (
                  <p className="friend-search__state">
                    لا بيت يصلح مطلعًا بهذه الكلمات — لعلّ ما وجدناه ناقصُ العجز. جرّب كلمةً أخرى، أو خُذ واحدًا
                    عشوائيًّا.
                  </p>
                ) : null}
              </>
            )}
          </section>

          <section className="friend-sect">
            <h3 className="friend-sect__title">القاعدة</h3>
            <div className="friend-row">
              <span className="friend-row__label">السلسلة</span>
              <Segmented label="قاعدة السلسلة" value={mode} onChange={setMode} options={CHAIN_OPTIONS} />
            </div>
            <p className="friend-row__note">
              {mode === "rhyme"
                ? "تُقشَر ألفُ الإطلاق وواوُه وياؤه وهاءُ الضمير، ويبقى الرويّ — وهي قاعدة المساجلة القديمة."
                : "آخر حرفٍ في العجز كما كُتب، بلا قشرٍ ولا تأويل — أصعب، وأوضح."}
            </p>

            <div className="friend-row">
              <span className="friend-row__label">الوقت للبيت</span>
              <Segmented label="الوقت" value={timer} onChange={setTimer} options={TIMER_OPTIONS} />
            </div>
            <p className="friend-row__note">
              {timer === "off"
                ? "بلا مهلة: لا ينتهي الدور إلا ببيت — أو بانسحاب."
                : `من انقضت مهلته خسر المساجلة. ${formatNumber(Number(timer))} ثانية لكل بيت، والخادم هو الحَكَم في الوقت.`}
            </p>

            <div className="friend-row">
              <span className="friend-row__label">الضربات</span>
              <Segmented label="الضربات" value={strikes} onChange={setStrikes} options={STRIKE_OPTIONS} />
            </div>
            <p className="friend-row__note">
              كم مرّةً يُخطئ اللاعب قبل أن يخسر: بيتٌ ليس في الديوان، أو بيتٌ على غير الحرف المطلوب. وما عدا ذلك — بيتٌ
              قيل من قبل، أو نصف بيت — لا يُحتسب.
            </p>
          </section>

          {error ? (
            <p className="friend-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="friend-dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            رجوع
          </button>
          <button type="button" className="btn btn--primary btn--lg" onClick={() => void create()} disabled={busy}>
            {busy ? "…تُفتح الغرفة" : "افتح الغرفة"}
          </button>
        </footer>
      </div>
    </div>
  )
}
