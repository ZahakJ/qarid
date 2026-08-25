/**
 * `#/room/<code>` — a مساجلة against a person (v2.md §5).
 *
 * The screen is the duel's, rebuilt around the one thing that is different:
 * there are two people in it. So the HUD is not lives-and-score but two seats
 * side by side — name, نِيب strikes, أبيات said, whether the socket is live —
 * with the gold turn marker on whoever owes a بيت. Everything below it is the
 * play screen the reader already knows: the same transcript plates, the same
 * `LetterIndicator` with the timer arc around the required letter, the same
 * `AnswerInput` (صدر alone still works), the same `RejectionCard`.
 *
 * FOUR STATES, and each says what to do next rather than what it is:
 *   • في الانتظار — the code, big, with the link to hand over. A visitor who is
 *     not the host sees «ادخل المساجلة» instead.
 *   • جارية — the play screen. Only the seat that owes a بيت has a live field;
 *     the other side is told, in words, whose turn it is.
 *   • انتهت — who won and why, «رجعة» (which swaps the seats), and the way back.
 *   • مشاهدة — a spectator gets all of it except the field.
 *
 * NOTHING here decides anything about the game. Whose turn, which letter, how
 * many strikes are left, how long is left: all of it is read off the snapshot
 * (`client/store/roomStore.ts`). The one number this file computes is the
 * countdown, and it computes it from the server's deadline and the server's
 * clock offset.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { Chip } from "../components/Chip.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { Nib, Rule } from "../components/Ornaments.tsx"
import { Panel } from "../components/Panel.tsx"
import { AnswerInput } from "../duel/AnswerInput.tsx"
import { LetterIndicator } from "../duel/LetterIndicator.tsx"
import { RejectionCard } from "../duel/RejectionCard.tsx"
import { navigate, routeHash } from "../router.ts"
import { initialOf, useAuth } from "../store/authStore.ts"
import { rematchIsNew as isNewRematch, roomTimeLeft, useRoom } from "../store/roomStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { BAYT_FORMS, DARBA_FORMS, copyableBayt, countedNoun, formatClock, formatNumber } from "../../shared/format.ts"
import type { RoomPlayer, RoomSeat, RoomState, RoomTurn } from "../../shared/schema.ts"

/** How often the countdown redraws. The remaining time itself is read live. */
const TICK_MS = 200

const MODE_LABEL = { rhyme: "على الرويّ", literal: "على الحرف الأخير" } as const

/**
 * WHY it ended, said about the player it happened to.
 *
 * The first pass printed the reason and then the WINNER's name («انسحاب —
 * لبيد»), which reads as if the winner resigned. A reason is always something
 * one side did, so it is written as a sentence about that side.
 */
function endReasonLine(reason: string | null, loser: string | null): string {
  const who = loser ?? "خصمك"
  switch (reason) {
    case "strikes":
      return `نفدت ضربات ${who}`
    case "timeout":
      return `انقضى وقت ${who}`
    case "resign":
      return `انسحب ${who}`
    default:
      return "توقّفت المساجلة"
  }
}

/** A username off the wire → the name the rest of the screen calls that player. */
function displayNameOf(state: RoomState, username: string | null): string | null {
  if (username === null) return null
  if (state.host?.username === username) return state.host.displayName
  if (state.guest?.username === username) return state.guest.displayName
  return username
}

/** «BADIRU» — one letter per cell, so a code read aloud is read correctly. */
function CodeBlock({ code }: { code: string }) {
  return (
    <p className="room-code" dir="ltr" aria-label={`رمز الغرفة ${code.split("").join(" ")}`}>
      {code.split("").map((ch, i) => (
        <span className="room-code__ch" key={`${ch}${i}`}>
          {ch}
        </span>
      ))}
    </p>
  )
}

/** One seat. The نِيب row is the strike budget: a spent strike dims, never goes. */
function Seat({
  player,
  seat,
  strikes,
  active,
  you,
}: {
  player: RoomPlayer | null
  seat: RoomSeat
  strikes: number
  active: boolean
  you: boolean
}) {
  const label = seat === "host" ? "صاحب المطلع" : "المجيب"
  if (!player) {
    return (
      <div className="seat seat--empty" data-seat={seat}>
        <span className="seat__disc seat__disc--empty" aria-hidden="true">
          ؟
        </span>
        <span className="seat__name">بانتظار خصم</span>
        <span className="seat__role">{label}</span>
      </div>
    )
  }
  const left = Math.max(0, strikes - player.strikes)
  return (
    <div className="seat" data-seat={seat} data-active={active ? "1" : undefined} data-you={you ? "1" : undefined}>
      <a className="seat__disc" href={routeHash({ view: "profile", username: player.username })} aria-hidden="true">
        {initialOf(player.displayName)}
      </a>
      <a className="seat__name" href={routeHash({ view: "profile", username: player.username })}>
        {player.displayName}
      </a>
      <span className="seat__role">
        {label}
        {you ? " — أنت" : ""}
      </span>
      <span
        className="seat__strikes"
        role="img"
        aria-label={`بقيت له ${countedNoun(left, DARBA_FORMS)} من ${formatNumber(strikes)}`}
      >
        {Array.from({ length: strikes }, (_, i) => (
          <span className="seat__nib" key={i} data-spent={i >= left ? "1" : undefined}>
            <Nib size={16} />
          </span>
        ))}
      </span>
      <span className="seat__turns">{countedNoun(player.turns, BAYT_FORMS)}</span>
      <span className="seat__live" data-on={player.connected ? "1" : undefined} title={player.connected ? "متّصل" : "غير متّصل"} />
    </div>
  )
}

/**
 * The transcript. Every بيت is a `BaytPlate` on the duel's own `.exchange`
 * furniture — same lapis hairline for the other side, same gold for yours — and
 * a strike is a line of its own, because a مساجلة where the misses are
 * invisible reads as if the clock simply skipped a turn.
 */
function RoomLog({ state, mySeat, tashkeel, showRawiyy }: { state: RoomState; mySeat: RoomSeat | null; tashkeel: boolean; showRawiyy: boolean }) {
  const lens: RoomSeat = mySeat ?? "guest"
  return (
    <ol className="exchange-log room-log" data-variant="summary">
      {state.turns.map((turn: RoomTurn) => {
        const mine = turn.seat === lens
        const who = turn.seat === "host" ? state.host : state.guest
        const name = who?.displayName ?? "لاعب"
        if (turn.bait === null) {
          return (
            <li className="exchange room-miss" key={turn.turnNo} data-side={mine ? "player" : "opponent"}>
              <p className="room-miss__line">
                <span className="room-miss__who">{name}</span>
                <span className="room-miss__what">
                  {turn.verdict === "wrong_letter" ? "أجاب بغير الحرف المطلوب" : "لم أجد بيته في الديوان"}
                </span>
                <span className="room-miss__mark" aria-hidden="true">
                  ✗
                </span>
              </p>
              {turn.text ? <p className="room-miss__text">{turn.text}</p> : null}
            </li>
          )
        }
        // TWO names belong on this line — who recited it and who wrote it — and
        // set side by side they were indistinguishable («لبيد بن ربيعة  أمين
        // تقي الدين»). The لام of attribution is how Arabic has always told
        // them apart: «أنشده لبيد» · «لأمين تقي الدين».
        const meta = (
          <>
            <span className="exchange__who">{name}</span>
            {turn.verdict === "opening" ? <span className="room-opening">المطلع</span> : null}
            {turn.bait.poet ? (
              <a className="exchange__poet" href={routeHash({ view: "poet", slug: turn.bait.poet.slug })}>
                لـ<bdi>{turn.bait.poet.name}</bdi>
              </a>
            ) : null}
            {turn.bait.meter ? <Chip variant="bahr" slug={turn.bait.meter.slug} label={turn.bait.meter.name} /> : null}
            <a className="exchange__link" href={routeHash({ view: "poem", id: turn.bait.poem.id })}>
              القصيدة
            </a>
          </>
        )
        return (
          <li className="exchange" key={turn.turnNo} data-side={mine ? "player" : "opponent"} data-exchange-key={turn.bait.baytKey}>
            <BaytPlate
              variant="plate"
              sadr={turn.bait.sadr}
              ajuz={turn.bait.ajuz}
              side={mine ? "you" : "them"}
              meta={meta}
              tashkeel={tashkeel}
              showRawiyy={showRawiyy}
              rawiyy={turn.bait.rawiyy}
              copyText={copyableBayt(turn.bait.sadr, turn.bait.ajuz)}
            />
          </li>
        )
      })}
    </ol>
  )
}

export function RoomView({ code, joinKey }: { code: string; joinKey?: string }) {
  const state = useRoom((s) => s.state)
  const error = useRoom((s) => s.error)
  const errorCode = useRoom((s) => s.errorCode)
  const notice = useRoom((s) => s.notice)
  const loading = useRoom((s) => s.loading)
  const busy = useRoom((s) => s.busy)
  const draft = useRoom((s) => s.draft)
  const rejection = useRoom((s) => s.rejection)
  const strikesLeft = useRoom((s) => s.strikesLeft)
  const transport = useRoom((s) => s.transport)
  const skew = useRoom((s) => s.skew)
  const open = useRoom((s) => s.open)
  const close = useRoom((s) => s.close)
  const setDraft = useRoom((s) => s.setDraft)
  const submit = useRoom((s) => s.submit)
  const join = useRoom((s) => s.join)
  const resign = useRoom((s) => s.resign)
  const rematch = useRoom((s) => s.rematch)
  const dismissRejection = useRoom((s) => s.dismissRejection)

  const settings = useSettings()
  const authStatus = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const openAuth = useAuth((s) => s.openDialog)
  const [, tock] = useReducer((n: number) => n + 1, 0)
  const [precheck, setPrecheck] = useState<string | null>(null)

  useEffect(() => {
    if (authStatus !== "ready" || !user) return
    open(code, joinKey ?? null)
    return () => close()
  }, [code, joinKey, authStatus, user, open, close])

  // The countdown redraws on a tick; the time itself is read at render off the
  // server's deadline, so a slow frame can never show more time than is left.
  const running = state?.status === "active" && state.deadlineAt !== null
  useEffect(() => {
    if (!running) return
    const id = setInterval(tock, TICK_MS)
    return () => clearInterval(id)
  }, [running])

  const msLeft = roomTimeLeft(state ?? null, skew)
  const turnMs = (state?.timerS ?? 0) * 1000

  /**
   * A رجعة that OPENS while you are looking at the room is somewhere to go.
   * One that was already there is just history.
   *
   * `rooms.rematch_code` is permanent once written and rides on every later
   * snapshot of the old room, so redirecting on its mere presence bounced every
   * viewer — a spectator included — out of any old room they opened. From the
   * profile's match list that chained: match 1 → 2 → 3 → the newest room, 900 ms
   * apart, and no older transcript was reachable through the UI at all. So the
   * code seen on the FIRST snapshot is remembered and only a NEW one navigates;
   * for the rest there is a link, below.
   */
  const rematchCode = state?.rematchCode ?? null
  const rematchAtMount = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (state === null) return
    if (rematchAtMount.current === undefined) rematchAtMount.current = rematchCode
  }, [state, rematchCode])
  const rematchIsNew = isNewRematch(rematchAtMount.current, rematchCode)
  useEffect(() => {
    if (!rematchIsNew || !rematchCode) return
    const t = setTimeout(() => navigate({ view: "room", code: rematchCode }), 900)
    return () => clearTimeout(t)
  }, [rematchIsNew, rematchCode])

  const shareLink = useMemo(() => state?.shareUrl ?? "", [state])

  const copyLink = async () => {
    if (!shareLink) return
    try {
      await navigator.clipboard.writeText(shareLink)
      toast("نُسخ الرابط", "ok")
    } catch {
      toast("تعذّر النسخ — انسخ الرابط من شريط العنوان", "warn")
    }
  }

  // ── the two doors before the room ────────────────────────────────────────

  if (authStatus !== "ready") return <div className="view room-view" aria-busy="true" />

  if (!user) {
    return (
      <div className="view room-view">
        <div className="view__head">
          <h1 className="view__title">مساجلة الأصدقاء</h1>
          <p className="view__lede">مساجلة بين اثنين، بيتًا ببيت، على رويّ واحد.</p>
        </div>
        <Rule />
        <Panel quiet className="room-gate">
          <div className="room-gate__text">
            <p className="room-gate__line">هذه الغرفة تحتاج إلى حساب.</p>
            <p className="room-gate__note">
              المساجلة بين اثنين، فلا بدّ أن يُعرف كلٌّ منكما باسمه. الدخول لحظة، والاسم يبقى لك.
            </p>
          </div>
          <button type="button" className="btn btn--primary btn--lg" onClick={() => openAuth("login")}>
            ادخل بحسابك
          </button>
        </Panel>
      </div>
    )
  }

  if (error) {
    // A room you were not invited into is not a room that does not exist, and
    // saying so is the difference between «you mistyped» and «ask for the
    // link»: the code names the room, the link opens it (v2.md §5).
    const locked = errorCode === "needs_key"
    return (
      <div className="view room-view">
        <div className="view__head">
          <h1 className="view__title">مساجلة الأصدقاء</h1>
        </div>
        <EmptyState flavor="search-none" title={locked ? "هذه الغرفة بدعوة" : "لا غرفة بهذا الرمز"}>
          <p className="empty__note">{error}</p>
          {locked ? <p className="empty__note">الرمز يدلّ على الغرفة، والرابط هو الذي يفتحها.</p> : null}
          <a className="btn" href={routeHash({ view: "duel" })}>
            افتح غرفة جديدة
          </a>
        </EmptyState>
      </div>
    )
  }

  if (!state || loading) {
    return (
      <div className="view room-view" aria-busy="true">
        <div className="view__head">
          <h1 className="view__title">مساجلة الأصدقاء</h1>
        </div>
        <span className="skeleton" style={{ blockSize: "6rem" }} />
        <span className="skeleton" style={{ blockSize: "12rem" }} />
      </div>
    )
  }

  const mySeat = state.you.seat
  const spectating = state.you.role === "spectator"
  const myTurn = state.you.canPlay
  const waitingSeat = state.turnSeat === "host" ? state.host : state.guest
  const won = state.winner !== null && state.winner === user.username
  const winnerName = displayNameOf(state, state.winner)
  const loserName =
    state.winner === null
      ? null
      : displayNameOf(state, state.host?.username === state.winner ? (state.guest?.username ?? null) : (state.host?.username ?? null))

  return (
    <div className="view room-view" data-status={state.status}>
      <header className="view__head room-head">
        <div className="room-head__id">
          <h1 className="view__title">مساجلة الأصدقاء</h1>
          <p className="room-head__chips">
            <span className="room-chip">{MODE_LABEL[state.mode]}</span>
            <span className="room-chip">
              {state.timerS === null ? "بلا وقت" : `${formatNumber(state.timerS)} ثانية للبيت`}
            </span>
            <span className="room-chip">{countedNoun(state.strikes, DARBA_FORMS)}</span>
            <span className="room-chip room-chip--live" data-transport={transport}>
              {transport === "socket" ? "متّصل" : "يُحدَّث كل ثانيتين"}
            </span>
          </p>
        </div>
        <div className="room-head__code">
          <span className="room-head__code-label">رمز الغرفة</span>
          <CodeBlock code={state.code} />
        </div>
      </header>

      <Rule />

      <div className="room-seats">
        <Seat
          player={state.host}
          seat="host"
          strikes={state.strikes}
          active={state.turnSeat === "host"}
          you={mySeat === "host"}
        />
        <span className="room-seats__vs" aria-hidden="true">
          ×
        </span>
        <Seat
          player={state.guest}
          seat="guest"
          strikes={state.strikes}
          active={state.turnSeat === "guest"}
          you={mySeat === "guest"}
        />
      </div>

      {/* ── في الانتظار ────────────────────────────────────────────────── */}
      {state.status === "waiting" ? (
        <Panel illuminated className="room-wait">
          {state.you.canJoin ? (
            <>
              <p className="room-wait__line">دُعيتَ إلى مساجلة.</p>
              <p className="room-wait__note">
                يُنشد صاحبُ الغرفة المطلع، وأنت تُجيب أوّلًا ببيتٍ يبدأ بحرف رويّه. ادخل حين تكون مستعدًّا — الوقت
                يبدأ بدخولك.
              </p>
              <button type="button" className="btn btn--primary btn--lg" onClick={() => void join()} disabled={busy}>
                ادخل المساجلة
              </button>
            </>
          ) : mySeat === "host" ? (
            <>
              <p className="room-wait__line">غرفتك مفتوحة — ابعث الرابط إلى صاحبك.</p>
              <p className="room-wait__note">تبدأ المساجلة لحظة دخوله، وهو الذي يُجيب أوّلًا عن مطلعك.</p>
              <div className="room-share">
                <input className="room-share__input" readOnly value={shareLink} dir="ltr" aria-label="رابط الغرفة" />
                <button type="button" className="btn btn--primary" onClick={() => void copyLink()}>
                  انسخ الرابط
                </button>
              </div>
              <p className="room-wait__hint">أو أملِ عليه الرمز: {state.code.split("").join(" ")}</p>
            </>
          ) : (
            <>
              <p className="room-wait__line">هذه الغرفة محجوزة للاعبَيها.</p>
              <p className="room-wait__note">إن بدأت المساجلة رأيتَها من هنا، بيتًا ببيت.</p>
            </>
          )}
        </Panel>
      ) : null}

      {/* ── the transcript ─────────────────────────────────────────────── */}
      <RoomLog state={state} mySeat={mySeat} tashkeel={settings.tashkeel} showRawiyy={settings.showRawiyy} />

      {/* ── جارية ──────────────────────────────────────────────────────── */}
      {state.status === "active" ? (
        <section className="duel-desk room-desk" aria-label="جوابك">
          <LetterIndicator
            required={state.required?.requiredLetter ?? null}
            source={state.required?.requiredLetterSource ?? null}
            alsoAccepted={state.required?.alsoAccepted ?? []}
            mode={state.mode}
            draft={myTurn ? draft : ""}
            msLeft={msLeft}
            turnMs={turnMs}
          />

          {msLeft !== null ? (
            <p className="duel-clock" data-tone={msLeft <= 2000 ? "danger" : msLeft <= 5000 ? "warn" : undefined}>
              {formatClock(msLeft)}
            </p>
          ) : null}

          {rejection && myTurn ? (
            <RejectionCard
              rejection={rejection}
              livesLeft={strikesLeft}
              strike={rejection.kind === "wrong_letter" || rejection.kind === "not_found"}
              // «بقيت ضربتان», never «بقي 2» — the معدود is not optional
              // (CLAUDE.md, العدد والمعدود live in shared/format.ts)
              costLabel={`‎−ضربة · ${strikesLeft === 0 ? "ولا ضربة بعدها" : `بقيت ${countedNoun(strikesLeft, DARBA_FORMS)}`}`}
              onFill={(text) => setDraft(text)}
              onCommit={(bait) => void submit(copyableBayt(bait.sadr, bait.ajuz))}
              onDismiss={dismissRejection}
              onRetry={() => void submit()}
            />
          ) : null}

          {precheck !== null ? (
            <p className="duel-precheck" role="status">
              جوابك يبدأ بـ<span className="reject__letter">{precheck ?? "؟"}</span>، والمطلوب{" "}
              <span className="reject__letter reject__letter--want">{state.required?.requiredLetter}</span> — لم أسأل
              الديوان بعد.
            </p>
          ) : null}

          {myTurn ? (
            <AnswerInput
              value={draft}
              onChange={(v) => {
                setPrecheck(null)
                setDraft(v)
              }}
              onSubmit={() => void submit()}
              disabled={busy}
              placeholder="أجب ببيتٍ يبدأ بالحرف المطلوب — ويكفي صدره"
              required={state.required?.requiredLetter ?? null}
              alsoAccepted={state.required?.alsoAccepted ?? []}
              invalid={precheck !== null}
              onPrecheckFail={(typed) => setPrecheck(typed)}
            />
          ) : (
            <p className="room-turnline" role="status">
              {spectating
                ? `الدور على ${waitingSeat?.displayName ?? "اللاعب"}`
                : `الدور على ${waitingSeat?.displayName ?? "خصمك"} — انتظر بيته`}
            </p>
          )}

          {notice ? (
            <p className="room-notice" role="alert">
              {notice}
            </p>
          ) : null}

          {!spectating ? (
            <div className="duel-acts room-acts">
              <button type="button" className="btn btn--ghost" onClick={() => void resign()} disabled={busy}>
                انسحب
              </button>
              <span className="duel-acts__note keys-only">أدخِل ليُرسَل · Shift+Enter لسطر جديد</span>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── انتهت ──────────────────────────────────────────────────────── */}
      {state.status === "done" ? (
        <Panel
          illuminated
          className="room-end"
          title={
            state.winner === null
              ? "انتهت المساجلة"
              : won
                ? "لك الغلبة"
                : spectating
                  ? `الغلبة لـ${winnerName ?? ""}`
                  : "الغلبة لخصمك"
          }
        >
          <p className="room-end__why">{endReasonLine(state.endReason, loserName)}.</p>
          <p className="room-end__count">
            {countedNoun(state.turns.filter((t) => t.bait !== null).length, BAYT_FORMS)} في هذه المساجلة.
          </p>
          <div className="room-end__acts">
            {/* A رجعة that was already open when this room loaded is a place to
                go, not a place to be sent: the reader may have come here to
                re-read this transcript. */}
            {rematchCode !== null && !rematchIsNew ? (
              <a className="btn btn--primary" href={routeHash({ view: "room", code: rematchCode })}>
                إلى الرجعة
              </a>
            ) : null}
            {!spectating ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => {
                  void rematch().then((next) => {
                    if (next) navigate({ view: "room", code: next })
                  })
                }}
              >
                رجعة — وتُبدَّل الأدوار
              </button>
            ) : null}
            <a className="btn" href={routeHash({ view: "profile", username: user.username })}>
              سجلّك
            </a>
            <a className="btn btn--ghost" href={routeHash({ view: "duel" })}>
              غرفة جديدة
            </a>
          </div>
        </Panel>
      ) : null}
    </div>
  )
}
