/**
 * `server/match/service.ts` — the account-less مساجلة wired to the world: the
 * corpus (for the opening بيت and the verifier), the store, the sockets and
 * the clock. Every decision is the pure machine's (`./machine.ts`); this file
 * loads, settles, asks the verifier, saves, re-arms and tells whoever is
 * connected. HTTP and WebSocket both call the functions below, so there is one
 * path whichever transport a player happens to have.
 *
 * Everything here is synchronous between reading a record and writing it back
 * — `verifyAnswer` included — so on one event loop no two requests can
 * interleave inside a transition. A route that awaits its body loads the
 * record AFTER the await.
 */
import { randomInt } from "node:crypto"

import type { RoomSeat, RoomVerdict } from "../../shared/schema.ts"
import { MatchSecretSchema, type MatchEvent, type MatchKnockView, type MatchState } from "../../shared/match.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { num } from "../dto.ts"
import { servedBait, verifyAnswer } from "../game.ts"
import { createRateLimiter, type RateLimiter } from "../ratelimit.ts"
import { baitRow, isPlayableBait, randomStartingBait } from "../rooms.ts"
import {
  admitKnock,
  applyAnswer,
  createMatch,
  isPurgeable,
  joinMatch,
  knockMatch,
  knockView,
  newMatchCode,
  refuseKnock,
  resignMatch,
  seatFor,
  settle,
  snapshotOf,
  verifyInputOf,
  type MatchRecord,
} from "./machine.ts"
import { hashSecret, newJoinKey, newSeatSecret } from "./secrets.ts"
import type { MatchStore } from "./store.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Sockets and timers
// ─────────────────────────────────────────────────────────────────────────────

export type MatchConn = { seat: RoomSeat; send: (event: MatchEvent) => void }

/** Sockets one seat may hold on one match — a phone, a laptop and a reload. */
export const MAX_SOCKETS_PER_SEAT = 4

/**
 * Who is connected, and each match's timer. Not a source of truth: a restart
 * empties it and every match carries on from the store.
 */
export class MatchHub {
  private conns = new Map<string, Set<MatchConn>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  add(code: string, conn: MatchConn): boolean {
    let set = this.conns.get(code)
    if (!set) {
      set = new Set()
      this.conns.set(code, set)
    }
    let mine = 0
    for (const c of set) if (c.seat === conn.seat) mine += 1
    if (mine >= MAX_SOCKETS_PER_SEAT) return false
    set.add(conn)
    return true
  }

  remove(code: string, conn: MatchConn): void {
    const set = this.conns.get(code)
    if (!set) return
    set.delete(conn)
    if (set.size === 0) this.conns.delete(code)
  }

  connections(code: string): MatchConn[] {
    return [...(this.conns.get(code) ?? [])]
  }

  connected(code: string): { host: boolean; guest: boolean } {
    const out = { host: false, guest: false }
    for (const c of this.conns.get(code) ?? []) out[c.seat] = true
    return out
  }

  /** (Re)arm a match's timer; `unref` so it never holds a process open. */
  arm(code: string, at: number | null, now: number, fire: (code: string) => void): void {
    this.disarm(code)
    if (at === null) return
    const t = setTimeout(() => {
      this.timers.delete(code)
      fire(code)
    }, Math.min(Math.max(0, at - now) + 40, 2 ** 31 - 1))
    t.unref?.()
    this.timers.set(code, t)
  }

  disarm(code: string): void {
    const t = this.timers.get(code)
    if (t) clearTimeout(t)
    this.timers.delete(code)
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.conns.clear()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type MatchDeps = {
  db: Db
  config: Config
  store: MatchStore
  hub: MatchHub
  now: () => number
  rng: (n: number) => number
  /** every inbound socket frame, keyed on match + seat */
  socketLimiter: RateLimiter
  stop: () => void
}

/** What one seat may send over its sockets in ten seconds. */
export const MATCH_SOCKET_FRAME_LIMIT = { tokens: 20, windowMs: 10_000 } as const

/** How often the sweeper looks for expired and purgeable matches. */
export const SWEEP_MS = 60_000

export function matchDeps(
  db: Db,
  config: Config,
  store: MatchStore,
  opts: { now?: () => number; rng?: (n: number) => number; sweep?: boolean } = {},
): MatchDeps {
  const hub = new MatchHub()
  let sweeper: ReturnType<typeof setInterval> | null = null
  const deps: MatchDeps = {
    db,
    config,
    store,
    hub,
    now: opts.now ?? (() => Date.now()),
    rng: opts.rng ?? ((n) => randomInt(n)),
    socketLimiter: createRateLimiter({ ...MATCH_SOCKET_FRAME_LIMIT }),
    stop: () => {
      if (sweeper) clearInterval(sweeper)
      sweeper = null
      hub.clear()
    },
  }
  // A restart keeps the matches; their clocks come back here.
  for (const code of store.live()) {
    const m = loadMatch(deps, code)
    if (m) armMatch(deps, m)
  }
  if (opts.sweep !== false) {
    sweeper = setInterval(() => sweepMatches(deps), SWEEP_MS)
    sweeper.unref?.()
  }
  return deps
}

// ─────────────────────────────────────────────────────────────────────────────
// Plumbing
// ─────────────────────────────────────────────────────────────────────────────

export function snapshotFor(deps: MatchDeps, m: MatchRecord, seat: RoomSeat): MatchState {
  return snapshotOf(m, seat, deps.now(), deps.hub.connected(m.code))
}

/** Each socket gets its OWN seat's snapshot — `you` differs per seat. */
export function broadcast(
  deps: MatchDeps,
  m: MatchRecord,
  make: (state: MatchState) => MatchEvent,
  except?: MatchConn,
): void {
  const now = deps.now()
  const connected = deps.hub.connected(m.code)
  for (const conn of deps.hub.connections(m.code)) {
    if (conn === except) continue
    try {
      conn.send(make(snapshotOf(m, conn.seat, now, connected)))
    } catch {
      /* a socket that throws on send is already gone */
    }
  }
}

function onTimer(deps: MatchDeps, code: string): void {
  const m = loadMatch(deps, code)
  if (m) armMatch(deps, m)
}

/** Arm the one timer a match needs: its waiting expiry or its turn deadline. */
export function armMatch(deps: MatchDeps, m: MatchRecord): void {
  const at = m.status === "waiting" ? m.expiresAt : m.status === "active" ? m.deadlineAt : null
  deps.hub.arm(m.code, at, deps.now(), (code) => onTimer(deps, code))
}

/** Save, re-arm. */
function commit(deps: MatchDeps, m: MatchRecord): void {
  deps.store.put(m)
  armMatch(deps, m)
}

/**
 * Read a match and resolve whatever time has decided since it was written.
 * Called by every request, every socket open and every timer, because the
 * timer is the one of those a restart can lose.
 */
export function loadMatch(deps: MatchDeps, code: string): MatchRecord | null {
  const m = deps.store.get(code.toUpperCase())
  if (!m) return null
  const { match, changed } = settle(m, deps.now())
  if (changed) {
    commit(deps, match)
    broadcast(deps, match, (state) => ({ type: "end", state }))
  }
  return match
}

/** Expire what is due, purge what is old. */
export function sweepMatches(deps: MatchDeps): void {
  const now = deps.now()
  for (const code of deps.store.due(now)) {
    const m = deps.store.get(code)
    if (!m) continue
    if (isPurgeable(m, now)) {
      deps.store.delete(code)
      deps.hub.disarm(code)
      continue
    }
    loadMatch(deps, code)
  }
}

/** The seat a client's secret holds, or null. Malformed secrets never reach a hash. */
export function seatOfSecret(m: MatchRecord, secret: string | null | undefined): RoomSeat | null {
  if (!secret || !MatchSecretSchema.safeParse(secret).success) return null
  return seatFor(m, hashSecret(secret))
}

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

type Fail = { ok: false; code: string; match?: MatchRecord }

export type CreateOptions = {
  name: string | null
  baitId?: number
  mode: MatchRecord["mode"]
  timerS: number | null
  strikes: number
}

export function shareUrlFor(config: Config, code: string, joinKey: string): string {
  const origin = config.publicOrigin.replace(/\/+$/, "")
  return `${origin}/#/match/${code}?k=${encodeURIComponent(joinKey)}`
}

export function createFor(
  deps: MatchDeps,
  opts: CreateOptions,
): { ok: true; match: MatchRecord; secret: string; joinKey: string } | Fail {
  let row
  if (opts.baitId !== undefined) {
    if (!isPlayableBait(deps.db, opts.baitId)) return { ok: false, code: "bad_bait" }
    row = baitRow(deps.db, opts.baitId)
    if (row === null) return { ok: false, code: "bad_bait" }
  } else {
    row = randomStartingBait(deps.db)
    if (row === null) return { ok: false, code: "no_bait" }
  }
  const served = servedBait(row, opts.mode)
  const secret = newSeatSecret()
  const joinKey = newJoinKey()
  const now = deps.now()
  for (let attempt = 0; attempt < 8; attempt++) {
    const match = createMatch({
      code: newMatchCode(deps.rng),
      hostSecretHash: hashSecret(secret),
      joinKeyHash: hashSecret(joinKey),
      hostName: opts.name,
      opening: {
        bait: served.bait,
        poemId: num(row.p_id),
        chain: {
          requiredLetter: served.requiredLetter,
          requiredLetterSource: served.requiredLetterSource,
          alsoAccepted: served.alsoAccepted,
          mode: served.mode,
          obscurity: served.obscurity,
        },
      },
      mode: opts.mode,
      timerS: opts.timerS,
      strikes: opts.strikes,
      now,
    })
    if (deps.store.insert(match)) {
      armMatch(deps, match)
      return { ok: true, match, secret, joinKey }
    }
  }
  throw new Error("could not allocate a match code")
}

export function joinFor(
  deps: MatchDeps,
  code: string,
  key: string,
  name: string | null,
): { ok: true; match: MatchRecord; secret: string } | Fail {
  const m = loadMatch(deps, code)
  if (!m) return { ok: false, code: "match_not_found" }
  const secret = newSeatSecret()
  const out = joinMatch(m, { keyHash: hashSecret(key), secretHash: hashSecret(secret), name, now: deps.now() })
  if (!out.ok) return out
  commit(deps, out.match)
  broadcast(deps, out.match, (state) => ({ type: "join", state }))
  return { ok: true, match: out.match, secret }
}

export function knockFor(
  deps: MatchDeps,
  code: string,
  name: string | null,
): { ok: true; match: MatchRecord; secret: string; view: MatchKnockView } | Fail {
  const m = loadMatch(deps, code)
  if (!m) return { ok: false, code: "match_not_found" }
  const secret = newSeatSecret()
  const hash = hashSecret(secret)
  const out = knockMatch(m, { secretHash: hash, name, now: deps.now() })
  if (!out.ok) return out
  commit(deps, out.match)
  broadcast(deps, out.match, (state) => ({ type: "state", state }))
  return { ok: true, match: out.match, secret, view: knockView(out.match, hash)! }
}

export function knockStatusFor(deps: MatchDeps, code: string, secret: string | null): { ok: true; view: MatchKnockView } | Fail {
  const m = loadMatch(deps, code)
  if (!m) return { ok: false, code: "match_not_found" }
  if (!secret || !MatchSecretSchema.safeParse(secret).success) return { ok: false, code: "wrong_secret" }
  const view = knockView(m, hashSecret(secret))
  return view ? { ok: true, view } : { ok: false, code: "wrong_secret" }
}

/** Load + authenticate: the match and the caller's seat, or why not. */
export function seated(
  deps: MatchDeps,
  code: string,
  secret: string | null,
): { ok: true; match: MatchRecord; seat: RoomSeat } | Fail {
  const m = loadMatch(deps, code)
  if (!m) return { ok: false, code: "match_not_found" }
  const seat = seatOfSecret(m, secret)
  if (seat === null) return { ok: false, code: "wrong_secret" }
  return { ok: true, match: m, seat }
}

export function admitFor(deps: MatchDeps, code: string, secret: string | null): { ok: true; match: MatchRecord; seat: RoomSeat } | Fail {
  const who = seated(deps, code, secret)
  if (!who.ok) return who
  const out = admitKnock(who.match, who.seat, deps.now())
  if (!out.ok) return { ...out, match: who.match }
  commit(deps, out.match)
  broadcast(deps, out.match, (state) => ({ type: "join", state }))
  return { ok: true, match: out.match, seat: who.seat }
}

export function refuseFor(deps: MatchDeps, code: string, secret: string | null): { ok: true; match: MatchRecord; seat: RoomSeat } | Fail {
  const who = seated(deps, code, secret)
  if (!who.ok) return who
  const out = refuseKnock(who.match, who.seat, deps.now())
  if (!out.ok) return { ...out, match: who.match }
  commit(deps, out.match)
  broadcast(deps, out.match, (state) => ({ type: "state", state }))
  return { ok: true, match: out.match, seat: who.seat }
}

export function resignFor(deps: MatchDeps, code: string, secret: string | null): { ok: true; match: MatchRecord; seat: RoomSeat } | Fail {
  const who = seated(deps, code, secret)
  if (!who.ok) return who
  if (who.match.status === "done") return { ok: true, match: who.match, seat: who.seat }
  const out = resignMatch(who.match, who.seat, deps.now())
  if (!out.ok) return { ...out, match: who.match }
  commit(deps, out.match)
  broadcast(deps, out.match, (state) => ({ type: "end", state }))
  return { ok: true, match: out.match, seat: who.seat }
}

export type PlayResult =
  | { ok: true; match: MatchRecord; seat: RoomSeat; verdict: RoomVerdict; persisted: boolean }
  | Fail

/**
 * One بيت: authenticate, ask the verifier exactly what the machine says to
 * ask, fold the answer in, save, tell the room. `except` is the socket that
 * sent it, which gets the private `verdict` event instead of `turn`.
 */
export function playFor(deps: MatchDeps, code: string, secret: string | null, text: string, except?: MatchConn): PlayResult {
  const who = seated(deps, code, secret)
  if (!who.ok) return who
  const input = verifyInputOf(who.match, who.seat, text)
  if (!input.ok) return { ...input, match: who.match }
  const result = verifyAnswer(deps.db, input.request)
  const out = applyAnswer(who.match, { seat: who.seat, text, result, now: deps.now() })
  if (!out.ok) return { ...out, match: who.match }
  if (out.persisted) {
    commit(deps, out.match)
    const verdict = out.verdict.result.ok ? "ok" : (out.verdict.result.reason as "wrong_letter" | "not_found")
    broadcast(deps, out.match, (state) => ({ type: "turn", state, seat: who.seat, verdict }), except)
    if (out.match.status === "done") broadcast(deps, out.match, (state) => ({ type: "end", state }), except)
  }
  return { ok: true, match: out.match, seat: who.seat, verdict: out.verdict, persisted: out.persisted }
}
