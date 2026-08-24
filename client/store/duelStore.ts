/**
 * The duel's driver: everything impure that `client/duel/machine.ts` refuses
 * to do — the clock, the network, localStorage, and the timed beats between
 * phases (design-ux.md §4.3).
 *
 * The split is strict. `machine.ts` decides WHAT the next state is; this file
 * decides WHEN and issues the requests. Views never call the API and never
 * compute state: they read `useDuel().session` and call the exported verbs.
 *
 * Persistence: the session is written to `qarid:v1:duel` (through the shared
 * `persist.ts`, so a corrupt payload is backed up rather than thrown at the
 * player) on every transition, and `initialSession()` rehydrates it via
 * `fromSlice`, which normalizes any phase that was mid-flight when the tab
 * closed and carries the STORED deadline forward — never a whole fresh turn,
 * which made F5 a free timer reset. `resumeSchedule()` then re-arms whatever
 * beat the dead tab owed: the deal that never landed, the opponent's reply, the
 * five-second dismissal of a lost-life card.
 *
 * Scheduling rules (one place, so the beats are auditable):
 *   dealing          → POST /api/game/start, once per entry
 *   accepted         → CONTINUE after the award animation (900ms)
 *   computerThinking → POST /api/game/reply behind a 700–1400ms «thinking» floor
 *   rejected(soft)   → RESOLVE after 1.2s (4s for `already_used`, whose card
 *                      carries a clickable «أرِني أين قيل»), except the cards
 *                      that need an answer (near_miss «اقبل هذا البيت», and
 *                      ambiguous, which is its own phase)
 *   penalising       → RESOLVE after 5s, or when the player dismisses the card;
 *                      a TIMEOUT card also asks /api/game/reply for the بيت
 *                      that would have worked («كان يصلح هذا:»)
 */
import { create } from "zustand"

import { firstLetterOf } from "../../shared/arabic.ts"
import { rngFrom } from "../../shared/rng.ts"
import {
  DuelSliceSchema,
  TrainingSliceSchema,
  type ArabicLetter,
  type BaitDto,
  type DuelConfig,
  type HintKind,
  type ProfileSlice,
  ProfileSliceSchema,
  type TrainingSlice,
} from "../../shared/schema.ts"
import { ApiError } from "../api/client.ts"
import { gameHint, gameReply, gameStart, gameVerify } from "../api/queries.ts"
import {
  currentBait,
  fromSlice,
  letterChain,
  newDuel,
  playerTurns,
  reduce,
  replyLetter,
  toSlice,
  type DuelAction,
  type DuelState,
  type Rejection,
  type ServedBait,
} from "../duel/machine.ts"
import { pricedHint } from "../duel/scoring.ts"
import { clearSlice, flushNow, loadSlice, saveSlice } from "../persist.ts"

// ── store ───────────────────────────────────────────────────────────────────

type DuelStore = { session: DuelState | null }

/** The persisted session, rehydrated — or null when no مساجلة is in progress. */
function initialSession(): DuelState | null {
  const slice = loadSlice("duel", DuelSliceSchema, { session: null })
  if (!slice.session) return null
  try {
    return fromSlice(slice.session, Date.now())
  } catch {
    return null
  }
}

export const useDuel = create<DuelStore>()(() => ({ session: initialSession() }))

/** Non-reactive read, for the router guards and the effect callbacks. */
export function duelSession(): DuelState | null {
  return useDuel.getState().session
}

// ── scheduling ──────────────────────────────────────────────────────────────

let timers: ReturnType<typeof setTimeout>[] = []
/** Bumped on every accepted transition; a stale callback checks it and exits. */
let epoch = 0
/** Identity of the last phase entry that fired a request — never fire twice. */
let netKey: string | null = null

function clearTimers(): void {
  for (const t of timers) clearTimeout(t)
  timers = []
}

function later(ms: number, fn: () => void): void {
  const mine = epoch
  timers.push(
    setTimeout(() => {
      if (mine === epoch) fn()
    }, ms),
  )
}

/** One transition: reduce, publish, persist, then schedule what follows. */
export function dispatch(action: DuelAction): void {
  const cur = useDuel.getState().session
  if (!cur) return
  const next = reduce(cur, action)
  if (next === cur) return
  epoch++
  clearTimers()
  useDuel.setState({ session: next })
  persist(next)
  schedule(next)
}

function persist(s: DuelState | null): void {
  saveSlice("duel", { session: s === null ? null : toSlice(s) })
}

/** `phase|exchanges|lives|lastResult` — a new entry, not just a re-render. */
function entryKey(s: DuelState): string {
  return `${s.startedAt}|${s.phase}|${s.exchanges.length}|${s.lives}|${s.lastResult?.at ?? 0}`
}

/**
 * Rejections the player has to answer stay on screen until they do — no timer
 * dismisses them. They are NOT a lock on the field: typing a fresh بيت and
 * pressing «أجب» goes straight through `RESUBMIT` (see `submitAnswer`), and the
 * clock they pause is credited back only up to `MAX_PAUSE_CREDIT_MS`.
 */
function needsAnswer(r: Rejection | null): boolean {
  return r?.kind === "near_miss"
}

/**
 * How long a soft rejection stays up. 1.2 s is a toast — long enough to read
 * «هذا البيت يبدأ بـم والمطلوب ن» and no longer. `already_used` is the one soft
 * card that carries a CONTROL («أرِني أين قيل» scrolls to the exchange that
 * already said it), and a button that disappears in 1.2 s is a button nobody
 * can press — so that card gets four seconds. Typing dismisses either early,
 * and the clock is paused throughout, so the extra time is not an advantage
 * the player can farm beyond one turn.
 */
const SOFT_REJECT_MS = 1200
const SOFT_REJECT_ACTIONABLE_MS = 4000

function softRejectMs(r: Rejection | null): number {
  return r?.kind === "already_used" ? SOFT_REJECT_ACTIONABLE_MS : SOFT_REJECT_MS
}

function schedule(s: DuelState): void {
  const key = entryKey(s)
  switch (s.phase) {
    case "dealing": {
      if (netKey === key) return
      netKey = key
      void deal(s)
      return
    }
    case "accepted":
      later(900, () => dispatch({ type: "CONTINUE", now: Date.now() }))
      return
    case "computerThinking": {
      if (netKey === key || s.error !== null) return
      netKey = key
      void answer(s)
      return
    }
    case "rejected":
      if (needsAnswer(s.rejection)) return
      later(softRejectMs(s.rejection), () => dispatch({ type: "RESOLVE", now: Date.now() }))
      return
    case "penalising":
      // «كان يصلح هذا:» — asked for once, from whichever path produced the
      // timeout (the ticking clock, or a RESUME that found the turn expired)
      if (s.rejection?.kind === "timeout" && !s.rejection.bait) void consolation(s)
      later(5000, () => dispatch({ type: "RESOLVE", now: Date.now() }))
      return
    case "summary":
      recordProfile(s)
      flushNow()
      return
    default:
  }
}

// ── the three requests ──────────────────────────────────────────────────────

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "تعذّر الاتصال بالخادم"
}

async function deal(s: DuelState): Promise<void> {
  const mine = epoch
  try {
    const res = await gameStart({
      difficulty: s.config.difficulty,
      mode: s.config.chainMode,
      filters: s.config.filters,
      ...(s.dailyDate ? { seed: `daily:${s.dailyDate}` } : {}),
    })
    if (mine !== epoch) return
    if (res.ok) dispatch({ type: "DEALT", served: served(res), now: Date.now() })
    else dispatch({ type: "DEAL_FAILED", message: "لا أبيات بهذه القيود — خفّف القيود ثم أعد", now: Date.now() })
  } catch (e) {
    if (mine !== epoch) return
    dispatch({ type: "DEAL_FAILED", message: errorText(e), now: Date.now() })
  }
}

/** The opponent's turn: a floor on the reply so it reads as thinking, not lag. */
async function answer(s: DuelState): Promise<void> {
  const mine = epoch
  const letter = replyLetter(s)
  if (letter === null) {
    dispatch({ type: "REPLY_ERROR", message: "لا حرف للجواب", now: Date.now() })
    return
  }
  const turn = playerTurns(s)
  const rng = rngFrom(`${s.seed}:think:${turn}`)
  const floor = 700 + Math.floor(rng() * 700)
  const began = Date.now()
  try {
    const res = await gameReply({
      letter: letter as ArabicLetter,
      difficulty: s.config.difficulty,
      mode: s.config.chainMode,
      tailBias: s.config.tailBias,
      excludeBaitIds: s.usedBaitIds,
      excludePoemIds: s.usedPoemIds,
      filters: s.config.filters,
      ...(s.dailyDate ? { seed: `daily:${s.dailyDate}:${turn}` } : {}),
    })
    if (mine !== epoch) return
    const wait = Math.max(0, floor - (Date.now() - began))
    later(wait, () => {
      if (res.ok) dispatch({ type: "REPLIED", served: served(res), now: Date.now() })
      else dispatch({ type: "NO_REPLY", letter: res.letter, now: Date.now() })
    })
  } catch (e) {
    if (mine !== epoch) return
    dispatch({ type: "REPLY_ERROR", message: errorText(e), now: Date.now() })
  }
}

/** Strip the envelope off a start/reply payload — the chain state is inside. */
function served(res: { bait: BaitDto } & Omit<ServedBait, "bait">): ServedBait {
  return {
    bait: res.bait,
    poem: res.poem,
    poet: res.poet,
    requiredLetter: res.requiredLetter,
    requiredLetterSource: res.requiredLetterSource,
    alsoAccepted: res.alsoAccepted,
    mode: res.mode,
    obscurity: res.obscurity,
  }
}

async function verify(s: DuelState, text: string): Promise<void> {
  const mine = epoch
  const prev = currentBait(s)
  try {
    const res = await gameVerify({
      text,
      prevBaitId: prev?.baitId ?? undefined,
      requiredLetter: s.required.letter ?? undefined,
      mode: s.config.chainMode,
      usedBaitIds: s.usedBaitIds,
      usedPoemIds: s.usedPoemIds,
      filters: s.config.filters,
      sessionSeed: s.seed,
    })
    if (mine !== epoch) return
    dispatch({ type: "VERIFIED", response: res, now: Date.now() })
  } catch (e) {
    if (mine !== epoch) return
    dispatch({ type: "VERIFY_ERROR", message: errorText(e), now: Date.now() })
  }
}

// ── verbs the views call ────────────────────────────────────────────────────

/** Seed for the whole session — the daily chain is shared, a duel is not. */
function seedFor(config: DuelConfig, startedAt: number, daily: string | null): string {
  if (daily) return `daily:${daily}`
  return `duel:${startedAt}:${config.tier}:${config.chainMode}:${config.format}`
}

export function startDuel(config: DuelConfig, daily: string | null = null): void {
  snapshotBefore()
  clearTimers()
  epoch++
  netKey = null
  const now = Date.now()
  const fresh = newDuel(config, seedFor(config, now, daily), now, daily)
  useDuel.setState({ session: fresh })
  persist(fresh)
  schedule(fresh)
}

export function setDraft(text: string): void {
  const s = useDuel.getState().session
  if (!s) return
  // Typing acknowledges a soft rejection: the card closes and the clock resumes.
  if (s.phase === "rejected" && !needsAnswer(s.rejection)) dispatch({ type: "RESOLVE", now: Date.now() })
  dispatch({ type: "DRAFT", text })
}

/**
 * «أجب» / Enter, from whatever the last answer left on screen.
 *
 * The field is live under a card as well as without one, and this is where that
 * is honoured: a `near_miss` or an ambiguity card is DISMISSED by answering
 * again (`RESUBMIT`), and a lost-life card is resolved first and the fresh turn
 * answered in the same gesture. Before this, retyping a perfectly good بيت
 * under a near-miss card did nothing at all — no toast, no shake, no request.
 */
export function submitAnswer(text?: string): void {
  const s = useDuel.getState().session
  if (!s) return
  const answerText = (text ?? s.draft).trim()
  if (!answerText) return

  // a card that needs an answer is up: answering again replaces it
  if (s.phase === "rejected" || s.phase === "disambiguating") {
    dispatch({ type: "RESUBMIT", text: answerText, penalty: 0, now: Date.now() })
    const after = useDuel.getState().session
    if (after && after.phase === "verifying") void verify(after, answerText)
    return
  }

  // a life was just spent; the card is dismissible and the next turn is owed
  if (s.phase === "penalising") {
    dispatch({ type: "RESOLVE", now: Date.now() })
    const opened = useDuel.getState().session
    if (!opened || opened.phase !== "awaiting") return
    dispatch({ type: "SUBMIT", text: answerText, now: Date.now() })
    const after = useDuel.getState().session
    if (after && after.phase === "verifying") void verify(after, answerText)
    return
  }

  if (s.phase !== "awaiting") return
  dispatch({ type: "SUBMIT", text: answerText, now: Date.now() })
  const after = useDuel.getState().session
  if (after && after.phase === "verifying") void verify(after, answerText)
}

/** «هل تقصد؟» / the ambiguity chips / «اقبل هذا البيت» all land here. */
export function resubmitBait(bait: BaitDto, penalty = 0): void {
  const s = useDuel.getState().session
  if (!s) return
  const text = bait.ajuz ? `${bait.sadr} … ${bait.ajuz}` : bait.sadr
  if (s.phase === "awaiting") {
    submitAnswer(text)
    return
  }
  dispatch({ type: "RESUBMIT", text, penalty, now: Date.now() })
  const after = useDuel.getState().session
  if (after && after.phase === "verifying") void verify(after, text)
}

export function cancelDisambiguation(): void {
  dispatch({ type: "CANCEL", now: Date.now() })
}

/** Dismiss whatever card is showing — «تابع» on a lost life, or a soft toast. */
export function resolveRejection(): void {
  dispatch({ type: "RESOLVE", now: Date.now() })
}

export function tick(): void {
  const s = useDuel.getState().session
  if (!s || s.phase !== "awaiting") return
  dispatch({ type: "TICK", now: Date.now() })
}

/**
 * «كان يصلح هذا:» — the one thing a timeout can teach.
 *
 * The card must be on screen the instant the clock hits zero, so the بيت that
 * would have worked is fetched AFTER the fact and folded in by `TIMEOUT_BAIT`.
 * It is asked for exactly the way the opponent asks for its own reply, on the
 * letter the player owed, and it is never marked used: it was never said.
 */
async function consolation(s: DuelState): Promise<void> {
  const mine = epoch
  const letter = s.required.letter
  if (!letter) return
  try {
    const res = await gameReply({
      letter: letter as ArabicLetter,
      difficulty: s.config.difficulty,
      mode: s.config.chainMode,
      tailBias: s.config.tailBias,
      excludeBaitIds: s.usedBaitIds,
      excludePoemIds: s.usedPoemIds,
      filters: s.config.filters,
    })
    if (mine !== epoch || !res.ok) return
    dispatch({ type: "TIMEOUT_BAIT", bait: res.bait })
  } catch {
    /* a consolation that never arrived is simply not shown */
  }
}

export function abandonDuel(): void {
  dispatch({ type: "ABANDON", now: Date.now() })
}

export function playAgain(): void {
  const s = useDuel.getState().session
  if (!s) return
  snapshotBefore()
  epoch++
  netKey = null
  clearTimers()
  const now = Date.now()
  const fresh = reduce(s, { type: "PLAY_AGAIN", seed: seedFor(s.config, now, s.dailyDate), now })
  useDuel.setState({ session: fresh })
  persist(fresh)
  schedule(fresh)
}

/**
 * Re-arm the beat the dead tab owed. `initialSession()` rehydrates state but
 * schedules nothing, so a session that died in `dealing`, `computerThinking` or
 * `penalising` came back frozen: no request in flight and no timer to dismiss
 * the card. The play view calls this once on mount.
 */
export function resumeSchedule(): void {
  const s = useDuel.getState().session
  if (!s) return
  schedule(s)
}

export function exitDuel(): void {
  epoch++
  clearTimers()
  netKey = null
  useDuel.setState({ session: null })
  clearSlice("duel")
}

export function retryDeal(): void {
  netKey = null
  dispatch({ type: "RETRY", now: Date.now() })
}

/** The opponent's reply failed on the network — ask again. */
export function retryReply(): void {
  const s = useDuel.getState().session
  if (!s || s.phase !== "computerThinking") return
  dispatch({ type: "RETRY", now: Date.now() })
  const after = useDuel.getState().session
  if (after) {
    netKey = entryKey(after)
    void answer(after)
  }
}

// ── hints ───────────────────────────────────────────────────────────────────

/**
 * Hints describe a بيت that WOULD answer, not the بيت on screen, and a stable
 * seed per exchange makes the three cheap ones describe ONE بيت — which is the
 * whole point of paying for the second and the third.
 */
export async function buyHint(kind: HintKind): Promise<void> {
  const s = useDuel.getState().session
  if (!s || s.phase !== "awaiting") return
  if (s.hints.includes(kind)) return
  const cost = pricedHint(kind, s.config.tier)
  const prev = currentBait(s)
  const seed = `${s.seed}:hint:${s.exchanges.length}`
  try {
    const res = await gameHint({
      kind,
      baitId: prev?.baitId ?? undefined,
      letter: s.required.letter ?? undefined,
      difficulty: s.config.difficulty,
      filters: s.config.filters,
      seed,
    })
    if (!res.ok) return
    const now = Date.now()
    if (res.kind === "switch_letter") {
      dispatch({ type: "HINT_SWITCH", served: served(res), cost, now })
      return
    }
    const reveal =
      res.kind === "poet"
        ? { poet: res.poet.name }
        : res.kind === "first_word"
          ? { firstWord: res.firstWord }
          : { meter: res.meter?.name ?? null }
    dispatch({ type: "HINT", kind, cost, reveal, now })
  } catch {
    /* a hint that never arrived is never charged */
  }
}

// ── what the player knew BEFORE this مساجلة ────────────────────────────────

/**
 * The summary marks a شاعر «جديد عليك» and a حرف as newly added to the
 * arsenal, which is only answerable against a snapshot taken BEFORE the duel
 * — `recordProfile` merges this duel's poets into the profile the moment the
 * summary opens, and after that the question cannot be asked of storage.
 *
 * The snapshot is refreshed on every start (so a second duel in the same tab
 * does not call duel one's شعراء new) and at module load (so a resumed session
 * after a reload compares against the same thing it would have).
 */
let metBefore: ReadonlySet<string> = new Set()
let lettersBefore: ReadonlySet<string> = new Set()

function snapshotBefore(): void {
  const profile = loadSlice("profile", ProfileSliceSchema, ProfileSliceSchema.parse({}))
  metBefore = new Set(profile.poetsMet)
  const training = loadSlice("training", TrainingSliceSchema, TrainingSliceSchema.parse({}))
  lettersBefore = new Set(
    Object.entries(training.arsenal)
      .filter(([, cell]) => (cell?.used ?? 0) > 0)
      .map(([letter]) => letter),
  )
}
snapshotBefore()

/** Poet slugs already met before the current مساجلة began. */
export function poetsMetBefore(): ReadonlySet<string> {
  return metBefore
}

/** Letters already in the arsenal before the current مساجلة began. */
export function arsenalLettersBefore(): ReadonlySet<string> {
  return lettersBefore
}

// ── profile / arsenal bookkeeping (design-ux.md §4 summary) ─────────────────

let recorded: string | null = null

/**
 * Written once per finished duel, straight through `persist.ts`: the profile
 * slice powers «لقيت 47 شاعرًا من 2400» on the summary, and the training
 * slice's arsenal counts the letters this مساجلة actually used (مستعمَل).
 */
function recordProfile(s: DuelState): void {
  const key = `${s.startedAt}:${s.exchanges.length}`
  if (recorded === key) return
  recorded = key

  const profile = loadSlice("profile", ProfileSliceSchema, ProfileSliceSchema.parse({}))
  const met = new Set(profile.poetsMet)
  for (const e of s.exchanges) if (e.poet) met.add(e.poet.slug)
  const next: ProfileSlice = {
    ...profile,
    gamesPlayed: profile.gamesPlayed + 1,
    abyatPlayed: profile.abyatPlayed + playerTurns(s),
    bestStreak: Math.max(profile.bestStreak, s.best),
    bestScore: Math.max(profile.bestScore, s.score),
    poetsMet: [...met],
    firstSeenAt: profile.firstSeenAt || s.startedAt,
    ...(s.dailyDate
      ? {
          dailyResults: {
            ...profile.dailyResults,
            [s.dailyDate]: {
              date: s.dailyDate,
              score: s.score,
              chainLength: playerTurns(s),
              letters: letterChain(s).map((l) => l.letter) as ArabicLetter[],
              completedAt: s.endedAt ?? Date.now(),
            },
          },
        }
      : {}),
  }
  saveSlice("profile", next)

  const training = loadSlice("training", TrainingSliceSchema, TrainingSliceSchema.parse({}))
  const arsenal = { ...training.arsenal }
  for (const e of s.exchanges) {
    if (e.side !== "player") continue
    const letter = firstLetterUsed(e.sadr)
    if (!letter) continue
    const cell = arsenal[letter] ?? { used: 0, mastered: 0, lastAt: null }
    arsenal[letter] = { ...cell, used: cell.used + 1, lastAt: s.endedAt ?? Date.now() }
  }
  const nextTraining: TrainingSlice = { ...training, arsenal }
  saveSlice("training", nextTraining)
  flushNow()
}

/**
 * Record the finished مساجلة if it has not been recorded already.
 *
 * `schedule()` calls `recordProfile` on the TRANSITION into the summary, which
 * covers a duel played through in one sitting. It does not cover a session
 * REHYDRATED at the summary — a reload, or a tab reopened the next morning —
 * because nothing dispatches on resume. The summary view therefore calls this
 * on mount, and the `recorded` key makes the second call a no-op. Without it
 * the ترسانة silently loses every duel the player did not watch land.
 */
export function recordFinishedDuel(): void {
  const s = useDuel.getState().session
  if (!s || s.phase !== "summary") return
  recordProfile(s)
}

/** The letter the player's بيت actually opened on — the ONE normalizer. */
function firstLetterUsed(sadr: string): ArabicLetter | null {
  return firstLetterOf(sadr) as ArabicLetter | null
}

// ── profile reads the summary needs ─────────────────────────────────────────

export function loadProfile(): ProfileSlice {
  return loadSlice("profile", ProfileSliceSchema, ProfileSliceSchema.parse({}))
}
