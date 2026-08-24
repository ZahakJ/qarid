/**
 * The مساجلة state machine — a PURE reducer (design-ux.md §4.3).
 *
 *   idle ─START→ dealing ─DEALT→ reciting ─REVEAL_DONE|SKIP→ awaiting
 *   awaiting ─SUBMIT→ verifying ─VERIFIED→ accepted | rejected | penalising
 *                                        | disambiguating
 *   accepted ─CONTINUE→ computerThinking ─REPLIED→ reciting
 *                                        ─NO_REPLY→ summary («أفحمتَ الخصم»)
 *   penalising ─RESOLVE→ awaiting (lives left) | summary (defeat)
 *
 * Nothing in this file reads the clock, the network, localStorage or React.
 * Every action carries `now` and every effect is the caller's job, which is
 * what makes the whole game testable in Node with no DOM (machine.test.ts).
 *
 * Four rules the docs are emphatic about, and where they live here:
 *
 *  1. **Timers are wall-clock anchored** (amendments.md §7). State holds a
 *     `deadline` epoch, never a countdown — a backgrounded tab, a slept
 *     laptop and a re-render all read the same remaining time.
 *  2. **The timer is PAUSED while verifying** and the paused span is ADDED
 *     BACK to the deadline when the answer comes home (`resumeClock`). A slow
 *     server never eats the player's thinking time — but the credit is capped
 *     at `MAX_PAUSE_CREDIT_MS`, because a card the player simply leaves up is
 *     not a slow server, and an uncapped pause was a free pause button.
 *     `RESUME` obeys the same idea: a reload carries the STORED deadline
 *     forward plus `RESUME_GRACE_MS`, never a whole fresh turn.
 *  3. **A network error never costs a life.** `VERIFY_ERROR` lands in
 *     `rejected`, the soft branch, exactly like a wrong letter.
 *  4. **Hints are charged once.** design-ux.md §4.3 both deducts the price on
 *     purchase AND subtracts `hintsSpentThisExchange` from the award; doing
 *     both would charge twice. Purchases accumulate in `hintSpend` and are
 *     settled exactly once — inside the award when the بيت is accepted, or
 *     straight off the score when the exchange is lost. `displayScore()` shows
 *     the pending spend immediately, so the HUD still drops the moment a hint
 *     is bought.
 *
 * The state is a SUPERSET of `DuelSessionSlice` (shared/schema.ts): the
 * persisted fields keep their names and meanings, and `toSlice()` drops the
 * transient ones (the rejection card, the draft, the hint reveals).
 */
import { MUBARAZA_EXCHANGES } from "../../shared/constants.ts"
import {
  DuelSessionSliceSchema,
  type BaitDto,
  type ChainState,
  type DuelConfig,
  type DuelPhase,
  type DuelSessionSlice,
  type Exchange,
  type GameVerifyResponse,
  type HintKind,
  type PoemSummary,
  type PoetSummary,
} from "../../shared/schema.ts"
import { awardFor, scoreObscurity, STUMP_BONUS, type AwardBreakdown } from "./scoring.ts"

// ═══════════════════════════════════════════════════════════════════════════
// Shapes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What /api/game/start, /reply, a passing /verify and «بدّل الحرف» all return.
 *
 * `relaxed` only ever arrives on a REPLY: every tier inside the player's
 * «القيود» was dry on this letter, so the opponent stepped outside them rather
 * than answer `no_bait` and hand over «أفحمتَ الخصم» (+500) for free.
 */
export type ServedBait = { bait: BaitDto; poem: PoemSummary; poet: PoetSummary; relaxed?: boolean } & ChainState

/** Why the last answer was refused — everything the RejectionCard needs. */
export type Rejection =
  | { kind: "wrong_letter"; expected: string; alsoAccepted: string[]; got: string | null; normalized: string }
  | { kind: "already_used"; bait: BaitDto }
  | { kind: "not_found"; normalized: string; suggestions: BaitDto[] }
  | { kind: "near_miss"; normalized: string; suggestion: BaitDto; score: number; acceptCost: number }
  | { kind: "ambiguous"; normalized: string; candidates: BaitDto[] }
  | { kind: "incomplete_bait"; bait: BaitDto }
  | { kind: "too_short"; words: number }
  /** «انقضى الوقت» — `bait` is a بيت that WOULD have worked, when we have one */
  | { kind: "timeout"; bait: BaitDto | null }
  /** the server was unreachable; costs nothing */
  | { kind: "network"; message: string }
  | { kind: "no_bait"; letter: string | null }

/** How the duel ended, for the summary headline. */
export type DuelOutcome = "stumped" | "defeat" | "abandoned" | "match" | null

/** What the three cheap hints revealed about the بيت the player owes. */
export type HintReveals = {
  poet?: string
  firstWord?: string
  meter?: string | null
}

export type DuelState = DuelSessionSlice & {
  // ── transient (never persisted) ─────────────────────────────────────────
  rejection: Rejection | null
  /** hints bought on the CURRENT exchange */
  hints: HintKind[]
  /** points committed to those hints, settled once (see the header) */
  hintSpend: number
  hintReveals: HintReveals
  /** the textarea contents, kept across a soft rejection */
  draft: string
  /** when the player's current turn began — the exchange's `ms` */
  turnStartedAt: number
  /** award of the بيت just accepted, for the `+140` animation */
  lastAward: AwardBreakdown | null
  /** dealing/reply failure text; null when healthy */
  error: string | null
}

// ═══════════════════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════════════════

export type DuelAction =
  | { type: "START"; config: DuelConfig; seed: string; now: number; dailyDate?: string | null }
  | { type: "DEALT"; served: ServedBait; now: number }
  | { type: "DEAL_FAILED"; message: string; now: number }
  | { type: "REVEAL_DONE"; now: number }
  | { type: "SKIP"; now: number }
  | { type: "TICK"; now: number }
  | { type: "TIMEOUT"; now: number; bait?: BaitDto | null }
  /** the consolation بيت for a timeout card, fetched after the fact */
  | { type: "TIMEOUT_BAIT"; bait: BaitDto }
  | { type: "DRAFT"; text: string }
  | { type: "SUBMIT"; text: string; now: number }
  | { type: "VERIFIED"; response: GameVerifyResponse; now: number }
  | { type: "VERIFY_ERROR"; message: string; now: number }
  /** re-send a picked candidate / an accepted near-miss through verify */
  | { type: "RESUBMIT"; text: string; penalty: number; now: number }
  | { type: "CANCEL"; now: number }
  | { type: "RESOLVE"; now: number }
  | { type: "HINT"; kind: HintKind; cost: number; reveal?: HintReveals; now: number }
  | { type: "HINT_SWITCH"; served: ServedBait; cost: number; now: number }
  | { type: "CONTINUE"; now: number }
  | { type: "REPLIED"; served: ServedBait; now: number }
  | { type: "NO_REPLY"; letter: string | null; now: number }
  | { type: "REPLY_ERROR"; message: string; now: number }
  | { type: "RETRY"; now: number }
  | { type: "ABANDON"; now: number }
  | { type: "PLAY_AGAIN"; seed: string; now: number }
  | { type: "EXIT" }
  | { type: "RESUME"; now: number }

// ═══════════════════════════════════════════════════════════════════════════
// Construction
// ═══════════════════════════════════════════════════════════════════════════

const TRANSIENT: Omit<DuelState, keyof DuelSessionSlice> = {
  rejection: null,
  hints: [],
  hintSpend: 0,
  hintReveals: {},
  draft: "",
  turnStartedAt: 0,
  lastAward: null,
  error: null,
}

/** A fresh duel from a setup config — phase `dealing`, nothing said yet. */
export function newDuel(config: DuelConfig, seed: string, now: number, dailyDate: string | null = null): DuelState {
  return {
    ...TRANSIENT,
    config,
    seed,
    phase: "dealing",
    outcome: null,
    endedAt: null,
    required: { letter: null, source: null, alsoAccepted: [] },
    exchanges: [],
    usedKeys: [],
    usedBaitIds: [],
    usedPoemIds: [],
    score: 0,
    lives: config.lives,
    streak: 0,
    best: 0,
    startedAt: now,
    deadline: null,
    pausedAt: null,
    lastResult: null,
    dailyDate,
  }
}

/** The persisted subset — everything transient is dropped on the floor. */
export function toSlice(s: DuelState): DuelSessionSlice {
  return {
    config: s.config,
    seed: s.seed,
    phase: s.phase,
    required: s.required,
    exchanges: s.exchanges,
    usedKeys: s.usedKeys,
    usedBaitIds: s.usedBaitIds,
    usedPoemIds: s.usedPoemIds,
    score: s.score,
    lives: s.lives,
    streak: s.streak,
    best: s.best,
    startedAt: s.startedAt,
    deadline: s.deadline,
    pausedAt: s.pausedAt,
    lastResult: s.lastResult,
    dailyDate: s.dailyDate,
    outcome: s.outcome,
    endedAt: s.endedAt,
  }
}

/**
 * Rehydrate a persisted session. Phases that were mid-flight when the tab
 * closed are normalized by `RESUME`, so a reload can never strand the player
 * in `verifying` waiting for a response that will never arrive. What a reload
 * does NOT do is refill the clock: the stored deadline is carried forward, and
 * one that expired while the tab was shut lands as an ordinary timeout.
 */
export function fromSlice(slice: DuelSessionSlice, now: number): DuelState {
  const parsed = DuelSessionSliceSchema.parse(slice)
  return reduce({ ...TRANSIENT, ...parsed }, { type: "RESUME", now })
}

// ═══════════════════════════════════════════════════════════════════════════
// Derived reads (pure; the views use these instead of re-deriving)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ms left on the turn, or null when the timer is off.
 *
 * A clock paused by the SERVER (`verifying`) freezes outright — amendments.md
 * §7. A clock paused by a CARD the player controls (`rejected`,
 * `disambiguating`) freezes for `MAX_PAUSE_CREDIT_MS` and then runs again: a
 * `near_miss` card sits there until «لا، سأعيد» is pressed, so an uncapped
 * pause was an unlimited pause button on every tier, سيف included (review
 * finding). `resumeClock` credits back exactly what this shows.
 */
export function timeLeft(s: DuelState, now: number): number | null {
  if (!s.config.timer || s.deadline === null) return null
  return liveRemaining(s, now)
}

/**
 * Whose pause is it?
 *
 * `verifying` is the SERVER's — amendments.md §7 gives every ms of it back,
 * whatever it costs. `rejected` and `disambiguating` are the PLAYER's: those
 * cards sit there until they are answered or dismissed, so their span is
 * credited only up to `MAX_PAUSE_CREDIT_MS` and the clock runs again after it.
 */
function pauseIsPlayers(s: DuelState): boolean {
  return s.phase === "rejected" || s.phase === "disambiguating"
}

/** The honest remaining ms, with the player's own pause capped. */
function liveRemaining(s: DuelState, now: number): number {
  if (s.deadline === null) return 0
  if (s.pausedAt === null) return Math.max(0, s.deadline - now)
  const overrun = pauseIsPlayers(s) ? Math.max(0, now - s.pausedAt - MAX_PAUSE_CREDIT_MS) : 0
  return Math.max(0, s.deadline - s.pausedAt - overrun)
}

/** Score as the HUD shows it: committed hint spend is deducted immediately. */
export function displayScore(s: DuelState): number {
  return s.score - s.hintSpend
}

/** The بيت currently on the table — the opponent's last recitation. */
export function currentBait(s: DuelState): Exchange | null {
  for (let i = s.exchanges.length - 1; i >= 0; i--) {
    const e = s.exchanges[i]
    if (e && e.side === "opponent") return e
  }
  return null
}

/** The letter the OPPONENT owes — taken off the player's last بيت. */
export function replyLetter(s: DuelState): string | null {
  for (let i = s.exchanges.length - 1; i >= 0; i--) {
    const e = s.exchanges[i]
    if (e && e.side === "player") return e.requiredLetter
  }
  return null
}

/** How many أبيات the player has landed (المبارزة counts to 10). */
export function playerTurns(s: DuelState): number {
  return s.exchanges.reduce((n, e) => n + (e.side === "player" ? 1 : 0), 0)
}

/** Every letter the chain has run through, oldest first — the ribbon. */
export function letterChain(s: DuelState): { letter: string; side: "player" | "opponent" }[] {
  const out: { letter: string; side: "player" | "opponent" }[] = []
  for (const e of s.exchanges) {
    if (e.requiredLetter) out.push({ letter: e.requiredLetter, side: e.side })
  }
  return out
}

/** True when the answer the player is typing may be submitted at all. */
export function canSubmit(s: DuelState): boolean {
  return s.phase === "awaiting" && s.draft.trim().length > 0
}

// ═══════════════════════════════════════════════════════════════════════════
// Internals
// ═══════════════════════════════════════════════════════════════════════════

function startClock(s: DuelState, now: number): Pick<DuelState, "deadline" | "pausedAt" | "turnStartedAt"> {
  return {
    deadline: s.config.timer ? now + s.config.turnSeconds * 1000 : null,
    pausedAt: null,
    turnStartedAt: now,
  }
}

/**
 * The most a single pause may credit back. Every honest pause is short — the
 * verify round-trip is ~11 ms on the real corpus and the longest soft card is
 * the four-second «أرِني أين قيل» — so five seconds covers all of them and
 * refuses the one that is not honest: parking on a `near_miss` card.
 */
export const MAX_PAUSE_CREDIT_MS = 5_000

/**
 * A reload is worth a few seconds of grace — the tab has to boot, the fonts
 * have to land — but never a whole new turn. `RESUME` adds this to whatever was
 * left and never exceeds the tier's own `turnSeconds`.
 */
export const RESUME_GRACE_MS = 3_000

/** amendments.md §7 — give back the ms spent waiting (see `pauseIsPlayers`). */
function resumeClock(s: DuelState, now: number): Pick<DuelState, "deadline" | "pausedAt"> {
  if (s.pausedAt === null) return { deadline: s.deadline, pausedAt: null }
  const span = Math.max(0, now - s.pausedAt)
  const credited = pauseIsPlayers(s) ? Math.min(span, MAX_PAUSE_CREDIT_MS) : span
  return { deadline: s.deadline === null ? null : s.deadline + credited, pausedAt: null }
}

function exchangeOf(served: ServedBait, side: "player" | "opponent", now: number, extra: Partial<Exchange> = {}): Exchange {
  return {
    side,
    baytKey: served.bait.baytKey,
    baitId: served.bait.id,
    sadr: served.bait.sadr,
    ajuz: served.bait.ajuz,
    poemId: served.poem.id,
    poet: { slug: served.poet.slug, name: served.poet.name },
    meter: served.bait.meter ?? served.poem.meter,
    // the letter this بيت DEMANDS of whoever answers it
    requiredLetter: served.requiredLetter,
    award: 0,
    hints: [],
    ms: 0,
    obscurity: served.obscurity,
    at: now,
    // the player's own بيت is never «relaxed» — only the opponent has قيود to leave
    relaxed: side === "opponent" && served.relaxed === true,
    ...extra,
  }
}

/**
 * Add a served بيت to the used sets — nobody may say it twice, and nobody may
 * come back for a second بيت of the same قصيدة.
 *
 * `usedPoemIds` / `excludePoemIds` are the server's INTERNAL `poems.id`, and
 * that is precisely what `bait.poem.poemId` is (`PoemRefSchema`). It used to be
 * derived by parsing the PUBLIC id — which is `q<rowid>` for the 73% of قصائد
 * with no aldiwan page but the bare aldiwan number for the other 27%
 * (CLAUDE.md spike finding 1). On those, parsing gave either nothing (so the
 * exclusion silently did not happen) or an unrelated poem's id. Reading the
 * field the server already sends makes poem-level exclusion true for all of
 * them.
 */
function withUsed(s: DuelState, served: ServedBait): Pick<DuelState, "usedKeys" | "usedBaitIds" | "usedPoemIds"> {
  const poemNum = served.bait.poem.poemId
  return {
    usedKeys: s.usedKeys.includes(served.bait.baytKey) ? s.usedKeys : [...s.usedKeys, served.bait.baytKey],
    usedBaitIds: s.usedBaitIds.includes(served.bait.id) ? s.usedBaitIds : [...s.usedBaitIds, served.bait.id],
    usedPoemIds:
      !Number.isInteger(poemNum) || poemNum <= 0 || s.usedPoemIds.includes(poemNum)
        ? s.usedPoemIds
        : [...s.usedPoemIds, poemNum],
  }
}

/** The opponent recites: a new exchange, a new required letter, a new reveal. */
function recite(s: DuelState, served: ServedBait, now: number): DuelState {
  return {
    ...s,
    ...withUsed(s, served),
    phase: "reciting",
    required: {
      letter: served.requiredLetter,
      source: served.requiredLetterSource,
      alsoAccepted: served.alsoAccepted,
    },
    exchanges: [...s.exchanges, exchangeOf(served, "opponent", now)],
    rejection: null,
    error: null,
    deadline: null,
    pausedAt: null,
    draft: "",
    lastAward: null,
  }
}

/** −1 life, streak broken, committed hints settled against the score. */
/** The tags `DuelSessionSlice.lastResult` accepts (shared/schema.ts). */
export type ResultKind = NonNullable<DuelSessionSlice["lastResult"]>["kind"]

function penalise(s: DuelState, rejection: Rejection, kind: ResultKind, now: number): DuelState {
  const lives = Math.max(0, s.lives - 1)
  const dead = lives === 0
  return {
    ...s,
    lives,
    streak: 0,
    score: s.score - s.hintSpend,
    hints: [],
    hintSpend: 0,
    hintReveals: {},
    rejection,
    lastResult: { kind, message: null, at: now },
    phase: dead ? "summary" : "penalising",
    outcome: dead ? "defeat" : null,
    endedAt: dead ? now : null,
    deadline: dead ? null : s.deadline,
  }
}

/** A refusal that costs nothing: the clock stays paused until RESOLVE. */
function softReject(s: DuelState, rejection: Rejection, kind: ResultKind, now: number): DuelState {
  return {
    ...s,
    phase: "rejected",
    rejection,
    lastResult: { kind, message: null, at: now },
  }
}

/** The player's بيت is in the ديوان and chains: score it and push it. */
function accept(s: DuelState, served: ServedBait, now: number): DuelState {
  const streak = s.streak + 1
  const remaining = s.config.timer && s.deadline !== null ? liveRemaining(s, now) : 0
  const award = awardFor({
    streak,
    msRemaining: remaining,
    timerOn: s.config.timer,
    obscurity: scoreObscurity(served.obscurity, served.poet.poemCount),
    hintPenalty: s.hintSpend,
  })
  const exchange = exchangeOf(served, "player", now, {
    award: award.total,
    hints: s.hints,
    ms: Math.max(0, now - (s.turnStartedAt || now)),
  })
  return {
    ...s,
    ...withUsed(s, served),
    phase: "accepted",
    score: s.score + award.total,
    streak,
    best: Math.max(s.best, streak),
    exchanges: [...s.exchanges, exchange],
    lastAward: award,
    lastResult: { kind: "accepted", message: null, at: now },
    rejection: null,
    hints: [],
    hintSpend: 0,
    hintReveals: {},
    draft: "",
    deadline: null,
    pausedAt: null,
  }
}

function finish(s: DuelState, outcome: Exclude<DuelOutcome, null>, now: number): DuelState {
  return {
    ...s,
    phase: "summary",
    outcome,
    endedAt: now,
    deadline: null,
    pausedAt: null,
    rejection: outcome === "defeat" ? s.rejection : null,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The reducer
// ═══════════════════════════════════════════════════════════════════════════

export function reduce(s: DuelState, a: DuelAction): DuelState {
  switch (a.type) {
    case "START":
      return newDuel(a.config, a.seed, a.now, a.dailyDate ?? null)

    case "DEALT":
      if (s.phase !== "dealing") return s
      return recite(s, a.served, a.now)

    case "DEAL_FAILED":
      if (s.phase !== "dealing") return s
      return { ...s, phase: "failed", error: a.message }

    case "REVEAL_DONE":
    case "SKIP": {
      if (s.phase !== "reciting") return s
      return { ...s, phase: "awaiting", ...startClock(s, a.now) }
    }

    case "TICK": {
      if (s.phase !== "awaiting") return s
      if (!s.config.timer || s.deadline === null || a.now < s.deadline) return s
      return reduce(s, { type: "TIMEOUT", now: a.now, bait: null })
    }

    case "TIMEOUT": {
      if (s.phase !== "awaiting") return s
      return penalise(s, { kind: "timeout", bait: a.bait ?? null }, "timeout", a.now)
    }

    /**
     * The بيت that would have worked arrives after the card does: asking the
     * ديوان for it takes a round-trip, and «انقضى الوقت» must be on screen the
     * instant the clock hits zero. Nothing else about the state moves.
     */
    case "TIMEOUT_BAIT": {
      if (s.rejection?.kind !== "timeout" || s.rejection.bait) return s
      return { ...s, rejection: { ...s.rejection, bait: a.bait } }
    }

    case "DRAFT":
      return s.draft === a.text ? s : { ...s, draft: a.text }

    case "SUBMIT": {
      if (s.phase !== "awaiting") return s
      return { ...s, phase: "verifying", draft: a.text, pausedAt: a.now }
    }

    case "RESUBMIT": {
      if (s.phase !== "rejected" && s.phase !== "disambiguating") return s
      // The card's pause was the PLAYER's: settle it (capped) before opening
      // the server's own pause, or parking on «أهذا ما أردتَ؟» for a minute and
      // then pressing «اقبل هذا البيت» would pay a full-time bonus.
      const settled = resumeClock(s, a.now)
      return {
        ...s,
        phase: "verifying",
        draft: a.text,
        hintSpend: s.hintSpend + Math.max(0, a.penalty),
        rejection: null,
        deadline: settled.deadline,
        pausedAt: a.now,
      }
    }

    case "VERIFY_ERROR": {
      if (s.phase !== "verifying") return s
      // never costs a life (design-ux.md §4.3)
      return softReject(s, { kind: "network", message: a.message }, "network", a.now)
    }

    case "VERIFIED": {
      if (s.phase !== "verifying") return s
      const r = a.response
      if (r.ok) {
        return accept(s, { bait: r.bait, poem: r.poem, poet: r.poet, requiredLetter: r.requiredLetter, requiredLetterSource: r.requiredLetterSource, alsoAccepted: r.alsoAccepted, mode: r.mode, obscurity: r.obscurity }, a.now)
      }
      switch (r.reason) {
        case "wrong_letter":
          return softReject(
            s,
            { kind: "wrong_letter", expected: r.expected, alsoAccepted: r.alsoAccepted, got: r.got, normalized: r.normalized },
            "wrong_letter",
            a.now,
          )
        case "already_used":
          return softReject(s, { kind: "already_used", bait: r.bait }, "already_used", a.now)
        case "too_short":
          return softReject(s, { kind: "too_short", words: r.words }, "too_short", a.now)
        case "near_miss":
          return softReject(
            s,
            { kind: "near_miss", normalized: r.normalized, suggestion: r.suggestion, score: r.score, acceptCost: r.acceptCost },
            "near_miss",
            a.now,
          )
        case "no_bait":
          return softReject(s, { kind: "no_bait", letter: r.letter }, "no_bait", a.now)
        case "ambiguous":
          return {
            ...s,
            phase: "disambiguating",
            rejection: { kind: "ambiguous", normalized: r.normalized, candidates: r.candidates },
            lastResult: { kind: "ambiguous", message: null, at: a.now },
          }
        case "not_found":
          return penalise(s, { kind: "not_found", normalized: r.normalized, suggestions: r.suggestions }, "not_found", a.now)
        case "incomplete_bait":
          // SOFT. The ديوان holds this بيت with no عجز (24,378 قصائد have an
          // odd hemistich count), and the server already prefers a complete
          // copy when one exists — so what is left is the CORPUS being short a
          // شطر, not the player being wrong. Charging a life for the scrape's
          // damage was the bug.
          return softReject(s, { kind: "incomplete_bait", bait: r.bait }, "incomplete_bait", a.now)
      }
      return s
    }

    case "CANCEL": {
      if (s.phase !== "disambiguating") return s
      return { ...s, phase: "awaiting", rejection: null, ...resumeClock(s, a.now) }
    }

    case "RESOLVE": {
      if (s.phase === "rejected") {
        return { ...s, phase: "awaiting", rejection: null, ...resumeClock(s, a.now) }
      }
      if (s.phase === "penalising") {
        return { ...s, phase: "awaiting", rejection: null, ...startClock(s, a.now) }
      }
      return s
    }

    case "HINT": {
      if (s.phase !== "awaiting") return s
      if (s.hints.includes(a.kind)) return s
      return {
        ...s,
        hints: [...s.hints, a.kind],
        hintSpend: s.hintSpend + Math.max(0, a.cost),
        hintReveals: { ...s.hintReveals, ...(a.reveal ?? {}) },
      }
    }

    case "HINT_SWITCH": {
      if (s.phase !== "awaiting") return s
      // amendments.md §8: −150 and the streak dies, but the duel lives on.
      const charged: DuelState = { ...s, hintSpend: s.hintSpend + Math.max(0, a.cost), streak: 0 }
      return { ...recite(charged, a.served, a.now), hints: [...s.hints, "switch_letter"] }
    }

    case "CONTINUE": {
      if (s.phase !== "accepted") return s
      if (s.config.format === "match" && playerTurns(s) >= MUBARAZA_EXCHANGES) return finish(s, "match", a.now)
      return { ...s, phase: "computerThinking", error: null }
    }

    case "REPLIED": {
      if (s.phase !== "computerThinking") return s
      return recite(s, a.served, a.now)
    }

    case "NO_REPLY": {
      if (s.phase !== "computerThinking") return s
      return finish({ ...s, score: s.score + STUMP_BONUS }, "stumped", a.now)
    }

    case "REPLY_ERROR": {
      if (s.phase !== "computerThinking") return s
      return { ...s, error: a.message }
    }

    case "RETRY": {
      if (s.phase === "failed") return { ...s, phase: "dealing", error: null }
      if (s.phase === "computerThinking") return { ...s, error: null }
      return s
    }

    case "ABANDON": {
      if (s.phase === "summary" || s.phase === "idle") return s
      return finish(s, "abandoned", a.now)
    }

    case "PLAY_AGAIN":
      return newDuel(s.config, a.seed, a.now, s.dailyDate)

    case "EXIT":
      return { ...s, ...TRANSIENT, phase: "idle", deadline: null, pausedAt: null }

    case "RESUME": {
      // A reload lands wherever the tab died. Normalize the in-flight phases:
      // nothing is on the wire any more, and the player must never be charged
      // for a request whose answer was lost.
      const dead = s.lives <= 0
      let phase: DuelPhase = s.phase
      if (dead && phase !== "summary" && phase !== "idle") phase = "summary"
      else if (phase === "verifying" || phase === "rejected" || phase === "penalising" || phase === "disambiguating" || phase === "accepted") {
        phase = "awaiting"
      }
      const base: DuelState = {
        ...s,
        ...TRANSIENT,
        phase,
        outcome: dead ? "defeat" : s.phase === "summary" ? (s.outcome ?? null) : null,
        endedAt: phase === "summary" ? (s.endedAt ?? s.startedAt) : null,
      }
      if (phase === "awaiting") {
        // The clock is the whole difficulty lever of فحل and سيف — tiers that
        // client/duel/tiers.ts only offers while `timer` is on. Handing back a
        // fresh `turnSeconds` here made F5 an unlimited timer reset, at no life
        // and with the opponent's بيت still on the table (review finding). So:
        // carry the STORED deadline forward, plus a small fixed grace for the
        // reload itself, and never past a full turn.
        if (!s.config.timer || s.deadline === null) {
          return { ...base, ...startClock(base, a.now), deadline: null }
        }
        const left = liveRemaining(s, a.now)
        if (left <= 0) {
          // it ran out while the tab was shut: an ordinary timeout, not a gift
          return reduce({ ...base, turnStartedAt: a.now }, { type: "TIMEOUT", now: a.now })
        }
        const granted = Math.min(left + RESUME_GRACE_MS, s.config.turnSeconds * 1000)
        return { ...base, deadline: a.now + granted, pausedAt: null, turnStartedAt: a.now }
      }
      return { ...base, deadline: null, pausedAt: null }
    }
  }
}
