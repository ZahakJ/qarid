/**
 * «هذا الديوان يُلعب» — the three doors at the foot of a ديوان.
 *
 *   ساجِل في هذا الديوان   the machine recites ONLY from this shelf
 *   ضدّ صديق في هذا الديوان  a room where BOTH players answer from it
 *   أضِفه إلى التحفيظ        its أبيات become cards in your own deck
 *
 * ── WHY THE PANEL SAYS A NUMBER BEFORE IT SAYS ANYTHING ELSE ────────────────
 *
 * A shelf's count is not what a مساجلة can serve. 39.8 % of قصائد in the corpus
 * carry no بحر, and the game pool admits only those that do — so a thirty-بيت
 * ديوان is often a twelve-بيت مساجلة, and the two numbers have to be said in
 * the same breath or the door is promising something the game will not do.
 * Below `ALBUM_LIMITS.playableFloor` the two مساجلة doors are shut and say why:
 * a chain whose opponent concedes on the first turn is not a game, it is a
 * +500 button.
 *
 * ── THE ASYMMETRY, SAID OUT LOUD ────────────────────────────────────────────
 *
 * In the SOLO مساجلة the shelf binds the OPPONENT and not the player: he
 * recites from the ديوان, you answer from the whole 3.37-million-بيت corpus
 * under the ordinary strict rules. In the ROOM it binds both, because there the
 * ديوان is the thing being memorised and the contest is who holds more of it.
 * Two sentences, one on each button, because a reader who thinks the first is
 * the second will play it once and never again.
 *
 * ── التحفيظ IS LOCAL, AND STAYS LOCAL ───────────────────────────────────────
 *
 * The import writes CARDS into `qarid:v1:training`, in this browser, through
 * the same `introduce` the drill uses (`seedOf` is spelled once, in
 * schedule.ts, so a بيت imported here and the same بيت offered by the drill are
 * one card and not two). The ديوان is the SOURCE; the deck is the reader's, and
 * nothing about it goes to the server. The toast says the honest split —
 * «أُضيف 24 بيتًا، و6 أبيات عندك من قبل» — and the promise ends there: the درب reminds
 * through the ordinary due-cards flow, and nothing here says a word about a
 * notification.
 */
import { useEffect, useState } from "react"

import { ALBUM_LIMITS, type AlbumEntry, type AlbumSummary, type ChainMode } from "../../shared/schema.ts"
import { BAYT_FORMS, countedNounGenitive, formatPlayableBaits, formatNumber } from "../../shared/format.ts"
import { ApiError } from "../api/client.ts"
import { getAlbumPool } from "../api/queries.ts"
import { Segmented } from "../components/Segmented.tsx"
import { PanelCorners } from "../components/Ornaments.tsx"
import { configFor } from "../duel/tiers.ts"
import { navigate } from "../router.ts"
import { startDuel } from "../store/duelStore.ts"
import { useAuth, tookSessionExpiry } from "../store/authStore.ts"
import { createRoom } from "../store/roomStore.ts"
import { toast } from "../store/toastStore.ts"
import { useTraining } from "../store/trainingStore.ts"
import { importedMessage, memorizeSeeds } from "./memorize.ts"
import { AlbumModal } from "./Modal.tsx"
import { ROOM_STRIKES_DEFAULT, ROOM_TIMERS } from "../../shared/schema.ts"

type Pool = { playable: number; baitIds: number[] } | null

export function DiwanPlay({ album, entries }: { album: AlbumSummary; entries: readonly AlbumEntry[] }) {
  const [pool, setPool] = useState<Pool>(null)
  const [failed, setFailed] = useState(false)
  const [friend, setFriend] = useState(false)
  const user = useAuth((s) => s.user)
  const openAuth = useAuth((s) => s.openDialog)
  const introduce = useTraining((s) => s.introduce)
  const reload = useTraining((s) => s.reload)

  // The pool is asked for ONCE per shelf. It is the same request the duel will
  // carry on every turn, so asking early is also what makes the door honest
  // before it is pressed.
  useEffect(() => {
    const ac = new AbortController()
    setPool(null)
    setFailed(false)
    getAlbumPool(album.code, { signal: ac.signal })
      .then((res) => {
        if (ac.signal.aborted) return
        setPool({ playable: res.playable, baitIds: res.baitIds })
      })
      .catch(() => {
        if (!ac.signal.aborted) setFailed(true)
      })
    return () => ac.abort()
  }, [album.code, album.updatedAt])

  const live = entries.filter((e) => e.bait !== null)
  const ready = pool !== null && pool.playable >= ALBUM_LIMITS.playableFloor

  const solo = () => {
    if (!pool || !ready) return
    startDuel(
      configFor("sword", {
        timer: true,
        format: "endless",
        chainMode: "rhyme",
        filters: {},
        // رتبة سيف and no «قيود»: inside a shelf the رتبة would only shrink a
        // pool that is already thirty أبيات wide, and «فحل» (fame ≤ 2) is
        // exactly zero over a shelf of famous شعراء. The ديوان IS the قيد.
        album: { code: album.code, title: album.title, baitIds: pool.baitIds },
      }),
    )
    navigate({ view: "duel-play" })
  }

  const memorize = () => {
    // `reload()` FIRST, always: a مساجلة finished in this tab (or another one)
    // writes the same slice, and every train surface re-reads before it writes
    // — the two-writers invariant (client/store/trainingStore.ts).
    reload()
    const seeds = memorizeSeeds(entries)
    const made = introduce(seeds)
    const already = seeds.length - made.length
    toast(importedMessage(made.length, already), made.length > 0 ? "ok" : "info")
  }

  return (
    <section className="dwplay" aria-labelledby="dwplay-title">
      <PanelCorners size={14} />
      <h2 className="dwplay__title" id="dwplay-title">
        هذا الديوان يُلعب ويُحفظ
      </h2>

      <p className="dwplay__count">
        {failed ? (
          "تعذّر معرفة ما يصلح منه للمساجلة"
        ) : pool === null ? (
          "…يُحصى ما يصلح للمساجلة"
        ) : (
          <>
            فيه {formatPlayableBaits(pool.playable)}
            {/* «من» is a حرف جرّ and المثنى is مجرور after it: a two-بيت shelf
                with one playable بيت read «من بيتان». */}
            {pool.playable < album.count ? (
              <span className="dwplay__of"> من {countedNounGenitive(album.count, BAYT_FORMS)}</span>
            ) : null}
          </>
        )}
      </p>

      {pool !== null && !ready ? (
        <p className="dwplay__floor">
          يحتاج {formatPlayableBaits(ALBUM_LIMITS.playableFloor)}. ما لا بحر له من الأبيات لا يُنشده الخصم،
          فأضِف إليه حتى يبلغها.
        </p>
      ) : null}

      <div className="dwplay__acts">
        <button type="button" className="btn btn--primary" onClick={solo} disabled={!ready}>
          ساجِل في هذا الديوان
        </button>
        <button
          type="button"
          className="btn"
          disabled={!ready}
          onClick={() => (user ? setFriend(true) : openAuth("login"))}
        >
          ضدّ صديق في هذا الديوان
        </button>
        {/* Not a `--ghost`: its gold text made the QUIETEST of the three doors
            the loudest thing in the panel, and gold in this app is
            illumination, not emphasis-by-default. */}
        <button type="button" className="btn" onClick={memorize} disabled={live.length === 0}>
          أضِفه إلى التحفيظ
        </button>
      </div>

      <p className="dwplay__note">
        في المساجلة وحدك: الخصم لا يُنشد إلا من هذا الديوان، وأنت تُجيب من الديوان كلّه. وفي الغرفة: كلاكما
        يُجيب منه، وهي مذاكرةٌ بينكما لا مباراة على المتن كلّه.
      </p>

      {friend ? <DiwanRoomDialog album={album} onClose={() => setFriend(false)} /> : null}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// «ضدّ صديق في هذا الديوان»
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * The room's three rules, and NOT its مطلع picker.
 *
 * «ضدّ صديق» on the setup screen gives the whole top of its dialog to choosing
 * the opening بيت, because there the choice is the gesture. Here the shelf has
 * already made it: the server draws the مطلع from the ديوان itself, which is
 * also the only way it can guarantee the guest an answerable opening. So this
 * surface is three rows and a sentence.
 */
function DiwanRoomDialog({ album, onClose }: { album: AlbumSummary; onClose: () => void }) {
  const [mode, setMode] = useState<ChainMode>("rhyme")
  const [timer, setTimer] = useState<TimerChoice>("60")
  const [strikes, setStrikes] = useState(String(ROOM_STRIKES_DEFAULT))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const state = await createRoom({
        albumCode: album.code,
        mode,
        ...(timer === "off" ? {} : { timerS: Number(timer) as 30 | 60 | 90 }),
        strikes: Number(strikes),
      })
      onClose()
      navigate(state.joinKey ? { view: "room", code: state.code, key: state.joinKey } : { view: "room", code: state.code })
    } catch (err) {
      setBusy(false)
      // A dead session closes this surface and opens دخول with its reason on
      // it — FriendMatch's rule, and for the same reason.
      if (tookSessionExpiry(err)) {
        onClose()
        return
      }
      setError(err instanceof ApiError ? err.message : "تعذّر فتح الغرفة")
    }
  }

  return (
    <AlbumModal
      title={`ساجِلا في «${album.title}»`}
      note="المطلع من الديوان، والجواب منه. من خرج عنه قيل له: ليس من هذا الديوان — ولا تُحتسب عليه."
      onClose={onClose}
      className="dwmodal--play"
      footer={
        <>
          <button type="button" className="btn btn--primary" onClick={() => void create()} disabled={busy}>
            افتح الغرفة
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            رجوع
          </button>
        </>
      }
    >
      <div className="dwplay__rules">
        <div className="dwplay__rule">
          <span className="dwplay__rulename">السلسلة</span>
          <Segmented label="قاعدة السلسلة" value={mode} onChange={setMode} options={CHAIN_OPTIONS} />
        </div>
        <div className="dwplay__rule">
          <span className="dwplay__rulename">الوقت</span>
          <Segmented label="وقت الدور" value={timer} onChange={setTimer} options={TIMER_OPTIONS} />
        </div>
        <div className="dwplay__rule">
          <span className="dwplay__rulename">الضربات</span>
          <Segmented label="عدد الضربات" value={strikes} onChange={setStrikes} options={STRIKE_OPTIONS} />
        </div>
        {error ? (
          <p className="dwplay__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </AlbumModal>
  )
}
