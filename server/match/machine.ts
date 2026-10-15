/**
 * `server/match/machine.ts` — the account-less مساجلة as a pure state machine.
 *
 * Plain data in, plain data out: no database, no sockets, no `Date.now()`, no
 * randomness. The clock arrives as `now`, a code is drawn through an injected
 * `rng`, and the one impure thing a turn needs — asking the corpus whether a
 * بيت exists — happens OUTSIDE: `verifyInputOf` says what to ask, the caller
 * runs `verifyAnswer` (server/game.ts, the same pipeline the account rooms and
 * the solo duel use), and `applyAnswer` folds the verifier's answer in.
 *
 * The rules are the account rooms' (server/rooms.ts), restated over a record
 * instead of SQL rows:
 *
 *  • TURN ORDER is the parity of the CHAIN (the opening بيت and every accepted
 *    one): opening → guest, then host, then guest… A strike is not part of the
 *    chain, so a miss does not pass the turn.
 *  • A STRIKE is exactly `wrong_letter` or `not_found` (ROOM_STRIKE_REASONS).
 *    It is recorded, re-arms the clock, and ends the match when the seat has
 *    spent `strikes`. Every other refusal is feedback and changes nothing.
 *  • THE CLOCK is a timestamp in the record. A turn that passes `deadlineAt`
 *    unanswered loses, whoever notices first (`settle`). A dropped socket is
 *    not an event here at all.
 *  • A WAITING match closes itself at `expiresAt`; an active match with no
 *    clock that nobody touches for `IDLE_TTL_MS` is closed without a winner.
 */
import {
  MAX_ROOM_TURNS,
  ROOM_STRIKE_REASONS,
  type BaitDto,
  type ChainMode,
  type ChainState,
  type GameVerifyRequest,
  type GameVerifyResponse,
  type RoomEndReason,
  type RoomSeat,
  type RoomTurnVerdict,
  type RoomVerdict,
} from "../../shared/schema.ts"
import type { MatchKnockView, MatchState, MatchStatus } from "../../shared/match.ts"
import { hashesEqual } from "./secrets.ts"

/** A waiting match nobody joins closes after this long. */
export const WAITING_TTL_MS = 30 * 60_000

/** An active match with no clock and no activity for this long is closed. */
export const IDLE_TTL_MS = 24 * 60 * 60_000

/** A finished match is kept this long for a late reload, then purged. */
export const DONE_TTL_MS = 24 * 60 * 60_000

/** How many refused knockers a match remembers (so they read «rejected»). */
const REFUSED_MAX = 8

// ─────────────────────────────────────────────────────────────────────────────
// The record
// ─────────────────────────────────────────────────────────────────────────────

export type SeatRecord = { secretHash: string; name: string | null; joinedAt: number }

export type TurnRecord = {
  turnNo: number
  seat: RoomSeat
  verdict: RoomTurnVerdict
  bait: BaitDto | null
  /** internal قصيدة id, for the no-repeat rule */
  poemId: number | null
  text: string | null
  playedAt: number
  msTaken: number | null
}

export type MatchRecord = {
  v: 1
  code: string
  status: MatchStatus
  mode: ChainMode
  timerS: number | null
  strikes: number
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  updatedAt: number
  expiresAt: number | null
  deadlineAt: number | null
  joinKeyHash: string | null
  host: SeatRecord
  guest: SeatRecord | null
  knock: { secretHash: string; name: string | null; at: number } | null
  refused: string[]
  turns: TurnRecord[]
  /** the chain state the next answer must satisfy */
  required: ChainState | null
  winner: RoomSeat | null
  endReason: RoomEndReason | null
  rev: number
}

export type Fail = { ok: false; code: string }
export type Ok<T> = { ok: true } & T

// ─────────────────────────────────────────────────────────────────────────────
// The code
// ─────────────────────────────────────────────────────────────────────────────

/** The account rooms' speakable shape: three consonant+vowel pairs. */
const CODE_CONSONANTS = "BDFHJKLMNRSTWZ"
const CODE_VOWELS = "AEIOU"

/** `rng(n)` returns an integer in [0, n). The service passes `crypto.randomInt`. */
export function newMatchCode(rng: (n: number) => number): string {
  let out = ""
  for (let i = 0; i < 3; i++) {
    out += CODE_CONSONANTS[rng(CODE_CONSONANTS.length)]
    out += CODE_VOWELS[rng(CODE_VOWELS.length)]
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a record
// ─────────────────────────────────────────────────────────────────────────────

export function other(seat: RoomSeat): RoomSeat {
  return seat === "host" ? "guest" : "host"
}

export function chainOf(m: MatchRecord): TurnRecord[] {
  return m.turns.filter((t) => t.verdict === "opening" || t.verdict === "ok")
}

/** The seat that owes a بيت — chain parity, never the row count. */
export function turnSeatOf(m: MatchRecord): RoomSeat {
  return chainOf(m).length % 2 === 1 ? "guest" : "host"
}

export function strikesSpent(m: MatchRecord, seat: RoomSeat): number {
  return m.turns.filter((t) => t.seat === seat && (ROOM_STRIKE_REASONS as readonly string[]).includes(t.verdict)).length
}

/** Which seat this secret digest holds, or null. Both seats are always compared. */
export function seatFor(m: MatchRecord, secretHash: string): RoomSeat | null {
  const host = hashesEqual(m.host.secretHash, secretHash)
  const guest = m.guest !== null && hashesEqual(m.guest.secretHash, secretHash)
  return host ? "host" : guest ? "guest" : null
}

/** When this record next needs attention: an expiry, a deadline, or its purge. */
export function dueAt(m: MatchRecord): number {
  if (m.status === "waiting") return m.expiresAt ?? m.updatedAt + WAITING_TTL_MS
  if (m.status === "active") return m.deadlineAt ?? m.updatedAt + IDLE_TTL_MS
  return (m.endedAt ?? m.updatedAt) + DONE_TTL_MS
}

export function isPurgeable(m: MatchRecord, now: number): boolean {
  return m.status === "done" && now >= dueAt(m)
}

function bump(m: MatchRecord, now: number, patch: Partial<MatchRecord>): MatchRecord {
  return { ...m, ...patch, updatedAt: now, rev: m.rev + 1 }
}

function end(m: MatchRecord, winner: RoomSeat | null, reason: RoomEndReason, now: number): MatchRecord {
  return bump(m, now, {
    status: "done",
    winner,
    endReason: reason,
    endedAt: now,
    deadlineAt: null,
    expiresAt: null,
    knock: null,
  })
}

function deadlineFrom(m: MatchRecord, now: number): number | null {
  return m.timerS === null ? null : now + m.timerS * 1000
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

export type CreateInput = {
  code: string
  hostSecretHash: string
  joinKeyHash: string
  hostName: string | null
  opening: { bait: BaitDto; poemId: number | null; chain: ChainState }
  mode: ChainMode
  timerS: number | null
  strikes: number
  now: number
}

/** A waiting match with the host seated and the opening بيت as turn 0. */
export function createMatch(input: CreateInput): MatchRecord {
  const { now } = input
  return {
    v: 1,
    code: input.code,
    status: "waiting",
    mode: input.mode,
    timerS: input.timerS,
    strikes: input.strikes,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    updatedAt: now,
    expiresAt: now + WAITING_TTL_MS,
    deadlineAt: null,
    joinKeyHash: input.joinKeyHash,
    host: { secretHash: input.hostSecretHash, name: input.hostName, joinedAt: now },
    guest: null,
    knock: null,
    refused: [],
    turns: [
      {
        turnNo: 0,
        seat: "host",
        verdict: "opening",
        bait: input.opening.bait,
        poemId: input.opening.poemId,
        text: null,
        playedAt: now,
        msTaken: null,
      },
    ],
    required: input.opening.chain,
    winner: null,
    endReason: null,
    rev: 0,
  }
}

/**
 * Resolve whatever time has decided: a waiting match past `expiresAt`, a turn
 * past `deadlineAt`, an unclocked match idle past `IDLE_TTL_MS`. Idempotent —
 * a second call on a settled record returns it unchanged.
 */
export function settle(m: MatchRecord, now: number): { match: MatchRecord; changed: boolean } {
  if (m.status === "waiting" && now >= (m.expiresAt ?? Number.POSITIVE_INFINITY)) {
    return { match: end(m, null, "abandoned", now), changed: true }
  }
  if (m.status === "active") {
    if (m.deadlineAt !== null && now >= m.deadlineAt) {
      return { match: end(m, other(turnSeatOf(m)), "timeout", now), changed: true }
    }
    if (m.deadlineAt === null && now >= m.updatedAt + IDLE_TTL_MS) {
      return { match: end(m, null, "abandoned", now), changed: true }
    }
  }
  return { match: m, changed: false }
}

function start(m: MatchRecord, guest: SeatRecord, now: number): MatchRecord {
  return bump(m, now, {
    status: "active",
    guest,
    startedAt: now,
    expiresAt: null,
    deadlineAt: deadlineFrom(m, now),
    joinKeyHash: null,
    knock: null,
  })
}

/** The guest takes the empty seat with the invite key. The clock starts. */
export function joinMatch(
  m: MatchRecord,
  input: { keyHash: string; secretHash: string; name: string | null; now: number },
): Ok<{ match: MatchRecord }> | Fail {
  if (m.status === "done") return { ok: false, code: "match_not_active" }
  if (m.status !== "waiting" || m.guest !== null) return { ok: false, code: "match_full" }
  if (!hashesEqual(m.joinKeyHash, input.keyHash)) return { ok: false, code: "needs_key" }
  const guest = { secretHash: input.secretHash, name: input.name, joinedAt: input.now }
  return { ok: true, match: start(m, guest, input.now) }
}

/** Someone with only the spoken code asks for the seat. One knocker at a time. */
export function knockMatch(
  m: MatchRecord,
  input: { secretHash: string; name: string | null; now: number },
): Ok<{ match: MatchRecord }> | Fail {
  if (m.status === "done") return { ok: false, code: "match_not_active" }
  if (m.status !== "waiting" || m.guest !== null) return { ok: false, code: "match_full" }
  if (hashesEqual(m.host.secretHash, input.secretHash)) return { ok: false, code: "cannot_knock" }
  if (m.knock !== null) return { ok: false, code: "match_busy" }
  return {
    ok: true,
    match: bump(m, input.now, { knock: { secretHash: input.secretHash, name: input.name, at: input.now } }),
  }
}

/** The host seats the knocker; his knock secret becomes the guest's seat. */
export function admitKnock(m: MatchRecord, seat: RoomSeat, now: number): Ok<{ match: MatchRecord }> | Fail {
  if (seat !== "host") return { ok: false, code: "not_the_host" }
  if (m.status !== "waiting") return { ok: false, code: m.status === "active" ? "match_full" : "match_not_active" }
  if (m.knock === null) return { ok: false, code: "no_knock" }
  const guest = { secretHash: m.knock.secretHash, name: m.knock.name, joinedAt: now }
  return { ok: true, match: start(m, guest, now) }
}

/** The host turns the knocker away; the seat stays open for the link. */
export function refuseKnock(m: MatchRecord, seat: RoomSeat, now: number): Ok<{ match: MatchRecord }> | Fail {
  if (seat !== "host") return { ok: false, code: "not_the_host" }
  if (m.knock === null) return { ok: false, code: "no_knock" }
  const refused = [m.knock.secretHash, ...m.refused].slice(0, REFUSED_MAX)
  return { ok: true, match: bump(m, now, { knock: null, refused }) }
}

/** What a knocker holding `secretHash` is told. */
export function knockView(m: MatchRecord, secretHash: string): MatchKnockView | null {
  const base = { code: m.code, hostName: m.host.name }
  if (m.guest !== null && hashesEqual(m.guest.secretHash, secretHash)) return { ...base, status: "accepted" }
  if (m.knock !== null && hashesEqual(m.knock.secretHash, secretHash)) {
    return { ...base, status: m.status === "waiting" ? "pending" : "rejected" }
  }
  if (m.refused.some((h) => hashesEqual(h, secretHash))) return { ...base, status: "rejected" }
  // A knocker whose knock vanished without a seat — the match started through
  // the link, or closed — is as turned away as one the host refused.
  return m.status === "waiting" ? null : { ...base, status: "rejected" }
}

/** «انسحب» on an active match; «أغلق» on a waiting one (host only). */
export function resignMatch(m: MatchRecord, seat: RoomSeat, now: number): Ok<{ match: MatchRecord }> | Fail {
  if (m.status === "done") return { ok: true, match: m }
  if (m.status === "waiting") {
    if (seat !== "host") return { ok: false, code: "not_the_host" }
    return { ok: true, match: end(m, null, "abandoned", now) }
  }
  return { ok: true, match: end(m, other(seat), "resign", now) }
}

// ─────────────────────────────────────────────────────────────────────────────
// A turn
// ─────────────────────────────────────────────────────────────────────────────

/** The verifier request this seat's answer must be judged by, or why it cannot. */
export function verifyInputOf(
  m: MatchRecord,
  seat: RoomSeat,
  text: string,
): Ok<{ request: GameVerifyRequest }> | Fail {
  if (m.status !== "active") return { ok: false, code: "match_not_active" }
  if (turnSeatOf(m) !== seat) return { ok: false, code: "not_your_turn" }
  const chain = chainOf(m)
  const last = chain[chain.length - 1]
  return {
    ok: true,
    request: {
      text,
      // The letter is read off the previous بيت by the verifier itself; the
      // client never sends one.
      prevBaitId: last?.bait?.id ?? undefined,
      requiredLetter: undefined,
      mode: m.mode,
      usedBaitIds: chain.map((t) => t.bait?.id).filter((id): id is number => typeof id === "number"),
      usedPoemIds: chain.map((t) => t.poemId).filter((id): id is number => typeof id === "number"),
      filters: undefined,
      sessionSeed: undefined,
    },
  }
}

export type AnswerOutcome = {
  match: MatchRecord
  verdict: RoomVerdict
  /** the transcript changed (an accepted بيت or a strike) */
  persisted: boolean
}

/**
 * Fold the verifier's answer into the match. The caller has just run
 * `verifyInputOf` on this same record, so turn and status are re-checked only
 * as a guard.
 */
export function applyAnswer(
  m: MatchRecord,
  input: { seat: RoomSeat; text: string; result: GameVerifyResponse; now: number },
): Ok<AnswerOutcome> | Fail {
  const { seat, text, result, now } = input
  if (m.status !== "active") return { ok: false, code: "match_not_active" }
  if (turnSeatOf(m) !== seat) return { ok: false, code: "not_your_turn" }

  const spent = strikesSpent(m, seat)
  const last = m.turns[m.turns.length - 1]
  // The clock for this turn started at the later of the last row and the join.
  const msTaken = Math.max(0, now - Math.max(last?.playedAt ?? 0, m.startedAt ?? m.createdAt))
  const turnNo = (last?.turnNo ?? -1) + 1

  if (result.ok) {
    const turn: TurnRecord = {
      turnNo,
      seat,
      verdict: "ok",
      bait: result.bait,
      poemId: result.bait.poem.poemId,
      text,
      playedAt: now,
      msTaken,
    }
    const required: ChainState = {
      requiredLetter: result.requiredLetter,
      requiredLetterSource: result.requiredLetterSource,
      alsoAccepted: result.alsoAccepted,
      mode: result.mode,
      obscurity: result.obscurity,
    }
    let next = bump(m, now, { turns: [...m.turns, turn], required, deadlineAt: deadlineFrom(m, now) })
    // A مساجلة neither side ever loses still has to stop somewhere.
    if (chainOf(next).length >= MAX_ROOM_TURNS) next = end(next, null, "abandoned", now)
    return {
      ok: true,
      match: next,
      persisted: true,
      verdict: { result, strike: false, strikesLeft: Math.max(0, m.strikes - spent) },
    }
  }

  if ((ROOM_STRIKE_REASONS as readonly string[]).includes(result.reason)) {
    const turn: TurnRecord = {
      turnNo,
      seat,
      verdict: result.reason as RoomTurnVerdict,
      bait: null,
      poemId: null,
      text,
      playedAt: now,
      msTaken,
    }
    const struck = spent + 1
    let next = bump(m, now, { turns: [...m.turns, turn], deadlineAt: deadlineFrom(m, now) })
    if (struck >= m.strikes) next = end(next, other(seat), "strikes", now)
    return {
      ok: true,
      match: next,
      persisted: true,
      verdict: { result, strike: true, strikesLeft: Math.max(0, m.strikes - struck) },
    }
  }

  return {
    ok: true,
    match: m,
    persisted: false,
    verdict: { result, strike: false, strikesLeft: Math.max(0, m.strikes - spent) },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The snapshot
// ─────────────────────────────────────────────────────────────────────────────

/** The record as `viewer` sees it. `connected` comes from whoever holds the sockets. */
export function snapshotOf(
  m: MatchRecord,
  viewer: RoomSeat,
  now: number,
  connected: { host: boolean; guest: boolean } = { host: false, guest: false },
): MatchState {
  const turnSeat = m.status === "active" ? turnSeatOf(m) : null
  const player = (seat: RoomSeat, rec: SeatRecord) => ({
    seat,
    name: rec.name,
    strikes: strikesSpent(m, seat),
    turns: m.turns.filter((t) => t.seat === seat && t.verdict === "ok").length,
    connected: connected[seat],
  })
  return {
    code: m.code,
    status: m.status,
    mode: m.mode,
    timerS: m.timerS,
    strikes: m.strikes,
    createdAt: m.createdAt,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    expiresAt: m.status === "waiting" ? m.expiresAt : null,
    you: { seat: viewer, canPlay: turnSeat !== null && turnSeat === viewer },
    host: player("host", m.host),
    guest: m.guest === null ? null : player("guest", m.guest),
    turns: m.turns.map((t) => ({
      turnNo: t.turnNo,
      seat: t.seat,
      verdict: t.verdict,
      bait: t.bait,
      text: t.text,
      playedAt: t.playedAt,
      msTaken: t.msTaken,
    })),
    turnSeat,
    required: m.status === "done" ? null : m.required,
    deadlineAt: m.status === "active" ? m.deadlineAt : null,
    serverNow: now,
    winner: m.winner,
    endReason: m.endReason,
    knock: viewer === "host" && m.status === "waiting" && m.knock !== null ? { name: m.knock.name } : null,
    rev: m.rev,
  }
}
