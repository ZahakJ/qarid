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
 * player) on every transition, and `resumeDuel()` rehydrates it via
 * `fromSlice`, which normalizes any phase that was mid-flight when the tab
 * closed. A refresh therefore resumes the مساجلة with a whole fresh turn and
 * never a lost life.
 *
 * Scheduling rules (one place, so the beats are auditable):
 *   dealing          → POST /api/game/start, once per entry
 *   accepted         → CONTINUE after the award animation (900ms)
 *   computerThinking → POST /api/game/reply behind a 700–1400ms «thinking» floor
 *   rejected(soft)   → RESOLVE after 1.2s, except the cards that need an answer
 *                      (near_miss «اقبل هذا البيت», and ambiguous, which is its
 *                      own phase)
 *   penalising       → RESOLVE after 5s, or when the player dismisses the card
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

/** Rejections the player has to answer stay on screen until they do. */
function needsAnswer(r: Rejection | null): boolean {
  return r?.kind === "near_miss"
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
      later(1200, () => dispatch({ type: "RESOLVE", now: Date.now() }))
      return
    case "penalising":
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

export function submitAnswer(text?: string): void {
  const s = useDuel.getState().session
  if (!s || s.phase !== "awaiting") return
  const answerText = (text ?? s.draft).trim()
  if (!answerText) return
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
 * slice powers «لقيت ٤٧ شاعرًا من ٢٤٠٠» on the summary, and the training
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

/** The letter the player's بيت actually opened on — the ONE normalizer. */
function firstLetterUsed(sadr: string): ArabicLetter | null {
  return firstLetterOf(sadr) as ArabicLetter | null
}

// ── profile reads the summary needs ─────────────────────────────────────────

export function loadProfile(): ProfileSlice {
  return loadSlice("profile", ProfileSliceSchema, ProfileSliceSchema.parse({}))
}
