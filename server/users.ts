/**
 * `server/users.ts` — the ONE writable database in قريض (v2.md §4).
 *
 * The corpus (`data/qarid.db`) is a build artefact opened `readOnly` +
 * `query_only=1` and that invariant does not bend, so accounts, sessions and —
 * from §5 — مساجلة rooms live in a second, separate handle:
 * `data/qarid-users.db`, `USERS_DB_PATH` to move it. Two databases, two rules:
 * the corpus is immutable and shared, this one is mutable and small.
 *
 * Three things this module owns and nothing else may re-implement:
 *
 *  1. THE SCHEMA, including the tables §5's multiplayer agent will write logic
 *     against (`rooms`, `match_turns`). They are created HERE, at migration 1,
 *     precisely so that landing multiplayer is a code change and not a data
 *     migration — and so the profile page can already count matches (it reads
 *     zero, honestly, until the first room is played).
 *  2. PASSWORDS. `node:crypto` scrypt with a per-user salt, compared with
 *     `timingSafeEqual`, encoded in one self-describing string so the cost
 *     parameters can be raised later without a flag day.
 *  3. SESSIONS. The cookie carries 32 random bytes; the table stores only their
 *     SHA-256, so a stolen database file is not a set of live sessions.
 *
 * Everything here is synchronous (node:sqlite is) except the two scrypt
 * functions, which are deliberately async: scrypt at N=16384 is ~60 ms of
 * blocking CPU and this server has one event loop (CLAUDE.md).
 *
 * BOOT IS TOLERANT, exactly like the corpus: `openUsersDbIfWritable` returns
 * null when the file cannot be created or the directory is read-only, the
 * process logs one line and keeps serving — `/api/auth/*` then answers 503
 * instead of the server crash-looping under systemd.
 */

import fs from "node:fs"
import path from "node:path"
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto"
import { DatabaseSync, type StatementSync } from "node:sqlite"

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Session cookie name (v2.md §4). */
export const SESSION_COOKIE = "qarid_sess"

/** 90-day rolling session. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * A session is re-stamped (table + cookie) once it is more than a day old.
 * Rolling, but not on every request: refreshing a 90-day expiry to the
 * millisecond on each `/api/auth/me` would be one UPDATE per page view for a
 * difference no one can observe.
 */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

/** Longest `User-Agent` kept beside a session (it is for the reader, not a key). */
const MAX_UA = 200

/** Schema version this build expects; `PRAGMA user_version` is the ledger. */
export const USERS_SCHEMA_VERSION = 4

// ─────────────────────────────────────────────────────────────────────────────
// Handle
// ─────────────────────────────────────────────────────────────────────────────

export type UsersDb = {
  raw: DatabaseSync
  /** prepared-statement cache — the same LRU-free shape as `server/db.ts` */
  q(sql: string): StatementSync
  path: string
  close(): void
}

/**
 * Pragmas for a small, writable, single-process database.
 *
 * WAL so a reader is never blocked by the writer (the §5 room polling fallback
 * reads while a turn is being written); `synchronous = NORMAL` because a lost
 * final commit after a power cut costs one duel turn, not a corpus;
 * `foreign_keys = ON` because every table here hangs off `users(id)` and a
 * deleted account must not leave sessions behind (v2.md §4: "owner can delete a
 * row"); `busy_timeout` so a concurrent writer waits instead of throwing.
 */
export const WRITE_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
] as const

/**
 * Migrations, in order. Index i takes `user_version` from i to i+1, and a
 * migration NEVER changes once it has shipped — a new step is a new entry.
 */
const MIGRATIONS: ReadonlyArray<(raw: DatabaseSync) => void> = [
  /* 0 → 1: accounts, sessions, the arsenal snapshot, and §5's match tables. */
  (raw) => {
    raw.exec(`
      CREATE TABLE users (
        id           INTEGER PRIMARY KEY,
        username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        pass_hash    TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ua         TEXT
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE INDEX sessions_expiry ON sessions(expires_at);

      -- The opt-in ترسانة snapshot (v2.md §4). One row per user, replaced
      -- wholesale; localStorage stays the source of truth for solo play, this
      -- is only what the profile page shows to a visitor.
      CREATE TABLE profile_arsenal (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        snapshot   TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- ── v2.md §5: مساجلة rooms. Created now, written by the multiplayer
      -- agent. Every column that section names is here, plus the four the
      -- server-authoritative clock needs (started_at/ended_at/turn_deadline_at/
      -- updated_at) and strikes, which §5 makes configurable 1–3 at creation.
      CREATE TABLE rooms (
        id               INTEGER PRIMARY KEY,
        code             TEXT NOT NULL UNIQUE COLLATE NOCASE,
        host_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        guest_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        starting_bait_id INTEGER NOT NULL,
        mode             TEXT NOT NULL CHECK (mode IN ('rhyme', 'literal')),
        timer_s          INTEGER,
        strikes          INTEGER NOT NULL DEFAULT 3,
        status           TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'done')),
        winner_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        end_reason       TEXT,
        created_at       INTEGER NOT NULL,
        started_at       INTEGER,
        ended_at         INTEGER,
        turn_deadline_at INTEGER,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX rooms_host ON rooms(host_user_id, created_at DESC);
      CREATE INDEX rooms_guest ON rooms(guest_user_id, created_at DESC);
      CREATE INDEX rooms_status ON rooms(status, updated_at DESC);

      -- One recited بيت. verdict is what the SAME verify pipeline said, so a
      -- strike is a row and not a counter that can drift from the transcript.
      CREATE TABLE match_turns (
        room_id   INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        turn_no   INTEGER NOT NULL,
        user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        bait_id   INTEGER,
        poem_id   INTEGER,
        text      TEXT,
        verdict   TEXT NOT NULL DEFAULT 'ok',
        played_at INTEGER NOT NULL,
        ms_taken  INTEGER,
        PRIMARY KEY (room_id, turn_no)
      );
      CREATE INDEX match_turns_user ON match_turns(user_id, played_at DESC);
    `)
  },

  /*
   * 1 → 2: `rooms.rematch_code` (v2.md §5, «rematch button swaps roles»).
   *
   * «رجعة» opens a SECOND room with the seats exchanged, and both players have
   * to be sent to it — including the one whose socket dropped ten seconds
   * earlier and who will come back to the old code. So the old room has to
   * remember the new one: with the link stored, a reconnect, a page reload and
   * the polling fallback all discover the rematch by reading the same snapshot
   * they were already reading. In memory it would have been a broadcast that
   * only the connected half received.
   */
  (raw) => {
    raw.exec(`ALTER TABLE rooms ADD COLUMN rematch_code TEXT`)
  },

  /*
   * 2 → 3: `rooms.join_key` — the secret the six-letter code is not.
   *
   * The code is SPOKEN, so it is short: 14³ × 5³ = 343,000 values, ~18 bits.
   * It was also the only thing guarding a seat — `joinRoom` admitted any
   * authenticated request that arrived first — and neither `/state` nor
   * `/join` was rate-limited, so the whole space was measured at 6,412 probes
   * a second in-process: a full sweep in minutes, with every `waiting` room
   * snipeable and every active room's transcript readable. A code identifies a
   * room; this is what proves you were INVITED to it.
   *
   * Existing rows are backfilled rather than left null, so «no key» never
   * means «anyone»: a room open at deploy time simply needs a fresh link, and
   * a room is minutes long.
   */
  (raw) => {
    raw.exec(`
      ALTER TABLE rooms ADD COLUMN join_key TEXT;
      UPDATE rooms SET join_key = lower(hex(randomblob(12)));
    `)
  },

  /*
   * 3 → 4: `room_knocks` — knock-to-join (owner's «أملِ عليه الرمز»).
   *
   * The keyed link stays the instant door; this is the OTHER door, for a guest
   * who reached the room by voice (the six spoken letters, no key). A knock is
   * a pending request the host accepts or rejects — one row per (room, user),
   * so a re-knock after a rejection REPLACES the old row rather than piling up,
   * and `ON DELETE CASCADE` off `rooms(id)` means the stale-room purge and the
   * account-delete both take the knocks with them. It is deliberately NOT part
   * of `match_turns`: a knocker is not a player and owns no بيت until the host
   * seats him, and until then he must not read the transcript at all.
   */
  (raw) => {
    raw.exec(`
      CREATE TABLE room_knocks (
        room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status     TEXT NOT NULL CHECK (status IN ('pending', 'rejected')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, user_id)
      );
      CREATE INDEX room_knocks_room ON room_knocks(room_id, status);
    `)
  },
]

/** Bring an open handle up to `USERS_SCHEMA_VERSION`. Idempotent. */
export function migrate(raw: DatabaseSync): number {
  const row = raw.prepare("PRAGMA user_version").get() as { user_version: number } | undefined
  let version = Number(row?.user_version ?? 0)
  if (version > MIGRATIONS.length) {
    // A database written by a NEWER build. Refusing is the only safe answer:
    // running an old server against a new schema silently drops columns.
    throw new Error(`users db is at schema ${version}, this build knows ${MIGRATIONS.length}`)
  }
  while (version < MIGRATIONS.length) {
    const step = MIGRATIONS[version]!
    raw.exec("BEGIN")
    try {
      step(raw)
      // PRAGMA takes no bound parameters; `version` is a loop index, not input.
      raw.exec(`PRAGMA user_version = ${version + 1}`)
      raw.exec("COMMIT")
    } catch (err) {
      raw.exec("ROLLBACK")
      throw err
    }
    version += 1
  }
  return version
}

/** Open (creating the file and its directory) and migrate. Throws on failure. */
export function openUsersDb(dbPath: string): UsersDb {
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const raw = new DatabaseSync(dbPath)
  try {
    for (const pragma of WRITE_PRAGMAS) raw.exec(pragma)
    migrate(raw)
    // A write PROBE, and the reason this is not paranoia: a database whose file
    // already exists in a directory the process cannot write to opens fine and
    // reads fine — it fails at the first INSERT, i.e. in front of a reader who
    // just typed a password. `BEGIN IMMEDIATE` takes the write lock (and in WAL
    // creates the -wal/-shm sidecars) without changing a byte, so the failure
    // happens here, at boot, where it becomes one honest log line.
    raw.exec("BEGIN IMMEDIATE")
    raw.exec("COMMIT")
  } catch (err) {
    raw.close()
    throw err
  }

  const cache = new Map<string, StatementSync>()
  return {
    raw,
    path: dbPath,
    q(sql) {
      const hit = cache.get(sql)
      if (hit !== undefined) return hit
      const stmt = raw.prepare(sql)
      cache.set(sql, stmt)
      return stmt
    },
    close() {
      cache.clear()
      raw.close()
    },
  }
}

/**
 * Boot-time tolerant open — the accounts twin of `openDbIfPresent`.
 *
 * A box where `data/` is read-only (or the file is owned by someone else) must
 * still serve the ديوان: the corpus is the site, accounts are an addition to
 * it. So this never throws. `null` means `/api/auth/*` answers 503 and the
 * masthead simply shows nothing to log into.
 */
export function openUsersDbIfWritable(dbPath: string): UsersDb | null {
  try {
    return openUsersDb(dbPath)
  } catch (err) {
    console.warn(`[qarid] users db unavailable at ${dbPath}: ${(err as Error).message} — /api/auth/* will answer 503`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Passwords
// ─────────────────────────────────────────────────────────────────────────────

/**
 * scrypt parameters. N=16384/r=8/p=1 is ~16 MB and ~60 ms per hash on this box
 * — the standard interactive setting, and well inside node's 32 MB default
 * `maxmem`. They are stored IN the hash string, so raising them later
 * re-verifies old passwords with their own parameters.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const
const SALT_BYTES = 16

function scryptAsync(password: string, salt: Buffer, keylen: number, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, keylen, params, (err, key) => {
      if (err) reject(err)
      else resolve(key as Buffer)
    })
  })
}

/** `scrypt$N$r$p$<salt b64>$<hash b64>` — self-describing, one field. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`
}

/**
 * Constant-time verify. An unparseable or foreign hash is `false`, never a
 * throw — a corrupt row must not 500 the login route.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  // A hostile row could otherwise ask for 2 GB of scrypt; these are the widest
  // parameters this build will ever have written.
  if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4]!, "base64")
    expected = Buffer.from(parts[5]!, "base64")
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  let key: Buffer
  try {
    key = await scryptAsync(password, salt, expected.length, { N, r, p })
  } catch {
    return false
  }
  return key.length === expected.length && timingSafeEqual(key, expected)
}

/**
 * A hash of nothing anyone knows, verified against when the username does not
 * exist — so a wrong NAME and a wrong PASSWORD cost the same wall-clock time
 * and the login route cannot be used to enumerate accounts. Built once, lazily.
 */
let dummyHash: Promise<string> | null = null
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString("base64"))
  return dummyHash
}

// ─────────────────────────────────────────────────────────────────────────────
// Session tokens
// ─────────────────────────────────────────────────────────────────────────────

/** 32 random bytes, base64url — what the cookie carries. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url")
}

/** What the TABLE carries. A dumped users.db is not a drawer of live sessions. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

export type UserRow = {
  id: number
  username: string
  display_name: string
  pass_hash: string
  created_at: number
  last_seen: number
}

export type SessionRow = {
  token_hash: string
  user_id: number
  created_at: number
  expires_at: number
  ua: string | null
}

/** SQLite gives back nulls and bigints on occasion; normalise at the door. */
function userRow(row: unknown): UserRow | null {
  if (!row) return null
  const r = row as Record<string, unknown>
  return {
    id: Number(r.id),
    username: String(r.username),
    display_name: String(r.display_name),
    pass_hash: String(r.pass_hash),
    created_at: Number(r.created_at),
    last_seen: Number(r.last_seen),
  }
}

const USER_COLS = "id, username, display_name, pass_hash, created_at, last_seen"

export function findUserByUsername(db: UsersDb, username: string): UserRow | null {
  return userRow(db.q(`SELECT ${USER_COLS} FROM users WHERE username = ? COLLATE NOCASE`).get(username))
}

export function findUserById(db: UsersDb, id: number): UserRow | null {
  return userRow(db.q(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id))
}

/**
 * Insert. `null` — not a throw — when the name is taken, because "taken" is an
 * ordinary answer to a registration form and the UNIQUE index is the only
 * check that cannot race a concurrent signup.
 */
export function createUser(
  db: UsersDb,
  input: { username: string; displayName: string; passHash: string; now: number },
): UserRow | null {
  try {
    db.q("INSERT INTO users (username, display_name, pass_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)").run(
      input.username,
      input.displayName,
      input.passHash,
      input.now,
      input.now,
    )
  } catch (err) {
    if (isUniqueViolation(err)) return null
    throw err
  }
  return findUserByUsername(db, input.username)
}

/** SQLITE_CONSTRAINT_UNIQUE (2067) / SQLITE_CONSTRAINT_PRIMARYKEY (1555). */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { errcode?: number }).errcode
  if (code === 2067 || code === 1555) return true
  return /UNIQUE constraint failed/i.test((err as Error)?.message ?? "")
}

export function setDisplayName(db: UsersDb, userId: number, displayName: string): void {
  db.q("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, userId)
}

/** Re-key an account. The caller MUST revoke the old sessions (see below). */
export function setPassword(db: UsersDb, userId: number, passHash: string): void {
  db.q("UPDATE users SET pass_hash = ? WHERE id = ?").run(passHash, userId)
}

/**
 * Drop EVERY session a user holds — cookie and bearer live in the one table, so
 * one DELETE revokes both (docs/roadmap-mobile.md §M1: a password change must
 * kill all tokens). Returns how many rows went, for the caller's audit line.
 */
export function deleteUserSessions(db: UsersDb, userId: number): number {
  return Number(db.q("DELETE FROM sessions WHERE user_id = ?").run(userId).changes ?? 0)
}

export function touchUser(db: UsersDb, userId: number, now: number): void {
  db.q("UPDATE users SET last_seen = ? WHERE id = ?").run(now, userId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

export function createSession(
  db: UsersDb,
  input: { userId: number; tokenHash: string; now: number; ttlMs?: number; ua?: string | null },
): SessionRow {
  const expires = input.now + (input.ttlMs ?? SESSION_TTL_MS)
  const ua = input.ua ? input.ua.slice(0, MAX_UA) : null
  db.q("INSERT OR REPLACE INTO sessions (token_hash, user_id, created_at, expires_at, ua) VALUES (?, ?, ?, ?, ?)").run(
    input.tokenHash,
    input.userId,
    input.now,
    expires,
    ua,
  )
  return { token_hash: input.tokenHash, user_id: input.userId, created_at: input.now, expires_at: expires, ua }
}

/** The live user behind a cookie, or null (expired sessions are swept as met). */
export function sessionUser(db: UsersDb, tokenHash: string, now: number): { user: UserRow; session: SessionRow } | null {
  const row = db
    .q("SELECT token_hash, user_id, created_at, expires_at, ua FROM sessions WHERE token_hash = ?")
    .get(tokenHash) as Record<string, unknown> | undefined
  if (!row) return null
  const session: SessionRow = {
    token_hash: String(row.token_hash),
    user_id: Number(row.user_id),
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    ua: row.ua === null || row.ua === undefined ? null : String(row.ua),
  }
  if (session.expires_at <= now) {
    deleteSession(db, tokenHash)
    return null
  }
  const user = findUserById(db, session.user_id)
  if (!user) {
    deleteSession(db, tokenHash)
    return null
  }
  return { user, session }
}

export function refreshSession(db: UsersDb, tokenHash: string, expiresAt: number): void {
  db.q("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(expiresAt, tokenHash)
}

export function deleteSession(db: UsersDb, tokenHash: string): void {
  db.q("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash)
}

/** Housekeeping: called on login/register, where one extra DELETE is free. */
export function purgeExpiredSessions(db: UsersDb, now: number): number {
  return Number(db.q("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes ?? 0)
}

/** A `waiting` room nobody ever joined is stale after this long (6 hours). */
export const WAITING_ROOM_TTL_MS = 6 * 60 * 60_000

/** A `done` room's transcript is kept this long for a re-read, then purged (7 days). */
export const DONE_ROOM_TTL_MS = 7 * 24 * 60 * 60_000

/**
 * Purge stale rooms — the housekeeping twin of `purgeExpiredSessions`, run on
 * the same login/register path.
 *
 * A `waiting` room whose host opened it and wandered off is a dead invite: it
 * holds a code out of the 343,000-value space and shows nothing to anyone. A
 * `done` room is a finished transcript — worth keeping for a re-read (a رجعة
 * link, a profile «سجلّك» click) but not forever. Both are matched on the
 * `rooms(status, updated_at DESC)` index, so this is two cheap range deletes,
 * and `match_turns`/`room_knocks` fall away with each room by `ON DELETE
 * CASCADE`. An `active` room is never touched: its clock is live and the only
 * thing that ends it is a turn, a resignation or the deadline.
 */
export function purgeStaleRooms(db: UsersDb, now: number): number {
  const waiting = Number(
    db.q("DELETE FROM rooms WHERE status = 'waiting' AND updated_at <= ?").run(now - WAITING_ROOM_TTL_MS).changes ?? 0,
  )
  const done = Number(
    db.q("DELETE FROM rooms WHERE status = 'done' AND updated_at <= ?").run(now - DONE_ROOM_TTL_MS).changes ?? 0,
  )
  return waiting + done
}

// ─────────────────────────────────────────────────────────────────────────────
// Arsenal snapshot
// ─────────────────────────────────────────────────────────────────────────────

export function putArsenal(db: UsersDb, userId: number, snapshot: string, now: number): void {
  db.q("INSERT OR REPLACE INTO profile_arsenal (user_id, snapshot, updated_at) VALUES (?, ?, ?)").run(
    userId,
    snapshot,
    now,
  )
}

export function getArsenal(db: UsersDb, userId: number): { snapshot: string; updatedAt: number } | null {
  const row = db.q("SELECT snapshot, updated_at FROM profile_arsenal WHERE user_id = ?").get(userId) as
    | { snapshot: string; updated_at: number }
    | undefined
  return row ? { snapshot: String(row.snapshot), updatedAt: Number(row.updated_at) } : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Match statistics (v2.md §4 — reads §5's tables)
// ─────────────────────────────────────────────────────────────────────────────

export type DuelStatsRow = {
  matches: number
  wins: number
  losses: number
  turns: number
  bestChain: number
}

/**
 * The profile's duel numbers, read straight off `rooms` / `match_turns`.
 *
 * Every one of these returns 0 today because no room has been played — and
 * that is the point: they are queries, not placeholders, so the day §5's
 * multiplayer agent writes the first row the profile page is already correct.
 * `bestChain` is the longest run of ACCEPTED turns this player strung together
 * inside one room, which is the multiplayer twin of أطول سلسلة.
 */
export function duelStats(db: UsersDb, userId: number): DuelStatsRow {
  const played = db
    .q(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN winner_user_id = ?1 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN winner_user_id IS NOT NULL AND winner_user_id <> ?1 THEN 1 ELSE 0 END) AS losses
       FROM rooms
       WHERE status = 'done' AND (host_user_id = ?1 OR guest_user_id = ?1)`,
    )
    .get(userId) as { n: number; wins: number | null; losses: number | null }

  const turns = db.q("SELECT COUNT(*) AS n FROM match_turns WHERE user_id = ? AND verdict = 'ok'").get(userId) as {
    n: number
  }

  // Longest consecutive run of accepted turns by this player within one room.
  // The window function is over ≤ a few hundred rows per player; SQLite in
  // node:sqlite carries them (3.53.4).
  const chain = db
    .q(
      `SELECT COALESCE(MAX(run), 0) AS best FROM (
         SELECT COUNT(*) AS run
         FROM (
           SELECT room_id, turn_no,
                  ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY turn_no) -
                  ROW_NUMBER() OVER (PARTITION BY room_id, verdict ORDER BY turn_no) AS grp,
                  verdict
           FROM match_turns
           WHERE user_id = ?
         )
         WHERE verdict = 'ok'
         GROUP BY room_id, grp
       )`,
    )
    .get(userId) as { best: number }

  return {
    matches: Number(played.n ?? 0),
    wins: Number(played.wins ?? 0),
    losses: Number(played.losses ?? 0),
    turns: Number(turns.n ?? 0),
    bestChain: Number(chain.best ?? 0),
  }
}

export type RecentMatchRow = {
  code: string
  status: "waiting" | "active" | "done"
  opponent: string | null
  result: "win" | "loss" | "open"
  turns: number
  createdAt: number
  endedAt: number | null
}

/** «آخر المساجلات» on a profile — newest first, paginated by `limit`. */
export function recentMatches(db: UsersDb, userId: number, limit: number): RecentMatchRow[] {
  const rows = db
    .q(
      `SELECT r.code AS code,
              r.status AS status,
              r.created_at AS created_at,
              r.ended_at AS ended_at,
              r.winner_user_id AS winner_user_id,
              CASE WHEN r.host_user_id = ?1 THEN g.display_name ELSE h.display_name END AS opponent,
              (SELECT COUNT(*) FROM match_turns t WHERE t.room_id = r.id) AS turns
       FROM rooms r
       LEFT JOIN users h ON h.id = r.host_user_id
       LEFT JOIN users g ON g.id = r.guest_user_id
       WHERE r.host_user_id = ?1 OR r.guest_user_id = ?1
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?2`,
    )
    .all(userId, limit) as Array<Record<string, unknown>>

  return rows.map((row) => {
    const status = String(row.status) as RecentMatchRow["status"]
    const winner = row.winner_user_id === null || row.winner_user_id === undefined ? null : Number(row.winner_user_id)
    const result: RecentMatchRow["result"] =
      status !== "done" || winner === null ? "open" : winner === userId ? "win" : "loss"
    return {
      code: String(row.code),
      status,
      opponent: row.opponent === null || row.opponent === undefined ? null : String(row.opponent),
      result,
      turns: Number(row.turns ?? 0),
      createdAt: Number(row.created_at),
      endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    }
  })
}
