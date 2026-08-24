/**
 * `#/duel/play` — the مساجلة itself (design-ux.md §4 Play).
 *
 * This view owns NO game state. `machine.ts` decides what the next state is,
 * `duelStore.ts` decides when and talks to the server, and everything here
 * either renders `session` or calls one of the store's verbs. The only local
 * state is the wall clock (a ticking `now`, so the arc moves) and the
 * pre-check flash, neither of which the game may depend on.
 *
 * The beats, in the order the player experiences them:
 *
 *   reciting          the opponent's بيت appears word by word; the TIMER IS
 *                     NOT RUNNING. Any key skips. `onDone` → REVEAL_DONE.
 *   awaiting          the clock starts here, the field takes focus, and the
 *                     letter indicator judges every keystroke locally through
 *                     the SAME `firstLetterOf` the server uses.
 *   verifying         the clock is paused; whatever the wait costs is given
 *                     back to the deadline (amendments.md §7).
 *   rejected/penalising  RejectionCard, and only the two rejections that cost
 *                     a life ever say so.
 *   computerThinking  a 700–1400ms floor so the reply reads as thought.
 *   summary           the route changes; this view never renders it.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { MUBARAZA_EXCHANGES } from "../../shared/constants.ts"
import { formatClock, formatNumber } from "../../shared/format.ts"
import type { BaitDto, HintKind } from "../../shared/schema.ts"
import { navigate } from "../router.ts"
import { motionReduced, useSettings } from "../store/settingsStore.ts"
import {
  abandonDuel,
  buyHint,
  cancelDisambiguation,
  dispatch,
  resolveRejection,
  resubmitBait,
  retryDeal,
  retryReply,
  setDraft,
  submitAnswer,
  tick,
  useDuel,
} from "../store/duelStore.ts"
import { displayScore, playerTurns, timeLeft } from "./machine.ts"
import { AnswerInput } from "./AnswerInput.tsx"
import { ExchangeLog } from "./ExchangeLog.tsx"
import { HintPopover } from "./HintPopover.tsx"
import { Hud } from "./Hud.tsx"
import { LetterIndicator } from "./LetterIndicator.tsx"
import { RejectionCard } from "./RejectionCard.tsx"
import { placeholderFor } from "./placeholders.ts"
import { hintPricing } from "./scoring.ts"

/** How often the arc redraws while a turn is running. */
const TICK_MS = 200

export function DuelPlayView() {
  const session = useDuel((s) => s.session)
  const settings = useSettings()
  const reduced = motionReduced(settings)
  const [now, setNow] = useState(() => Date.now())
  const [hintsOpen, setHintsOpen] = useState(false)
  const [precheck, setPrecheck] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const phase = session?.phase ?? "idle"

  // No مساجلة in progress → the setup screen owns the player (route guard).
  useEffect(() => {
    if (!session) navigate({ view: "duel" }, true)
  }, [session])

  // …and a finished one belongs to the summary.
  useEffect(() => {
    if (session && phase === "summary") navigate({ view: "duel-summary" }, true)
  }, [session, phase])

  // The clock: one interval for the whole view, only while a turn is running.
  useEffect(() => {
    if (phase !== "awaiting") return
    const id = setInterval(() => {
      setNow(Date.now())
      tick()
    }, TICK_MS)
    return () => clearInterval(id)
  }, [phase])

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
  }, [])

  const revealIndex = useMemo(
    () => (session && phase === "reciting" ? session.exchanges.length - 1 : null),
    [session, phase],
  )

  if (!session) return null

  const ms = timeLeft(session, now)
  const turnMs = session.config.turnSeconds * 1000
  const busy = phase === "verifying" || phase === "computerThinking" || phase === "reciting" || phase === "dealing"
  const pricing = hintPricing(session.config.tier)

  const onPrecheckFail = (typed: string | null) => {
    setPrecheck(typed)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setPrecheck(null), 2200)
  }

  const onCommit = (bait: BaitDto, penalty: number) => {
    setPrecheck(null)
    resubmitBait(bait, penalty)
  }

  const onDismiss = () => {
    if (session.phase === "disambiguating") cancelDisambiguation()
    else resolveRejection()
  }

  return (
    <div className="view duel-play" data-phase={phase}>
      <Hud
        lives={session.lives}
        maxLives={session.config.lives}
        streak={session.streak}
        score={displayScore(session)}
        used={session.exchanges.length}
        onAbandon={abandonDuel}
      />

      {session.config.format === "match" ? (
        <p className="duel-progress">
          المبارزة — البيت {formatNumber(Math.min(playerTurns(session) + 1, MUBARAZA_EXCHANGES))} من{" "}
          {formatNumber(MUBARAZA_EXCHANGES)}
        </p>
      ) : null}

      {phase === "dealing" ? <p className="duel-wait">…يختار الخصم بيتًا</p> : null}

      {phase === "failed" ? (
        <div className="duel-failed" role="alert">
          <p>{session.error ?? "تعذّر بدء المساجلة"}</p>
          <button type="button" className="btn btn--primary" onClick={retryDeal}>
            أعد المحاولة
          </button>
        </div>
      ) : null}

      <ExchangeLog
        exchanges={session.exchanges}
        revealIndex={revealIndex}
        onRevealDone={() => dispatch({ type: "REVEAL_DONE", now: Date.now() })}
        reduced={reduced}
        ended={false}
        tashkeel={settings.tashkeel}
        showRawiyy={settings.showRawiyy}
        numerals={settings.numerals}
      />

      {phase === "computerThinking" ? (
        <p className="duel-wait duel-wait--them">
          {session.error ? (
            <>
              <span>{session.error}</span>{" "}
              <button type="button" className="btn btn--ghost" onClick={retryReply}>
                أعد المحاولة
              </button>
            </>
          ) : (
            "…يفكّر الخصم"
          )}
        </p>
      ) : null}

      <section className="duel-desk" aria-label="جوابك">
        <LetterIndicator
          required={session.required.letter}
          source={session.required.source}
          alsoAccepted={session.required.alsoAccepted}
          mode={session.config.chainMode}
          draft={session.draft}
          msLeft={ms}
          turnMs={turnMs}
        />

        {ms !== null ? (
          <p className="duel-clock" data-tone={ms <= 2000 ? "danger" : ms <= 5000 ? "warn" : undefined}>
            {formatClock(ms)}
          </p>
        ) : null}

        {session.rejection ? (
          <RejectionCard
            rejection={session.rejection}
            livesLeft={session.lives}
            onFill={(text) => setDraft(text)}
            onCommit={onCommit}
            onDismiss={onDismiss}
            onRetry={() => {
              const text = session.draft
              resolveRejection()
              submitAnswer(text)
            }}
          />
        ) : null}

        {precheck !== null ? (
          <p className="duel-precheck" role="status">
            جوابك يبدأ بـ<span className="reject__letter">{precheck ?? "؟"}</span>، والمطلوب{" "}
            <span className="reject__letter reject__letter--want">{session.required.letter}</span> — لم أسأل الديوان بعد.
          </p>
        ) : null}

        <AnswerInput
          value={session.draft}
          onChange={(v) => {
            setPrecheck(null)
            setDraft(v)
          }}
          onSubmit={() => submitAnswer()}
          disabled={busy || phase === "penalising" || phase === "summary" || phase === "failed"}
          placeholder={placeholderFor(session.seed, session.exchanges.length, session.config.tier)}
          required={session.required.letter}
          alsoAccepted={session.required.alsoAccepted}
          invalid={precheck !== null}
          onPrecheckFail={onPrecheckFail}
        />

        <div className="duel-acts">
          <div className="duel-acts__hint">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setHintsOpen((v) => !v)}
              disabled={!pricing.allowed || phase !== "awaiting"}
              aria-expanded={hintsOpen}
            >
              هَمْس
            </button>
            <HintPopover
              open={hintsOpen}
              tier={session.config.tier}
              bought={session.hints}
              reveals={session.hintReveals}
              disabled={phase !== "awaiting"}
              onBuy={(k: HintKind) => void buyHint(k)}
              onClose={() => setHintsOpen(false)}
            />
          </div>
          <span className="duel-acts__note">أدخِل ليُرسَل · Shift+Enter لسطر جديد · يُقبل الصدر وحده</span>
        </div>
      </section>
    </div>
  )
}
