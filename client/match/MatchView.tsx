/**
 * `#/match/<CODE>` — a مساجلة between two people with no accounts.
 *
 * The room screen's furniture (`RoomView`), with a door instead of a sign-in:
 *   • الباب — a name field and «ادخل» (with the invite) or «اطرق الباب» (with
 *     the spoken code alone).
 *   • الانتظار — the host's share link, the spoken code, and whoever knocks.
 *   • جارية — the seats, the transcript, the required letter and the field.
 *   • انتهت — who won and why.
 * Nothing here decides anything; it renders the snapshot (`matchStore`).
 */
import { useEffect, useReducer, useRef, useState } from "react"

import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { Avatar } from "../components/Avatar.tsx"
import { Chip } from "../components/Chip.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { Nib, Rule } from "../components/Ornaments.tsx"
import { Panel } from "../components/Panel.tsx"
import { AnswerInput } from "../duel/AnswerInput.tsx"
import { useFollowNewest } from "../duel/ExchangeLog.tsx"
import { LetterIndicator } from "../duel/LetterIndicator.tsx"
import { ANSWER_PLACEHOLDER_NARROW } from "../duel/placeholders.ts"
import { RejectionCard } from "../duel/RejectionCard.tsx"
import { seatTranscript } from "../duel/share.ts"
import { shareTextBlock } from "../share/dailyShare.ts"
import { useNativeChrome } from "../hooks/useNativeChrome.ts"
import { routeHash } from "../router.ts"
import { useImmersive } from "../store/immersiveStore.ts"
import { motionReduced, useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { BAYT_FORMS, DARBA_FORMS, DAQIQA_FORMS, copyableBayt, countedNoun, countedNounGenitive, formatClock, formatNumber, lamPrefix } from "../../shared/format.ts"
import { MATCH_NAME_MAX, type MatchPlayer, type MatchState } from "../../shared/match.ts"
import type { RoomSeat } from "../../shared/schema.ts"
import { matchTimeLeft, useMatch } from "./matchStore.ts"
import { lastName } from "./seats.ts"

const TICK_MS = 200
const MODE_LABEL = { rhyme: "على الرويّ", literal: "على الحرف الأخير" } as const
const SEAT_LABEL: Record<RoomSeat, string> = { host: "صاحب المطلع", guest: "المجيب" }

function nameOf(player: MatchPlayer | null, seat: RoomSeat): string {
  return player?.name ?? SEAT_LABEL[seat]
}

function endLine(state: MatchState): string {
  const loserSeat: RoomSeat | null = state.winner === null ? null : state.winner === "host" ? "guest" : "host"
  const loser = loserSeat === null ? "" : nameOf(loserSeat === "host" ? state.host : state.guest, loserSeat)
  switch (state.endReason) {
    case "strikes":
      return `نفدت ضربات ${loser}`
    case "timeout":
      return `انقضى وقت ${loser}`
    case "resign":
      return `انسحب ${loser}`
    default:
      return state.startedAt === null ? "أُغلقت المساجلة قبل أن تبدأ" : "توقّفت المساجلة"
  }
}

function CodeBlock({ code }: { code: string }) {
  return (
    <p className="room-code" dir="ltr" aria-label={`رمز المساجلة ${code.split("").join(" ")}`}>
      {code.split("").map((ch, i) => (
        <span className="room-code__ch" key={`${ch}${i}`}>
          {ch}
        </span>
      ))}
    </p>
  )
}

function Seat({ state, seat }: { state: MatchState; seat: RoomSeat }) {
  const player = seat === "host" ? state.host : state.guest
  if (!player) {
    return (
      <div className="seat seat--empty" data-seat={seat}>
        <span className="seat__disc seat__disc--empty" aria-hidden="true">
          ؟
        </span>
        <span className="seat__name">بانتظار خصم</span>
        <span className="seat__role">{SEAT_LABEL[seat]}</span>
      </div>
    )
  }
  const you = state.you.seat === seat
  const left = Math.max(0, state.strikes - player.strikes)
  const name = nameOf(player, seat)
  return (
    <div
      className="seat"
      data-seat={seat}
      data-active={state.turnSeat === seat ? "1" : undefined}
      data-you={you ? "1" : undefined}
    >
      <span className="seat__disc" aria-hidden="true">
        <Avatar name={name} src={null} />
      </span>
      <span className="seat__name">
        <bdi>{name}</bdi>
      </span>
      <span className="seat__role">
        {SEAT_LABEL[seat]}
        {you ? " — أنت" : ""}
      </span>
      <span
        className="seat__strikes"
        role="img"
        aria-label={`بقيت ${countedNoun(left, DARBA_FORMS)} من ${formatNumber(state.strikes)}`}
      >
        {Array.from({ length: state.strikes }, (_, i) => (
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

function Transcript({ state, docked }: { state: MatchState; docked: boolean }) {
  const settings = useSettings()
  const listRef = useRef<HTMLOListElement | null>(null)
  useFollowNewest(listRef, [state.turns.length], { enabled: docked, docked, reduced: motionReduced(settings) })
  return (
    <ol className="exchange-log room-log" data-variant="summary" ref={listRef}>
      {state.turns.map((turn) => {
        const mine = turn.seat === state.you.seat
        const name = nameOf(turn.seat === "host" ? state.host : state.guest, turn.seat)
        if (turn.bait === null) {
          return (
            <li className="exchange room-miss" key={turn.turnNo} data-side={mine ? "player" : "opponent"}>
              <p className="room-miss__line">
                <span className="room-miss__who">
                  <bdi>{name}</bdi>
                </span>
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
        const meta = (
          <>
            <span className="exchange__who">
              <bdi>{name}</bdi>
            </span>
            {turn.verdict === "opening" ? <span className="room-opening">المطلع</span> : null}
            {turn.bait.poet ? (
              <a className="exchange__poet" href={routeHash({ view: "poet", slug: turn.bait.poet.slug })}>
                <bdi>{lamPrefix(turn.bait.poet.name)}</bdi>
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
              tashkeel={settings.tashkeel}
              showRawiyy={settings.showRawiyy}
              rawiyy={turn.bait.rawiyy}
              copyText={copyableBayt(turn.bait.sadr, turn.bait.ajuz)}
            />
          </li>
        )
      })}
    </ol>
  )
}

/** The door: a name, and «ادخل» or «اطرق الباب». */
function Door() {
  const invited = useMatch((s) => s.joinKey !== null)
  const enter = useMatch((s) => s.enter)
  const busy = useMatch((s) => s.busy)
  const notice = useMatch((s) => s.notice)
  const [name, setName] = useState(lastName)
  return (
    <Panel illuminated className="room-wait match-door">
      <p className="room-wait__line">{invited ? "دُعيتَ إلى مساجلة." : "بلغتَ المساجلة بالرمز."}</p>
      <p className="room-wait__note">
        {invited
          ? "يُنشد صاحبها المطلع، وتُجيب أنت أوّلًا ببيتٍ على حرف رويّه. يبدأ الوقت بدخولك."
          : "اطرق الباب، فإن أذن لك صاحبها دخلت."}
      </p>
      <form
        className="friend-search"
        onSubmit={(e) => {
          e.preventDefault()
          void enter(name)
        }}
      >
        <input
          className="friend-search__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="اسمك (اختياري)"
          maxLength={MATCH_NAME_MAX}
          dir="auto"
          autoComplete="nickname"
          aria-label="اسمك كما يراه خصمك"
        />
        <button type="submit" className="btn btn--primary btn--lg" disabled={busy}>
          {invited ? "ادخل المساجلة" : busy ? "…يُطرق الباب" : "اطرق الباب"}
        </button>
      </form>
      {notice ? (
        <p className="room-notice" role="alert">
          {notice}
        </p>
      ) : null}
    </Panel>
  )
}

function Knocking() {
  const knock = useMatch((s) => s.knock)
  const rejected = knock?.status === "rejected"
  return (
    <Panel illuminated className="room-knock">
      {rejected ? (
        <>
          <p className="room-knock__line">لم يأذن لك صاحب المساجلة.</p>
          <p className="room-knock__note">اطلب منه الرابط، أو افتح مساجلتك.</p>
          <a className="btn btn--primary btn--lg" href={routeHash({ view: "duel" })}>
            مساجلة جديدة
          </a>
        </>
      ) : (
        <>
          <p className="room-knock__line">طرقتَ الباب…</p>
          <p className="room-knock__note">
            {knock?.hostName ? (
              <>
                بانتظار أن يأذن لك <bdi>{knock.hostName}</bdi>.
              </>
            ) : (
              "بانتظار إذن صاحب المساجلة."
            )}{" "}
            اترك الصفحة مفتوحة.
          </p>
          <span className="room-knock__spin" aria-label="بانتظار الإذن" role="status" />
        </>
      )}
    </Panel>
  )
}

function Waiting({ state }: { state: MatchState }) {
  const shareUrl = useMatch((s) => s.shareUrl)
  const act = useMatch((s) => s.act)
  const busy = useMatch((s) => s.busy)
  const notice = useMatch((s) => s.notice)
  const skew = useMatch((s) => s.skew)
  const copy = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast("نُسخ الرابط", "ok")
    } catch {
      toast("تعذّر النسخ", "warn")
    }
  }
  const minutesLeft = state.expiresAt === null ? null : Math.max(1, Math.ceil((state.expiresAt - (Date.now() + skew)) / 60_000))
  return (
    <Panel illuminated className="room-wait">
      {state.knock ? (
        <div className="room-door" role="alert">
          <p className="room-door__line">
            <bdi>{state.knock.name ?? "ضيف"}</bdi> يطرق الباب.
          </p>
          <div className="room-door__acts">
            <button type="button" className="btn btn--primary" onClick={() => void act("admit")} disabled={busy}>
              اقبل
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => void act("refuse")} disabled={busy}>
              ارفض
            </button>
          </div>
        </div>
      ) : null}
      <p className="room-wait__line">ابعث الرابط إلى صاحبك.</p>
      <p className="room-wait__note">تبدأ المساجلة حين يدخل، وهو الذي يُجيب أوّلًا عن مطلعك.</p>
      {shareUrl ? (
        <div className="room-share">
          <code className="room-share__link" dir="ltr">
            {shareUrl}
          </code>
          <button type="button" className="btn btn--primary" onClick={() => void copy()}>
            انسخ الرابط
          </button>
        </div>
      ) : null}
      <p className="room-wait__hint">
        أو أملِ عليه الرمز —{" "}
        <span className="room-wait__code" dir="ltr">
          {state.code.split("").join(" ")}
        </span>{" "}
        — فيطرق الباب وتأذن له من هنا.
      </p>
      {minutesLeft !== null ? (
        <p className="room-wait__note">تُغلق المساجلة إن لم يدخل أحد خلال {countedNounGenitive(minutesLeft, DAQIQA_FORMS)}.</p>
      ) : null}
      {notice ? (
        <p className="room-notice" role="alert">
          {notice}
        </p>
      ) : null}
      <div className="room-wait__acts">
        <button type="button" className="btn btn--ghost" onClick={() => void act("resign")} disabled={busy}>
          أغلق المساجلة
        </button>
      </div>
    </Panel>
  )
}

export function MatchView({ code, joinKey }: { code: string; joinKey?: string }) {
  const settings = useSettings()
  const phase = useMatch((s) => s.phase)
  const state = useMatch((s) => s.state)
  const error = useMatch((s) => s.error)
  const notice = useMatch((s) => s.notice)
  const busy = useMatch((s) => s.busy)
  const draft = useMatch((s) => s.draft)
  const rejection = useMatch((s) => s.rejection)
  const strikesLeft = useMatch((s) => s.strikesLeft)
  const transport = useMatch((s) => s.transport)
  const skew = useMatch((s) => s.skew)
  const open = useMatch((s) => s.open)
  const close = useMatch((s) => s.close)
  const setDraft = useMatch((s) => s.setDraft)
  const submit = useMatch((s) => s.submit)
  const act = useMatch((s) => s.act)
  const dismissRejection = useMatch((s) => s.dismissRejection)
  const native = useNativeChrome()
  const [, tock] = useReducer((n: number) => n + 1, 0)
  const [precheck, setPrecheck] = useState<string | null>(null)

  useEffect(() => {
    open(code, joinKey ?? null)
    return () => close()
  }, [code, joinKey, open, close])

  const running = state?.status === "active" && state.deadlineAt !== null
  useEffect(() => {
    if (!running) return
    const id = setInterval(tock, TICK_MS)
    return () => clearInterval(id)
  }, [running])

  const playing = state?.status === "active"
  useImmersive(Boolean(native && playing), () => void act("resign"))

  const head = (
    <div className="view__head">
      <h1 className="view__title">مساجلة</h1>
    </div>
  )

  if (phase === "gone") {
    return (
      <div className="view room-view">
        {head}
        <EmptyState flavor="search-none" title="لا مساجلة بهذا الرمز">
          <p className="empty__note">{error ?? "لعلّها انتهت وطُويت."}</p>
          <a className="btn" href={routeHash({ view: "duel" })}>
            مساجلة جديدة
          </a>
        </EmptyState>
      </div>
    )
  }

  if (phase === "door" || phase === "knocking") {
    return (
      <div className="view room-view">
        {head}
        <Rule />
        {phase === "door" ? <Door /> : <Knocking />}
      </div>
    )
  }

  if (!state) {
    return (
      <div className="view room-view" aria-busy="true">
        {head}
        {error ? <p className="room-notice" role="alert">{error}</p> : null}
        <span className="skeleton" style={{ blockSize: "6rem" }} />
        <span className="skeleton" style={{ blockSize: "12rem" }} />
      </div>
    )
  }

  const msLeft = matchTimeLeft(state, skew)
  const turnMs = (state.timerS ?? 0) * 1000
  const myTurn = state.you.canPlay
  const turnName = state.turnSeat ? nameOf(state.turnSeat === "host" ? state.host : state.guest, state.turnSeat) : ""
  const transcript = <Transcript state={state} docked={Boolean(native && playing)} />

  return (
    <div className="view room-view" data-status={state.status}>
      <header className="view__head room-head">
        <div className="room-head__id">
          <h1 className="view__title">مساجلة</h1>
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
          <span className="room-head__code-label">رمز المساجلة</span>
          <CodeBlock code={state.code} />
        </div>
      </header>

      <Rule />

      <div className="room-seats">
        <Seat state={state} seat="host" />
        {native && playing && msLeft !== null ? (
          <span
            className="room-seats__vs room-seats__clock"
            data-tone={msLeft <= 2000 ? "danger" : msLeft <= 5000 ? "warn" : undefined}
            role="timer"
            aria-label="ما بقي من وقت الدور"
          >
            {formatClock(msLeft)}
          </span>
        ) : (
          <span className="room-seats__vs" aria-hidden="true">
            ×
          </span>
        )}
        <Seat state={state} seat="guest" />
      </div>

      {state.status === "waiting" ? transcript : null}
      {state.status === "waiting" && state.you.seat === "host" ? <Waiting state={state} /> : null}
      {state.status === "waiting" ? null : transcript}

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
          {msLeft !== null && !(native && playing) ? (
            <p className="duel-clock" data-tone={msLeft <= 2000 ? "danger" : msLeft <= 5000 ? "warn" : undefined}>
              {formatClock(msLeft)}
            </p>
          ) : null}

          {rejection && myTurn ? (
            <RejectionCard
              rejection={rejection}
              livesLeft={strikesLeft}
              strike={rejection.kind === "wrong_letter" || rejection.kind === "not_found"}
              costLabel={`‎−ضربة · ${strikesLeft === 0 ? "ولا ضربة بعدها" : `بقيت ${countedNoun(strikesLeft, DARBA_FORMS)}`}`}
              onFill={(text) => setDraft(text)}
              onCommit={(bait) => void submit(copyableBayt(bait.sadr, bait.ajuz))}
              onDismiss={dismissRejection}
              onRetry={() => void submit()}
            />
          ) : null}

          {precheck !== null ? (
            <p className="duel-precheck" role="status">
              جوابك يبدأ بـ<span className="reject__letter">{precheck || "؟"}</span>، والمطلوب{" "}
              <span className="reject__letter reject__letter--want">{state.required?.requiredLetter}</span>.
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
              placeholder={native ? ANSWER_PLACEHOLDER_NARROW : "أجب ببيتٍ يبدأ بالحرف المطلوب — ويكفي صدره"}
              required={state.required?.requiredLetter ?? null}
              alsoAccepted={state.required?.alsoAccepted ?? []}
              invalid={precheck !== null}
              onPrecheckFail={(typed) => setPrecheck(typed)}
            />
          ) : (
            <p className="room-turnline" role="status">
              الدور على <bdi>{turnName}</bdi> — انتظر بيته
            </p>
          )}

          {notice ? (
            <p className="room-notice" role="alert">
              {notice}
            </p>
          ) : null}

          <div className="duel-acts room-acts">
            <button type="button" className="btn btn--ghost" onClick={() => void act("resign")} disabled={busy}>
              انسحب
            </button>
          </div>
        </section>
      ) : null}

      {state.status === "done" ? (
        <Panel
          illuminated
          className="room-end"
          title={state.winner === null ? "انتهت المساجلة" : state.winner === state.you.seat ? "لك الغلبة" : "الغلبة لخصمك"}
        >
          <p className="room-end__why">{endLine(state)}.</p>
          <p className="room-end__count">
            {countedNoun(state.turns.filter((t) => t.bait !== null).length, BAYT_FORMS)} في هذه المساجلة.
          </p>
          <div className="room-end__acts">
            <a className="btn btn--primary" href={routeHash({ view: "duel" })}>
              مساجلة جديدة
            </a>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const nameAt = (seat: RoomSeat) => nameOf(seat === "host" ? state.host : state.guest, seat)
                const text = seatTranscript({
                  turns: state.turns,
                  nameOf: nameAt,
                  winner: state.winner === null ? null : nameAt(state.winner),
                  tashkeel: settings.tashkeel,
                })
                void shareTextBlock(text).then((outcome) => {
                  if (outcome === "copied") toast("نُسخت أبيات المساجلة", "ok")
                  else if (outcome === "failed") toast("تعذّرت المشاركة", "warn")
                })
              }}
            >
              شارك الأبيات
            </button>
          </div>
        </Panel>
      ) : null}
    </div>
  )
}
