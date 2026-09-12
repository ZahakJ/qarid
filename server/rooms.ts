/**
 * `server/rooms.ts` — 1v1 مساجلة rooms (v2.md §5), the whole of the decision
 * layer. `server/routes/rooms.ts` parses HTTP and WebSocket frames; everything
 * that decides anything about a match is here.
 *
 * THE ONE IDEA WORTH KEEPING IN MIND: the server is the only thing that knows
 * what the room is. Not "mostly" — entirely. The clock is a server timestamp,
 * the turn order is derived from the rows in `match_turns`, the exclusions are
 * read back off those rows, and an answer is judged by exactly the same
 * `verifyAnswer` the solo duel calls (v2.md §5: «through THE SAME verify
 * pipeline»). A client holds no authority at all, which is what makes the two
 * hard cases free:
 *
 *  • RECONNECT — every event carries the FULL snapshot, so a socket that drops
 *    mid-turn and comes back has nothing to merge; it just receives the room.
 *    A dropped socket never forfeits: the only thing that can end a turn
 *    unanswered is the deadline, and the deadline is a number in the database.
 *  • POLLING — `GET /api/room/:code/state` returns the same snapshot the
 *    socket would have pushed, so a browser (or a network) with no WebSocket
 *    plays the same game a little less smoothly. There is no second code path.
 *
 * TURN ORDER, precisely. `match_turns` holds three kinds of row: the host's
 * `opening` بيت (turn 0, written when the room is created), an accepted `ok`
 * بيت, and a strike (`wrong_letter` / `not_found` — v2.md §5's two). Only the
 * first two are part of the CHAIN, so the seat that owes a بيت is decided by
 * the count of chain rows and not by `turn_no`: opening → guest, then host,
 * then guest… A strike therefore does NOT pass the turn — the player who
 * missed still owes the same letter — and it does not silently reorder the
 * match either. What a strike does do is re-arm the clock, because otherwise a
 * wrong guess with four seconds left is two punishments for one mistake, and
 * the number of times it can happen is bounded by `strikes` anyway.
 *
 * WHAT IS NOT WRITTEN DOWN: every other rejection the verifier can produce —
 * «وجدتُ أكثر من بيت», «البيت شطران», «أهذا ما أردت؟», «قيل هذا البيت في هذه
 * المساجلة» — is feedback to the player who typed it and changes nothing about
 * the room. It is returned on the wire, never persisted, and never broadcast:
 * a near-miss is a hint about what the other side almost knows.
 */

import { randomInt, randomBytes, timingSafeEqual } from "node:crypto"

import {
  MAX_ROOM_TURNS,
  ROOM_CODE_LENGTH,
  ROOM_STRIKE_REASONS,
  avatarUrlFor,
  type BaitDto,
  type ChainMode,
  type ChainState,
  type GameVerifyResponse,
  type RoomEndReason,
  type RoomEvent,
  type RoomKnocker,
  type RoomKnockStatus,
  type RoomKnockView,
  type RoomPlayer,
  type RoomSeat,
  type RoomState,
  type RoomTurn,
  type RoomTurnVerdict,
  type RoomVerdict,
} from "../shared/schema.ts"
import { baitAnchor } from "../shared/arabic.ts"
import { albumPool } from "./albumGame.ts"
import type { Config } from "./config.ts"
import type { Db } from "./db.ts"
import { BAIT_COLS, BAIT_CONTEXT_COLS, BAIT_JOINS, baitDto, num, numOrNull, str, strOrNull, type Row } from "./dto.ts"
import { chainState, pickBait, verifyAnswer } from "./game.ts"
import type { RateLimiter } from "./ratelimit.ts"
import {
  blockExistsBetween,
  findAlbumById,
  findUserById,
  getAvatarEtag,
  type UsersDb,
  type UserRow,
} from "./users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// The code
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Six letters, three consonant+vowel pairs — a code that survives being read
 * aloud. No digits: «0/O» and «1/I» are the two mistakes a shared code
 * actually collects, and a room code is shared by voice and by photograph more
 * often than by copy-paste.
 *
 * The consonants drop C/G/P/Q/V/X/Y, which are the ones an Arabic-speaking
 * reader is most likely to hear as each other; 14³ × 5³ = 343,000 codes, drawn
 * with `randomInt` (CSPRNG, no modulo bias) rather than `Math.random`, because
 * a guessable code is a stranger in your مساجلة. Rooms are minutes long and
 * `code` is UNIQUE, so collisions are retried, not tolerated.
 */
const CODE_CONSONANTS = "BDFHJKLMNRSTWZ"
const CODE_VOWELS = "AEIOU"

export function newRoomCode(): string {
  let out = ""
  for (let i = 0; i < ROOM_CODE_LENGTH / 2; i++) {
    out += CODE_CONSONANTS[randomInt(CODE_CONSONANTS.length)]
    out += CODE_VOWELS[randomInt(CODE_VOWELS.length)]
  }
  return out
}

/**
 * The invite — 24 base32 characters, 120 bits, and NOT the room code.
 *
 * The code above is short because it is spoken; that is the right trade for a
 * NAME and the wrong one for a CREDENTIAL. `joinRoom` used to admit whoever
 * arrived first at a `waiting` room, so the 343,000-value code was the only
 * thing between a مساجلة and a stranger — and the routes' own header already
 * said what the model was meant to be («a room link is not public, it is a link
 * you were given»). This is what makes that sentence true: it rides in the
 * share link (`#/room/<CODE>?k=<key>`), it is shown to the two players and to
 * nobody else, and it is what `POST /:code/join` and a spectator's read
 * actually check. The code still names the room, and «badiru» is still
 * «BADIRU».
 */
const KEY_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
export const JOIN_KEY_LENGTH = 24

export function newJoinKey(): string {
  const bytes = randomBytes(JOIN_KEY_LENGTH)
  let out = ""
  // `randomBytes` is uniform over 256 and the alphabet is 32 long, so the
  // modulo divides exactly — no bias, unlike a 26- or 62-character alphabet.
  for (let i = 0; i < JOIN_KEY_LENGTH; i++) out += KEY_ALPHABET[bytes[i]! % KEY_ALPHABET.length]
  return out
}

/** Constant-time key comparison. A null stored key admits nobody. */
export function joinKeyMatches(stored: string | null, offered: string | null | undefined): boolean {
  if (!stored || !offered) return false
  const a = Buffer.from(stored, "utf8")
  const b = Buffer.from(offered, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

export type RoomRow = {
  id: number
  code: string
  hostUserId: number
  guestUserId: number | null
  startingBaitId: number
  mode: ChainMode
  timerS: number | null
  strikes: number
  status: "waiting" | "active" | "done"
  winnerUserId: number | null
  endReason: RoomEndReason | null
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  turnDeadlineAt: number | null
  updatedAt: number
  rematchCode: string | null
  /** the invite secret; see `newJoinKey`. Never leaves the two players. */
  joinKey: string | null
  /**
   * The ديوان this مساجلة is played inside (`albums.id`), or null.
   *
   * Null after the curator deletes the shelf as well as for an ordinary room —
   * `ON DELETE SET NULL` — and both mean the same thing to every reader of this
   * row: there is no shelf constraint to apply. See migration 9 → 10.
   */
  albumId: number | null
}

export type TurnRow = {
  turnNo: number
  userId: number | null
  baitId: number | null
  poemId: number | null
  text: string | null
  verdict: RoomTurnVerdict
  playedAt: number
  msTaken: number | null
}

const ROOM_COLS = `id, code, host_user_id, guest_user_id, starting_bait_id, mode, timer_s, strikes, status,
  winner_user_id, end_reason, created_at, started_at, ended_at, turn_deadline_at, updated_at, rematch_code,
  join_key, album_id`

function roomRow(row: unknown): RoomRow | null {
  if (!row) return null
  const r = row as Record<string, unknown>
  return {
    id: Number(r.id),
    code: String(r.code),
    hostUserId: Number(r.host_user_id),
    guestUserId: r.guest_user_id === null || r.guest_user_id === undefined ? null : Number(r.guest_user_id),
    startingBaitId: Number(r.starting_bait_id),
    mode: String(r.mode) as ChainMode,
    timerS: r.timer_s === null || r.timer_s === undefined ? null : Number(r.timer_s),
    strikes: Number(r.strikes),
    status: String(r.status) as RoomRow["status"],
    winnerUserId: r.winner_user_id === null || r.winner_user_id === undefined ? null : Number(r.winner_user_id),
    endReason: r.end_reason === null || r.end_reason === undefined ? null : (String(r.end_reason) as RoomEndReason),
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
    endedAt: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
    turnDeadlineAt: r.turn_deadline_at === null || r.turn_deadline_at === undefined ? null : Number(r.turn_deadline_at),
    updatedAt: Number(r.updated_at),
    rematchCode: r.rematch_code === null || r.rematch_code === undefined ? null : String(r.rematch_code),
    joinKey: r.join_key === null || r.join_key === undefined ? null : String(r.join_key),
    albumId: r.album_id === null || r.album_id === undefined ? null : Number(r.album_id),
  }
}

function turnRow(row: unknown): TurnRow {
  const r = row as Record<string, unknown>
  return {
    turnNo: Number(r.turn_no),
    userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
    baitId: r.bait_id === null || r.bait_id === undefined ? null : Number(r.bait_id),
    poemId: r.poem_id === null || r.poem_id === undefined ? null : Number(r.poem_id),
    text: r.text === null || r.text === undefined ? null : String(r.text),
    verdict: String(r.verdict) as RoomTurnVerdict,
    playedAt: Number(r.played_at),
    msTaken: r.ms_taken === null || r.ms_taken === undefined ? null : Number(r.ms_taken),
  }
}

export function findRoomByCode(users: UsersDb, code: string): RoomRow | null {
  return roomRow(users.q(`SELECT ${ROOM_COLS} FROM rooms WHERE code = ? COLLATE NOCASE`).get(code))
}

export function findRoomById(users: UsersDb, id: number): RoomRow | null {
  return roomRow(users.q(`SELECT ${ROOM_COLS} FROM rooms WHERE id = ?`).get(id))
}

export function roomTurns(users: UsersDb, roomId: number): TurnRow[] {
  const rows = users
    .q(
      `SELECT turn_no, user_id, bait_id, poem_id, text, verdict, played_at, ms_taken
       FROM match_turns WHERE room_id = ? ORDER BY turn_no`,
    )
    .all(roomId) as unknown[]
  return rows.map(turnRow)
}

/** The chain rows — the opening بيت and every accepted answer, in order. */
export function chainTurns(turns: readonly TurnRow[]): TurnRow[] {
  return turns.filter((t) => t.verdict === "opening" || t.verdict === "ok")
}

// ─────────────────────────────────────────────────────────────────────────────
// The corpus side
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `po.fame` rides along because `chainState` needs it for `obscurity` — the one
 * field of a chain state that is about the شاعر rather than the letters.
 */
const ROOM_BAIT_SELECT = `SELECT ${BAIT_COLS}, ${BAIT_CONTEXT_COLS}, po.fame AS po_fame FROM baits b ${BAIT_JOINS}`

export function baitRow(db: Db, id: number): Row | null {
  return (db.q(`${ROOM_BAIT_SELECT} WHERE b.id = ?`).get(id) as Row | undefined) ?? null
}

/** One query for the whole transcript — a match is tens of أبيات, not one each. */
export function baitRowsByIds(db: Db, ids: readonly number[]): Map<number, Row> {
  const out = new Map<number, Row>()
  const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0)
  if (unique.length === 0) return out
  // The ids are integers this process wrote into `match_turns`; they are
  // interpolated only because SQLite has no array parameter, and they are
  // re-checked as integers immediately above.
  const rows = db.q(`${ROOM_BAIT_SELECT} WHERE b.id IN (${unique.map(() => "?").join(",")})`).all(...unique) as Row[]
  for (const row of rows) out.set(num(row.b_id), row)
  return out
}

/** Is this بيت something a مساجلة can actually open on? (`game_baits` says.) */
export function isPlayableBait(db: Db, id: number): boolean {
  return db.q("SELECT 1 AS ok FROM game_baits WHERE bait_id = ?").get(id) !== undefined
}

/**
 * «عشوائي» — v2.md §5's «fame≥2 default».
 *
 * That is the شاعر tier exactly (`fame >= 2 AND position <= 12`), so the
 * opening بيت of a مساجلة between two people is one from a شاعر the ديوان
 * considers known, taken from the first dozen أبيات of his قصيدة rather than
 * from بيت ٣٠٠ of a 500-بيت ديوان.
 */
export function randomStartingBait(db: Db, exclude: readonly number[] = [], pool?: readonly number[]): Row | null {
  const picked = pickBait(db, {
    difficulty: "normal",
    tailBias: "none",
    excludeBaitIds: [...exclude],
    // A ديوان room opens from the SHELF. The شاعر tier is still asked for
    // first and still relaxes to سيف when a thirty-بيت shelf holds nothing
    // famous — which is the ordinary case, and the right one: the أبيات on the
    // shelf are the أبيات, whoever wrote them.
    ...(pool === undefined ? {} : { poolBaitIds: pool }),
  })
  return picked?.row ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// The live side — sockets and the clock
// ─────────────────────────────────────────────────────────────────────────────

export type RoomConn = {
  /** null is impossible today (every socket is cookie-authenticated) but the
   *  snapshot must not assume it, and a closed socket is nulled out here. */
  userId: number
  username: string
  send: (event: RoomEvent) => void
}

/**
 * The per-process registry of open sockets, and the per-room timer.
 *
 * It is deliberately NOT the source of truth for anything: it decides who gets
 * told, and `connected` on the snapshot, and nothing else. A restart empties
 * it, and every room carries on from the database exactly where it was — with
 * the deadline re-armed by the first request that touches it.
 */
/** Tabs one account may hold on one room — two real ones and slack for a reload. */
export const MAX_SOCKETS_PER_USER = 4

/** Sockets one room may carry at all: two seats and v2.md §5's spectators. */
export const MAX_ROOM_SOCKETS = 24

export class RoomHub {
  private conns = new Map<string, Set<RoomConn>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** what a room's clock should do when it expires — set by `arm` */
  private onExpire: ((code: string) => void) | null = null

  onDeadline(fn: (code: string) => void): void {
    this.onExpire = fn
  }

  /**
   * Attach a socket, or refuse it — `false` means the caller must close.
   *
   * There was no cap of any kind here, and every event fans out one FULL
   * `snapshot()` per connected socket (~6 synchronous SQLite calls against the
   * 1.5 GiB corpus), while `onOpen` itself broadcast to everyone already
   * attached. Attaching N sockets therefore cost N(N+1)/2 snapshots: measured
   * on the real artefact, 600 sockets from ONE account fanned out 1,312 MB of
   * JSON, and `spectators` dedupes by user id so both players read «1 مشاهد»
   * throughout. Two caps, because they answer two different questions: how
   * many tabs one person may keep open, and how many people may watch.
   */
  add(code: string, conn: RoomConn): boolean {
    const key = code.toUpperCase()
    let set = this.conns.get(key)
    if (!set) {
      set = new Set()
      this.conns.set(key, set)
    }
    if (set.size >= MAX_ROOM_SOCKETS) return false
    let mine = 0
    for (const c of set) if (c.userId === conn.userId) mine += 1
    if (mine >= MAX_SOCKETS_PER_USER) return false
    set.add(conn)
    return true
  }

  remove(code: string, conn: RoomConn): void {
    const key = code.toUpperCase()
    const set = this.conns.get(key)
    if (!set) return
    set.delete(conn)
    if (set.size === 0) this.conns.delete(key)
  }

  connections(code: string): RoomConn[] {
    return [...(this.conns.get(code.toUpperCase()) ?? [])]
  }

  isConnected(code: string, userId: number): boolean {
    for (const c of this.conns.get(code.toUpperCase()) ?? []) if (c.userId === userId) return true
    return false
  }

  /** Every socket on the room except, optionally, the one that caused this. */
  broadcast(code: string, event: RoomEvent, except?: RoomConn): void {
    for (const conn of this.connections(code)) {
      if (conn === except) continue
      try {
        conn.send(event)
      } catch {
        /* a socket that throws on send is a socket that is already gone */
      }
    }
  }

  /**
   * (Re)arm a room's deadline. `unref` so a pending مساجلة never holds a test
   * run — or a shutdown — open; the deadline is in the database and the next
   * request resolves it whether or not the timer ever fired.
   */
  arm(code: string, deadlineAt: number | null, now: number): void {
    const key = code.toUpperCase()
    const existing = this.timers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(key)
    }
    if (deadlineAt === null || this.onExpire === null) return
    const fire = this.onExpire
    const t = setTimeout(() => {
      this.timers.delete(key)
      fire(key)
    }, Math.max(0, deadlineAt - now) + 40)
    t.unref?.()
    this.timers.set(key, t)
  }

  disarm(code: string): void {
    this.arm(code, null, Date.now())
  }

  /** Test/shutdown seam — drop every timer this hub owns. */
  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.conns.clear()
  }
}

export type RoomDeps = {
  db: Db
  users: UsersDb
  config: Config
  hub: RoomHub
  /**
   * The bucket every inbound WebSocket frame spends, keyed on the USER id.
   *
   * `GAME_RATE_LIMIT` is Hono middleware and an upgrade never reaches it, so
   * the socket ran the same `playTurn` — and answered the same full snapshot to
   * `{"type":"state"}` — with no bucket at all. Keyed on the user rather than
   * on the socket because a per-socket counter is defeated by opening a second
   * socket, which is exactly what the measurement did.
   */
  socketLimiter: RateLimiter
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

function touchRoom(users: UsersDb, roomId: number, now: number): void {
  users.q("UPDATE rooms SET updated_at = ? WHERE id = ?").run(now, roomId)
}

export type CreateRoomInput = {
  hostUserId: number
  startingBaitId: number
  startingPoemId: number
  mode: ChainMode
  timerS: number | null
  strikes: number
  now: number
  /** the rematch's pre-assigned opponent — an ordinary room has none */
  guestUserId?: number | null
  /** the ديوان both players are confined to (`albums.id`), when there is one */
  albumId?: number | null
}

/**
 * Create the room AND write the opening بيت as turn 0 in one transaction.
 *
 * The opening is a row rather than a derived thing so the transcript has one
 * shape: every بيت on screen, including the one the host chose, is a
 * `match_turns` row that a reload, a reconnect and the polling fallback all
 * read the same way. It carries `verdict = 'opening'`, which keeps it out of
 * `duelStats`' «أبيات» count (server/users.ts counts `ok`) — the host recited
 * it, he did not answer with it.
 */
export function createRoom(users: UsersDb, input: CreateRoomInput): RoomRow {
  const { now } = input
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newRoomCode()
    try {
      users.raw.exec("BEGIN IMMEDIATE")
      users
        .q(
          `INSERT INTO rooms (code, host_user_id, guest_user_id, starting_bait_id, mode, timer_s, strikes, status,
                              created_at, updated_at, join_key, album_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
        )
        .run(
          code,
          input.hostUserId,
          input.guestUserId ?? null,
          input.startingBaitId,
          input.mode,
          input.timerS,
          input.strikes,
          now,
          now,
          newJoinKey(),
          input.albumId ?? null,
        )
      const id = Number((users.q("SELECT last_insert_rowid() AS id").get() as { id: number }).id)
      users
        .q(
          `INSERT INTO match_turns (room_id, turn_no, user_id, bait_id, poem_id, text, verdict, played_at, ms_taken)
           VALUES (?, 0, ?, ?, ?, NULL, 'opening', ?, NULL)`,
        )
        .run(id, input.hostUserId, input.startingBaitId, input.startingPoemId, now)
      users.raw.exec("COMMIT")
      return findRoomById(users, id)!
    } catch (err) {
      try {
        users.raw.exec("ROLLBACK")
      } catch {
        /* the transaction was never opened */
      }
      if (!/UNIQUE constraint failed/i.test((err as Error)?.message ?? "")) throw err
    }
  }
  throw new Error("could not allocate a room code")
}

/** The guest sits down and the clock starts. Idempotent for the same user. */
export function startRoom(users: UsersDb, room: RoomRow, guestUserId: number, now: number): RoomRow {
  const deadline = room.timerS === null ? null : now + room.timerS * 1000
  users
    .q(
      `UPDATE rooms SET guest_user_id = ?, status = 'active', started_at = ?, turn_deadline_at = ?, updated_at = ?
       WHERE id = ? AND status = 'waiting'`,
    )
    .run(guestUserId, now, deadline, now, room.id)
  return findRoomById(users, room.id) ?? room
}

export function setDeadline(users: UsersDb, roomId: number, deadlineAt: number | null, now: number): void {
  users.q("UPDATE rooms SET turn_deadline_at = ?, updated_at = ? WHERE id = ?").run(deadlineAt, now, roomId)
}

export function endRoom(
  users: UsersDb,
  room: RoomRow,
  winnerUserId: number | null,
  reason: RoomEndReason,
  now: number,
): RoomRow {
  users
    .q(
      `UPDATE rooms SET status = 'done', winner_user_id = ?, end_reason = ?, ended_at = ?, turn_deadline_at = NULL,
                        updated_at = ? WHERE id = ? AND status <> 'done'`,
    )
    .run(winnerUserId, reason, now, now, room.id)
  return findRoomById(users, room.id) ?? room
}

export function insertTurn(
  users: UsersDb,
  roomId: number,
  turn: { turnNo: number; userId: number; baitId: number | null; poemId: number | null; text: string | null; verdict: RoomTurnVerdict; now: number; msTaken: number | null },
): void {
  users
    .q(
      `INSERT INTO match_turns (room_id, turn_no, user_id, bait_id, poem_id, text, verdict, played_at, ms_taken)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(roomId, turn.turnNo, turn.userId, turn.baitId, turn.poemId, turn.text, turn.verdict, turn.now, turn.msTaken)
  touchRoom(users, roomId, turn.now)
}

export function setRematchCode(users: UsersDb, roomId: number, code: string, now: number): void {
  users.q("UPDATE rooms SET rematch_code = ?, updated_at = ? WHERE id = ?").run(code, now, roomId)
}

// ─────────────────────────────────────────────────────────────────────────────
// The snapshot
// ─────────────────────────────────────────────────────────────────────────────

export type Viewer = { id: number; username: string } | null

export function seatOf(room: RoomRow, userId: number | null | undefined): RoomSeat | null {
  if (userId === null || userId === undefined) return null
  if (userId === room.hostUserId) return "host"
  if (room.guestUserId !== null && userId === room.guestUserId) return "guest"
  return null
}

/** The seat that owes a بيت — see the header: chain rows, never `turn_no`. */
export function turnSeatOf(chain: readonly TurnRow[]): RoomSeat {
  return chain.length % 2 === 1 ? "guest" : "host"
}

export function strikesSpent(turns: readonly TurnRow[], userId: number | null): number {
  if (userId === null) return 0
  return turns.filter((t) => t.userId === userId && (ROOM_STRIKE_REASONS as readonly string[]).includes(t.verdict)).length
}

/**
 * The seat of a player who deleted their account — kept so a finished مساجلة
 * still reads as a game between two people, not one against an empty chair. The
 * أبيات themselves survive in the transcript (`match_turns.user_id` is SET NULL,
 * not deleted); this is only the seat header the name used to fill.
 */
function deletedPlayer(seat: RoomSeat): RoomPlayer {
  return { username: "", displayName: "لاعب محذوف", avatar: null, seat, strikes: 0, turns: 0, connected: false }
}

function playerOf(
  deps: RoomDeps,
  room: RoomRow,
  seat: RoomSeat,
  userId: number | null,
  turns: readonly TurnRow[],
): RoomPlayer | null {
  if (userId === null) {
    // A room that STARTED had someone in both seats; a null seat on it is a
    // departed account (its guest reference was SET NULL when he deleted),
    // which is «لاعب محذوف» rather than an open chair. A room that never
    // started (still `waiting`) has a genuinely empty guest seat → null.
    return room.startedAt !== null ? deletedPlayer(seat) : null
  }
  const user = findUserById(deps.users, userId)
  // Belt to the SET NULL braces: an id whose row is somehow gone is anonymized,
  // never a crash and never a leaked half-record.
  if (!user) return deletedPlayer(seat)
  return {
    username: user.username,
    displayName: user.display_name,
    avatar: avatarUrlFor(user.username, getAvatarEtag(deps.users, user.id)),
    seat,
    strikes: strikesSpent(turns, userId),
    turns: turns.filter((t) => t.userId === userId && t.verdict === "ok").length,
    connected: deps.hub.isConnected(room.code, userId),
  }
}

/**
 * The transcript, hydrated. A strike keeps the text the player typed and no
 * بيت — that is what a strike IS — and it still shows on both screens, because
 * a مساجلة where your opponent's misses are invisible reads as if the clock
 * simply skipped.
 */
function turnsOf(
  deps: RoomDeps,
  room: RoomRow,
  rows: readonly TurnRow[],
  players: { host: RoomPlayer | null; guest: RoomPlayer | null },
): RoomTurn[] {
  const baits = baitRowsByIds(
    deps.db,
    rows.map((t) => t.baitId).filter((id): id is number => id !== null),
  )
  return rows.map((t): RoomTurn => {
    const row = t.baitId === null ? undefined : baits.get(t.baitId)
    // Only two people can own a row, and both are already loaded — a lookup
    // per turn would be one query per بيت per connected socket per event.
    const seat = seatOf(room, t.userId) ?? (t.turnNo % 2 === 0 ? "host" : "guest")
    const player = seat === "host" ? players.host : players.guest
    return {
      turnNo: t.turnNo,
      seat,
      username: t.userId === null ? null : (player?.username ?? null),
      verdict: t.verdict,
      bait: row ? (baitDto(row) as BaitDto) : null,
      text: t.text,
      playedAt: t.playedAt,
      msTaken: t.msTaken,
    }
  })
}

/** The chain state the next answer must satisfy, off the last accepted بيت. */
export function requiredOf(deps: RoomDeps, room: RoomRow, rows: readonly TurnRow[]): ChainState | null {
  const chain = chainTurns(rows)
  const last = chain[chain.length - 1]
  if (!last || last.baitId === null) return null
  const row = baitRow(deps.db, last.baitId)
  return row ? chainState(row, room.mode) : null
}

/**
 * The link you hand a friend — and the ONLY place the invite key is written
 * into a URL. `joinKey` is null for anyone who is not seated in this room, so a
 * spectator's snapshot carries the plain address of a room they can read and
 * not the credential for a seat they were not offered.
 */
export function shareUrlFor(config: Config, code: string, joinKey: string | null = null): string {
  const origin = config.publicOrigin.replace(/\/+$/, "")
  const base = `${origin}/#/room/${code}`
  return joinKey === null ? base : `${base}?k=${encodeURIComponent(joinKey)}`
}

export function snapshot(
  deps: RoomDeps,
  room: RoomRow,
  viewer: Viewer,
  now = Date.now(),
  /** the invite key this reader arrived with, if any — see `canJoin` below */
  offeredKey: string | null = null,
): RoomState {
  const invited = joinKeyMatches(room.joinKey, offeredKey)
  const rows = roomTurns(deps.users, room.id)
  const host = playerOf(deps, room, "host", room.hostUserId, rows)
  const guest = playerOf(deps, room, "guest", room.guestUserId, rows)
  const turns = turnsOf(deps, room, rows, { host, guest })
  const seat = seatOf(room, viewer?.id ?? null)
  const chain = chainTurns(rows)
  const turnSeat = room.status === "active" ? turnSeatOf(chain) : null
  const winner = room.winnerUserId === null ? null : (findUserById(deps.users, room.winnerUserId)?.username ?? null)

  // «canJoin»: the room is still waiting and this seat is open to you. A room
  // whose guest is pre-assigned (a رجعة) is open only to that player — and an
  // open seat is only offered to a reader who arrived with the invite key,
  // because that is the whole of «a room link is not public, it is a link you
  // were given» (server/routes/rooms.ts).
  const canJoin =
    viewer !== null &&
    room.status === "waiting" &&
    seat !== "host" &&
    (room.guestUserId === viewer.id || (room.guestUserId === null && invited))

  // The key belongs to the two players. A spectator — who reached the room
  // with the key, or is watching a room they are seated in nowhere — gets the
  // room, never the credential for its empty seat.
  const keyForViewer = seat !== null ? room.joinKey : null

  return {
    code: room.code,
    status: room.status,
    mode: room.mode,
    timerS: room.timerS,
    strikes: room.strikes,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
    host,
    guest,
    you: {
      username: viewer?.username ?? null,
      role: seat ?? "spectator",
      seat,
      canJoin,
      canPlay: room.status === "active" && seat !== null && seat === turnSeat,
    },
    turns,
    turnSeat,
    required: requiredOf(deps, room, rows),
    deadlineAt: room.status === "active" ? room.turnDeadlineAt : null,
    serverNow: now,
    winner,
    endReason: room.endReason,
    rematchCode: room.rematchCode,
    joinKey: keyForViewer,
    spectators: Math.max(
      0,
      new Set(
        deps.hub
          .connections(room.code)
          .map((c) => c.userId)
          .filter((id) => seatOf(room, id) === null),
      ).size,
    ),
    shareUrl: shareUrlFor(deps.config, room.code, keyForViewer),
    // The door is the host's to watch: only his snapshot names who is knocking,
    // and only while the room is still waiting. A spectator vets nobody.
    knock: seat === "host" ? knockerFor(deps.users, room) : null,
    // Presence, from the hub — see `RoomStateSchema.atDoor`. The host's screen
    // is the only one that needs it and a waiting room is the only moment it
    // means anything, so it is computed nowhere else.
    atDoor:
      seat === "host" &&
      room.status === "waiting" &&
      deps.hub.connections(room.code).some((c) => seatOf(room, c.userId) === null),
    // The ديوان, read LIVE off the shelf rather than copied into the room: the
    // title on the HUD is the title on its page, and a shelf its curator has
    // deleted mid-match is a null here and an ordinary مساجلة from then on.
    album: albumOf(deps.users, room),
  }
}

/** The ديوان a room is played inside, as the snapshot names it. */
export function albumOf(users: UsersDb, room: RoomRow): { code: string; title: string } | null {
  if (room.albumId === null) return null
  const album = findAlbumById(users, room.albumId)
  return album === null ? null : { code: album.code, title: album.title }
}

// ─────────────────────────────────────────────────────────────────────────────
// The clock
// ─────────────────────────────────────────────────────────────────────────────

/** The other seat's user id — who wins when this one runs out of anything. */
export function opponentOf(room: RoomRow, userId: number): number | null {
  if (userId === room.hostUserId) return room.guestUserId
  if (userId === room.guestUserId) return room.hostUserId
  return null
}

export function userIdForSeat(room: RoomRow, seat: RoomSeat): number | null {
  return seat === "host" ? room.hostUserId : room.guestUserId
}

/**
 * Resolve an expired deadline, wherever we noticed it.
 *
 * Called from three places — the timer this process armed, any HTTP request
 * that touches the room, and a socket connecting — because the timer is the
 * only one of the three that a restart can lose. The database says what time
 * the turn was due; whoever gets here first writes the same ending.
 *
 * IT RE-READS THE ROW, and that is the whole of the bug this signature used to
 * carry. `POST /:code/turn` is the one async handler: it loaded the row at
 * dispatch and then AWAITED the body, so a second turn arriving in that window
 * moved the deadline while the first request still held the old number. This
 * function then judged the STALE `turn_deadline_at` against a transcript it
 * read fresh, and ended the match `timeout` against the player who had just
 * been handed a full clock — measured, reproducible over a real socket, and a
 * direct contradiction of CLAUDE.md's «the only thing that can end a turn
 * unanswered is a timestamp in the database»: the timestamp used was one the
 * database no longer held. The caller's snapshot is now a hint about WHICH row,
 * never about what is in it.
 */
export function resolveExpiry(deps: RoomDeps, room: RoomRow, now: number): { room: RoomRow; expired: boolean } {
  const live = findRoomById(deps.users, room.id) ?? room
  if (live.status !== "active" || live.turnDeadlineAt === null || now < live.turnDeadlineAt) {
    return { room: live, expired: false }
  }
  const chain = chainTurns(roomTurns(deps.users, live.id))
  const loserSeat = turnSeatOf(chain)
  const loser = userIdForSeat(live, loserSeat)
  const winner = loser === null ? null : opponentOf(live, loser)
  const ended = endRoom(deps.users, live, winner, "timeout", now)
  deps.hub.disarm(live.code)
  return { room: ended, expired: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// A turn
// ─────────────────────────────────────────────────────────────────────────────

export type PlayOutcome =
  | { ok: true; verdict: RoomVerdict; room: RoomRow; accepted: boolean; persisted: boolean }
  | { ok: false; code: string }

/**
 * ONE بيت, judged and recorded. The whole of v2.md §5's «server-authoritative
 * turns through the SAME verify pipeline with cumulative exclusions».
 *
 * The exclusions are read back off the transcript every time rather than being
 * accumulated in memory: `usedBaitIds` is every بيت the room has accepted (the
 * opening included) and `usedPoemIds` every قصيدة they came from, so the same
 * بيت under a different id — and the same قصيدة under a different بيت — is
 * refused for both players, and a server restart mid-match changes nothing.
 */
export function playTurn(
  deps: RoomDeps,
  room: RoomRow,
  user: UserRow,
  text: string,
  now = Date.now(),
): PlayOutcome {
  const expiry = resolveExpiry(deps, room, now)
  if (expiry.expired) return { ok: false, code: "room_not_active" }
  const live = expiry.room
  if (live.status !== "active") return { ok: false, code: "room_not_active" }

  const seat = seatOf(live, user.id)
  if (seat === null) return { ok: false, code: "spectator" }

  const rows = roomTurns(deps.users, live.id)
  const chain = chainTurns(rows)
  if (turnSeatOf(chain) !== seat) return { ok: false, code: "not_your_turn" }

  const last = chain[chain.length - 1]
  const result: GameVerifyResponse = verifyAnswer(deps.db, {
    text,
    prevBaitId: last?.baitId ?? undefined,
    // The letter is always read off the previous بيت, never sent: there is no
    // «بدّل الحرف» in a room, and a client-supplied required letter would be
    // the one thing in this request the server did not derive itself.
    requiredLetter: undefined,
    mode: live.mode,
    usedBaitIds: chain.map((t) => t.baitId).filter((id): id is number => id !== null),
    usedPoemIds: chain.map((t) => t.poemId).filter((id): id is number => id !== null),
    filters: undefined,
    sessionSeed: undefined,
  })

  // ── the ديوان, when the room is played inside one ───────────────────────
  //
  // The verifier has already said this is a real بيت on the required letter,
  // out of the whole 3.37-million-بيت corpus. The room's own rule is narrower:
  // both players answer from the SHELF. So the test runs on the MATCHED بيت —
  // never on the text the player typed, which may be a fuzzy match of it — and
  // it is the shelf's own anchor, `baitAnchor` over the matched بيت's two
  // halves, because the corpus holds the same بيت under up to 51 ids and a
  // reader who quoted a different copy of a بيت that IS on the shelf has
  // answered from the ديوان (`server/albumGame.ts`).
  //
  // It is SOFT: no strike, no row in `match_turns`, the turn stays where it is.
  // See `not_in_album` in shared/schema.ts for why the COSTS_LIFE philosophy
  // puts it beside `wrong_letter` and not beside `not_found`.
  const shelf = live.albumId === null ? null : findAlbumById(deps.users, live.albumId)
  if (result.ok && shelf !== null) {
    const anchors = albumPool(deps.db, deps.users, shelf).anchors
    const anchor = baitAnchor(result.bait.sadr, result.bait.ajuz)
    if (anchor === null || !anchors.has(anchor)) {
      return {
        ok: true,
        accepted: false,
        persisted: false,
        room: live,
        verdict: {
          result: { ok: false, reason: "not_in_album", bait: result.bait, albumTitle: shelf.title },
          strike: false,
          strikesLeft: Math.max(0, live.strikes - strikesSpent(rows, user.id)),
        },
      }
    }
  }

  const spent = strikesSpent(rows, user.id)
  const turnStartedAt = rows.length > 0 ? rows[rows.length - 1]!.playedAt : (live.startedAt ?? live.createdAt)
  const msTaken = Math.max(0, now - turnStartedAt)
  const nextTurnNo = rows.length === 0 ? 0 : rows[rows.length - 1]!.turnNo + 1

  // ── accepted ────────────────────────────────────────────────────────────
  if (result.ok) {
    insertTurn(deps.users, live.id, {
      turnNo: nextTurnNo,
      userId: user.id,
      baitId: result.bait.id,
      // `poem.poemId` (the internal id the exclusions use) lives on the بيت's
      // own PoemRef; `result.poem` is the PoemSummary and carries only the
      // public one (server/dto.ts, the `usedPoemIds` backlog note).
      poemId: result.bait.poem.poemId,
      text,
      verdict: "ok",
      now,
      msTaken,
    })
    let after = findRoomById(deps.users, live.id)!
    // A مساجلة that neither player ever loses still has to stop somewhere.
    if (chain.length + 1 >= MAX_ROOM_TURNS) {
      after = endRoom(deps.users, after, null, "abandoned", now)
      deps.hub.disarm(after.code)
    } else {
      const deadline = after.timerS === null ? null : now + after.timerS * 1000
      setDeadline(deps.users, after.id, deadline, now)
      after = findRoomById(deps.users, after.id)!
      deps.hub.arm(after.code, deadline, now)
    }
    return {
      ok: true,
      accepted: true,
      persisted: true,
      room: after,
      verdict: { result, strike: false, strikesLeft: Math.max(0, live.strikes - spent) },
    }
  }

  // ── a strike: exactly the two v2.md §5 names ────────────────────────────
  if ((ROOM_STRIKE_REASONS as readonly string[]).includes(result.reason)) {
    insertTurn(deps.users, live.id, {
      turnNo: nextTurnNo,
      userId: user.id,
      baitId: null,
      poemId: null,
      text,
      verdict: result.reason as RoomTurnVerdict,
      now,
      msTaken,
    })
    const struck = spent + 1
    let after = findRoomById(deps.users, live.id)!
    if (struck >= live.strikes) {
      after = endRoom(deps.users, after, opponentOf(after, user.id), "strikes", now)
      deps.hub.disarm(after.code)
    } else {
      // The clock is re-armed, not resumed: see the header. The number of times
      // this can happen is `strikes - 1`, which is one or two.
      const deadline = after.timerS === null ? null : now + after.timerS * 1000
      setDeadline(deps.users, after.id, deadline, now)
      after = findRoomById(deps.users, after.id)!
      deps.hub.arm(after.code, deadline, now)
    }
    return {
      ok: true,
      accepted: false,
      persisted: true,
      room: after,
      verdict: { result, strike: true, strikesLeft: Math.max(0, live.strikes - struck) },
    }
  }

  // ── everything else is feedback, and nothing else ───────────────────────
  return {
    ok: true,
    accepted: false,
    persisted: false,
    room: live,
    verdict: { result, strike: false, strikesLeft: Math.max(0, live.strikes - spent) },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Knock-to-join
// ─────────────────────────────────────────────────────────────────────────────

export type KnockRow = {
  roomId: number
  userId: number
  status: "pending" | "rejected"
  createdAt: number
  updatedAt: number
}

function knockRow(row: unknown): KnockRow | null {
  if (!row) return null
  const r = row as Record<string, unknown>
  return {
    roomId: Number(r.room_id),
    userId: Number(r.user_id),
    status: String(r.status) as KnockRow["status"],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

/** The ONE pending knock a room may hold — first come, and the others wait. */
export function pendingKnock(users: UsersDb, roomId: number): KnockRow | null {
  return knockRow(
    users
      .q("SELECT room_id, user_id, status, created_at, updated_at FROM room_knocks WHERE room_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1")
      .get(roomId),
  )
}

/** This user's own knock on this room, whatever its state. */
export function knockOf(users: UsersDb, roomId: number, userId: number): KnockRow | null {
  return knockRow(
    users.q("SELECT room_id, user_id, status, created_at, updated_at FROM room_knocks WHERE room_id = ? AND user_id = ?").get(roomId, userId),
  )
}

/** The pending knocker as the host's snapshot shows him — a name, never a seat. */
export function knockerFor(users: UsersDb, room: RoomRow): RoomKnocker | null {
  if (room.status !== "waiting") return null
  const k = pendingKnock(users, room.id)
  if (!k) return null
  const user = findUserById(users, k.userId)
  return user ? { username: user.username, displayName: user.display_name } : null
}

/**
 * The minimal status a KNOCKER is told — never the room. `accepted` is derived
 * from the seat, not from a knock row (the row is cleared on accept), so a
 * knocker whom the host seated learns it the same way a reload would.
 */
export function knockView(users: UsersDb, room: RoomRow, userId: number): RoomKnockView {
  const host = findUserById(users, room.hostUserId)
  const base = { code: room.code, hostName: host?.display_name ?? null }
  if (seatOf(room, userId) !== null) return { ...base, status: "accepted" }
  const mine = knockOf(users, room.id, userId)
  const status: RoomKnockStatus = mine === null ? "none" : mine.status === "rejected" ? "rejected" : "pending"
  return { ...base, status }
}

export type KnockOutcome = { ok: true; room: RoomRow; knocker: RoomKnocker } | { ok: false; code: string }

/**
 * Record a pending knock (a logged-in guest who reached the room by voice).
 *
 * The gate is deliberately strict and additive: the host cannot knock his own
 * room, a room that is not `waiting` cannot be knocked (it is full, running or
 * over), and only ONE knocker waits at a time — a second is told the room is
 * busy rather than silently overwriting the first. Re-knocking after a
 * rejection is allowed (it flips the row back to pending) but is rate-limited by
 * the route, so a refused stranger cannot hammer the door.
 */
export function recordKnock(deps: RoomDeps, room: RoomRow, user: UserRow, now = Date.now()): KnockOutcome {
  if (seatOf(room, user.id) !== null) return { ok: false, code: "cannot_knock" }
  if (room.status !== "waiting") return { ok: false, code: room.status === "active" ? "room_full" : "room_not_active" }
  if (room.guestUserId !== null) return { ok: false, code: "room_full" }
  // A block either way means the door does not even acknowledge the knock
  // (Track 3) — same vague `blocked` the join path answers, for the same reason.
  if (blockExistsBetween(deps.users, room.hostUserId, user.id)) return { ok: false, code: "blocked" }
  const existing = pendingKnock(deps.users, room.id)
  if (existing && existing.userId !== user.id) return { ok: false, code: "room_busy" }
  deps.users
    .q(
      `INSERT INTO room_knocks (room_id, user_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)
       ON CONFLICT(room_id, user_id) DO UPDATE SET status = 'pending', updated_at = excluded.updated_at`,
    )
    .run(room.id, user.id, now, now)
  return { ok: true, room, knocker: { username: user.username, displayName: user.display_name } }
}

/**
 * The host lets the knocker in: assign the seat and activate through the very
 * same `startRoom` an invited join uses, then clear the room's knocks (the
 * accepted one is now a seat; any stragglers are moot). Idempotent — a second
 * accept after the room is active simply reports the live room.
 */
export function acceptKnock(deps: RoomDeps, room: RoomRow, host: UserRow, now = Date.now()): JoinOutcome {
  if (seatOf(room, host.id) !== "host") return { ok: false, code: "not_the_host" }
  if (room.status !== "waiting") return room.status === "active" ? { ok: true, room, joined: false } : { ok: false, code: "room_not_active" }
  if (room.guestUserId !== null) return { ok: false, code: "room_full" }
  const knock = pendingKnock(deps.users, room.id)
  if (!knock) return { ok: false, code: "no_knock" }
  // A block created after the knock landed (Track 3): the host cannot seat
  // someone a block now stands between. The pending knock is left as-is; the
  // host may reject it.
  if (blockExistsBetween(deps.users, host.id, knock.userId)) return { ok: false, code: "blocked" }
  const started = startRoom(deps.users, room, knock.userId, now)
  deps.users.q("DELETE FROM room_knocks WHERE room_id = ?").run(room.id)
  deps.hub.arm(started.code, started.turnDeadlineAt, now)
  return { ok: true, room: started, joined: true }
}

export type RejectOutcome = { ok: true; room: RoomRow; knockerId: number } | { ok: false; code: string }

/** The host refuses the knocker: the row goes `rejected`, the seat stays open. */
export function rejectKnock(deps: RoomDeps, room: RoomRow, host: UserRow, now = Date.now()): RejectOutcome {
  if (seatOf(room, host.id) !== "host") return { ok: false, code: "not_the_host" }
  const knock = pendingKnock(deps.users, room.id)
  if (!knock) return { ok: false, code: "no_knock" }
  deps.users.q("UPDATE room_knocks SET status = 'rejected', updated_at = ? WHERE room_id = ? AND user_id = ?").run(now, room.id, knock.userId)
  return { ok: true, room, knockerId: knock.userId }
}

/**
 * Reject every pending knock on a room — called when the host CLOSES a waiting
 * room. The knocker is not a player, so there is no seat to end; his poll simply
 * turns to `rejected` and his «بانتظار…» view becomes «لم يُؤذن لك».
 */
export function rejectPendingKnocks(users: UsersDb, roomId: number, now: number): number {
  return Number(
    users.q("UPDATE room_knocks SET status = 'rejected', updated_at = ? WHERE room_id = ? AND status = 'pending'").run(now, roomId).changes ?? 0,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Joining, resigning, رجعة
// ─────────────────────────────────────────────────────────────────────────────

export type JoinOutcome =
  | { ok: true; room: RoomRow; joined: boolean }
  | { ok: false; code: string }

/**
 * Sit down (v2.md §5: «Guest opens link → joins. Server flips to active»).
 *
 * Four honest answers, and only one of them is an error: you are the host
 * (nothing happens), you just took the empty seat (the room starts), the room
 * is full and you are watching, or the room is a رجعة whose seat is reserved
 * for somebody else.
 */
export function joinRoom(
  deps: RoomDeps,
  room: RoomRow,
  user: UserRow,
  now = Date.now(),
  offeredKey: string | null = null,
): JoinOutcome {
  const seat = seatOf(room, user.id)
  // Already under way (or over): a player is simply back, anyone else watches.
  if (room.status !== "waiting") {
    return seat !== null ? { ok: true, room, joined: false } : { ok: false, code: "room_full" }
  }
  if (seat === "host") return { ok: true, room, joined: false }
  // A BLOCK either way shuts the seat (Track 3, «cannot be matched with them»).
  // Checked before the key so the reason a blocked stranger cannot sit down is
  // never «wrong key» — and the symmetric read means a blocked player learns
  // nothing about which direction the block runs.
  if (blockExistsBetween(deps.users, room.hostUserId, user.id)) return { ok: false, code: "blocked" }
  // A رجعة names its guest in advance, so `seat === "guest"` here is the
  // reserved player ARRIVING — the room has to start for him exactly as it
  // would for a stranger taking an empty seat. Returning early because he
  // already had a seat left the rematch waiting forever.
  if (room.guestUserId !== null && room.guestUserId !== user.id) return { ok: false, code: "room_full" }
  // AN OPEN SEAT NEEDS THE INVITE. Without this the first authenticated
  // request to arrive took it, whoever it belonged to: the host texted his
  // friend a link and a third account could sit down first, leaving the friend
  // with `room_full` and no way to evict the stranger. A رجعة's named guest
  // needs no key — the seat already carries his id, which is a stronger claim
  // than the link.
  if (room.guestUserId === null && !joinKeyMatches(room.joinKey, offeredKey)) {
    return { ok: false, code: "needs_key" }
  }
  const started = startRoom(deps.users, room, user.id, now)
  deps.hub.arm(started.code, started.turnDeadlineAt, now)
  return { ok: true, room: started, joined: true }
}

/**
 * «انسحب» on an active room, «أغلق الغرفة» on a waiting one — a player ends his
 * own room. A spectator cannot. Closing a WAITING room also refuses any knocker
 * still at the door (there is no seat to forfeit — his poll just turns to
 * `rejected`).
 */
export function resignRoom(deps: RoomDeps, room: RoomRow, user: UserRow, now = Date.now()): JoinOutcome {
  if (seatOf(room, user.id) === null) return { ok: false, code: "not_a_player" }
  if (room.status === "done") return { ok: true, room, joined: false }
  const winner = room.status === "active" ? opponentOf(room, user.id) : null
  if (room.status === "waiting") rejectPendingKnocks(deps.users, room.id, now)
  const ended = endRoom(deps.users, room, winner, room.status === "active" ? "resign" : "abandoned", now)
  deps.hub.disarm(ended.code)
  return { ok: true, room: ended, joined: false }
}

export type RematchOutcome = { ok: true; room: RoomRow; created: boolean } | { ok: false; code: string }

/**
 * «رجعة» — v2.md §5's «rematch button swaps roles».
 *
 * The seats exchange: whoever recited the opening بيت last time answers first
 * this time. The new room is `waiting` with its guest already named, so the
 * clock does not start until the second player is actually there — a rematch
 * that began the moment one person pressed a button would be won by whoever
 * was still looking at the screen.
 *
 * It is idempotent by construction: the new code is written onto the OLD room,
 * so the second player to press the button (and the player who reconnects five
 * minutes later, and the polling fallback) all discover the same room instead
 * of opening a third one.
 */
export function rematchRoom(deps: RoomDeps, room: RoomRow, user: UserRow, now = Date.now()): RematchOutcome {
  if (seatOf(room, user.id) === null) return { ok: false, code: "not_a_player" }
  if (room.status !== "done") return { ok: false, code: "room_not_active" }
  if (room.rematchCode !== null) {
    const existing = findRoomByCode(deps.users, room.rematchCode)
    if (existing) return { ok: true, room: existing, created: false }
  }
  if (room.guestUserId === null) return { ok: false, code: "not_a_player" }
  // A رجعة seats the two same players again (swapped). If either has since
  // blocked the other (Track 3), there is no rematch to open.
  if (blockExistsBetween(deps.users, room.hostUserId, room.guestUserId)) return { ok: false, code: "blocked" }

  const played = chainTurns(roomTurns(deps.users, room.id))
    .map((t) => t.baitId)
    .filter((id): id is number => id !== null)
  // A رجعة inherits the ديوان: the same two people, the same rules, the same
  // shelf — including its opening بيت. A shelf its curator has deleted since
  // (`albumId` now naming nothing) simply opens an ordinary rematch.
  const shelf = room.albumId === null ? null : findAlbumById(deps.users, room.albumId)
  const pool = shelf === null ? undefined : albumPool(deps.db, deps.users, shelf).baitIds
  const opening = randomStartingBait(deps.db, played, pool)
  if (opening === null) return { ok: false, code: "no_bait" }

  const next = createRoom(deps.users, {
    // the seats swap — the old guest opens the new مساجلة
    hostUserId: room.guestUserId,
    guestUserId: room.hostUserId,
    startingBaitId: num(opening.b_id),
    startingPoemId: num(opening.p_id),
    mode: room.mode,
    timerS: room.timerS,
    strikes: room.strikes,
    albumId: shelf?.id ?? null,
    now,
  })
  setRematchCode(deps.users, room.id, next.code, now)
  return { ok: true, room: next, created: true }
}

/** Rows for `#/room/<code>`'s «الغرفة» links — unused by the profile page's own query. */
export function roomsForUser(users: UsersDb, userId: number, limit: number): RoomRow[] {
  const rows = users
    .q(
      `SELECT ${ROOM_COLS} FROM rooms WHERE host_user_id = ?1 OR guest_user_id = ?1
       ORDER BY created_at DESC, id DESC LIMIT ?2`,
    )
    .all(userId, limit) as unknown[]
  return rows.map((r) => roomRow(r)!).filter(Boolean)
}
