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
import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto"
import { DatabaseSync, type StatementSync } from "node:sqlite"

import type { AvatarMime } from "../shared/schema.ts"

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
export const USERS_SCHEMA_VERSION = 10

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

  /*
   * 4 → 5: `user_avatars` — a custom profile picture (owner's request).
   *
   * The BYTES live in a BLOB beside the mime and a short etag (a hash of the
   * bytes), so the serve route can lock the `Content-Type` to the STORED value
   * — never a sniff, never the client's claim — and the versioned URL busts a
   * cache the instant the picture changes. One row per user, `ON DELETE
   * CASCADE` off `users(id)` so a deleted account takes its picture with it,
   * and its own table (not columns on `users`) so the common `SELECT` that
   * hydrates a session never drags a quarter-megabyte blob off disk. The
   * upload is validated by magic bytes before it ever reaches here; SVG and
   * anything that is not raster PNG/JPEG/WEBP is refused at the door.
   */
  (raw) => {
    raw.exec(`
      CREATE TABLE user_avatars (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
        bytes      BLOB NOT NULL,
        etag       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  },

  /*
   * 5 → 6: `user_recovery` — a no-email password recovery code (Play launch).
   *
   * قريض has no email, so it had no reset at all — fine for one owner, painful
   * for a public user who forgets a password. The answer is a RECOVERY CODE:
   * strong entropy, shown ONCE at signup, and stored here ONLY as a scrypt hash
   * (`code_hash`) — never the plaintext, never a log, never a URL. It is the
   * exact twin of `pass_hash`: a dumped `qarid-users.db` yields neither a live
   * password nor a live recovery code, only two scrypt digests.
   *
   * `fail_count`/`locked_until` are the PER-USERNAME throttle the IP rate limit
   * cannot give: a distributed guesser rotating source IPs still has to answer
   * to this counter, which locks an account's reset door for a window after a
   * few wrong codes. It resets on any success and on every rotation. One row per
   * user, `ON DELETE CASCADE` off `users(id)` so a deleted account takes its
   * recovery secret with it, and its own table (not a column on `users`) so the
   * hot `SELECT` that hydrates a session never reads the recovery digest.
   */
  (raw) => {
    raw.exec(`
      CREATE TABLE user_recovery (
        user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        code_hash    TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        fail_count   INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0
      );
    `)
  },

  /*
   * 6 → 7: UGC moderation — reports, blocks, and account suspension (Track 3).
   *
   * A public app with user content and live 1v1 play needs three things, and
   * they are three tables (plus one column) so each has exactly the lifecycle it
   * should:
   *
   *  • `user_reports` — one row per report a player files against another. The
   *    REPORTER is `ON DELETE SET NULL`, so a report survives its author closing
   *    their account (the owner still needs to see it); the TARGET is
   *    `ON DELETE CASCADE`, because a report about a deleted account is moot. The
   *    reason is a closed enum on the wire (`ReportReasonSchema`) but stored as
   *    free TEXT — the database is not the place to re-encode an app-level enum,
   *    and a future reason must not need a migration.
   *  • `user_blocks` — a directed edge: `blocker` no longer meets `blocked`. Both
   *    sides `ON DELETE CASCADE`, because a block involving a deleted account is
   *    meaningless. The `(blocker, blocked)` primary key makes a re-block a
   *    no-op, and the `blocked` index is what the room join/knock path reads to
   *    ask «is there a block EITHER way between these two» cheaply.
   *  • `users.suspended_until` — 0 means active; a timestamp in the future means
   *    an admin has suspended the account until then. It is a column on `users`
   *    (not a table) precisely because login already reads that row, so the gate
   *    costs no extra query on the hottest path. Enforcement is: login refuses
   *    while it is in force, and suspending revokes every session, so a suspended
   *    account is both logged out and unable to return.
   */
  (raw) => {
    raw.exec(`
      CREATE TABLE user_reports (
        id          INTEGER PRIMARY KEY,
        reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        target_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason      TEXT NOT NULL,
        note        TEXT,
        context     TEXT,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        created_at  INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX user_reports_status ON user_reports(status, created_at DESC);
      CREATE INDEX user_reports_target ON user_reports(target_id);

      CREATE TABLE user_blocks (
        blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id)
      );
      CREATE INDEX user_blocks_blocked ON user_blocks(blocked_id);

      ALTER TABLE users ADD COLUMN suspended_until INTEGER NOT NULL DEFAULT 0;
    `)
  },

  /*
   * 7 → 8: الدواوين — a reader's own compiled ديوان.
   *
   * Two tables, and the second one carries the whole design decision.
   *
   *  • `albums` — the shelf. `code` is UNIQUE and is the capability for an
   *    unlisted ديوان (ten characters of the room alphabet; there is no knock
   *    and no second secret here, so the name has to BE the credential —
   *    `AlbumCodeSchema`). `owner_user_id` cascades: a deleted account takes its
   *    دواوين with it, like every other table hanging off `users(id)`.
   *  • `album_baits` — the أبيات, ANCHORED BY CONTENT. `h_full` is the ingest's
   *    own hash of the normalized بيت (`baitAnchor`, shared/arabic.ts), stored
   *    as TEXT because it is a signed 64-bit value that JSON cannot carry and
   *    SQLite would happily coerce; `position` is the curator's order; and the
   *    three `snapshot_*` columns are what the بيت looked like the day it was
   *    added.
   *
   * Why not `bait_id`. `public_id` is `q<row id>` for 73 % of قصائد and every id
   * in the artefact moves on `npm run ingest` (CLAUDE.md §The artefact: the last
   * rebuild moved 442 قصائد and renumbered the 73 %). A ديوان keyed on ids would
   * therefore quietly re-point at other people's poetry — the worst possible
   * failure for a collection whose entire value is that the reader chose these
   * lines. The content hash survives the rebuild, `baits_hfull` indexes it, and
   * the snapshot is the floor under the one case the hash cannot answer: a بيت
   * whose only copy the dedup pass dropped still renders, marked as absent from
   * today's ديوان rather than silently missing from the shelf.
   *
   * `UNIQUE(album_id, h_full)` makes «أضِف القصيدة» idempotent — a second press
   * adds the أبيات that were not there and nothing else — and the index on
   * `(album_id, position)` is what the page reads.
   */
  (raw) => {
    raw.exec(`
      CREATE TABLE albums (
        id            INTEGER PRIMARY KEY,
        code          TEXT NOT NULL UNIQUE COLLATE NOCASE,
        owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        description   TEXT,
        visibility    TEXT NOT NULL DEFAULT 'private'
                      CHECK (visibility IN ('private', 'unlisted', 'public')),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX albums_owner ON albums(owner_user_id, updated_at DESC);

      CREATE TABLE album_baits (
        album_id      INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        h_full        TEXT NOT NULL,
        position      INTEGER NOT NULL,
        snapshot_sadr TEXT NOT NULL,
        snapshot_ajuz TEXT,
        snapshot_poet TEXT NOT NULL,
        added_at      INTEGER NOT NULL,
        UNIQUE (album_id, h_full)
      );
      CREATE INDEX album_baits_order ON album_baits(album_id, position);
    `)
  },

  /*
   * 8 → 9: المكتبة, and a report that can name a ديوان.
   *
   *  • `saved_albums` — «أضِف إلى مكتبتك». A directed edge from a reader to
   *    somebody else's shelf, and nothing more: no copy of the title, no copy of
   *    the أبيات. That is the whole point of saving a shelf rather than
   *    duplicating it — the curator keeps curating and your row follows him. It
   *    also means the gate is re-read on every listing, so a ديوان its owner
   *    takes back to `private` stops rendering the moment he does, with the row
   *    still there to be removed (`SavedAlbumSchema.gated`). Both sides
   *    `ON DELETE CASCADE`: a deleted account takes its مكتبة, and a deleted
   *    ديوان takes every row that pointed at it.
   *  • `user_reports.target_album_id` — a report about a ديوان rather than about
   *    an account. `target_id` stays NOT NULL and still names the OWNER, because
   *    every moderation action the owner already has (reset the name, suspend,
   *    remove the avatar) targets an account and a shelf has a person behind it;
   *    the album column is what the two NEW actions take. `ON DELETE CASCADE` on
   *    the album, for the same reason the target is: a report about a ديوان its
   *    owner has since deleted is moot.
   */
  (raw) => {
    raw.exec(`
      CREATE TABLE saved_albums (
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
        saved_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, album_id)
      );
      CREATE INDEX saved_albums_user ON saved_albums(user_id, saved_at DESC);
      CREATE INDEX saved_albums_album ON saved_albums(album_id);

      ALTER TABLE user_reports ADD COLUMN target_album_id INTEGER
        REFERENCES albums(id) ON DELETE CASCADE;
      CREATE INDEX user_reports_album ON user_reports(target_album_id);
    `)
  },

  /*
   * 9 → 10: `rooms.album_id` — a مساجلة played INSIDE a ديوان.
   *
   * The memorization contest: the opening بيت comes off one reader's shelf and
   * both players must answer with أبيات that are on it. One nullable column is
   * the whole of it, because the shelf itself is already a table — the room
   * points at the ديوان and the constraint is READ from it on every turn, never
   * copied into a `room_album_baits` snapshot. That is the same choice
   * `saved_albums` made and for the same reason: a curator who prunes his shelf
   * mid-match has pruned the game, and a copy taken at creation would let the
   * room disagree with the page both players are looking at.
   *
   * `ON DELETE SET NULL`, not CASCADE: deleting a ديوان must not delete the
   * مساجلات played in it. The room simply loses the constraint and finishes as
   * an ordinary one — honest, since the shelf it was played inside no longer
   * exists, and the snapshot says so by carrying a null `album`.
   */
  (raw) => {
    raw.exec(`ALTER TABLE rooms ADD COLUMN album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL`)
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
// Recovery codes (no-email password recovery — Play launch)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crockford base32 — the alphabet a human can transcribe off a screen without a
 * lost character. It drops `I`, `L`, `O` and `U` on purpose: `I`/`L` read as
 * `1`, `O` as `0`, and `U` invites an unfortunate word. `canonicalizeRecoveryCode`
 * folds those look-alikes back in on the way IN, so a reader who writes `O` for
 * `0` still recovers their account.
 */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** Groups of five, four of them → 20 symbols → 100 bits. */
const RECOVERY_GROUPS = 4
const RECOVERY_GROUP_LEN = 5
/** The number of base32 symbols a code carries, dashes excluded. */
export const RECOVERY_CODE_SYMBOLS = RECOVERY_GROUPS * RECOVERY_GROUP_LEN

/**
 * A fresh recovery code, e.g. `K7QF2-9MXBA-3RJTN-VW8HC`.
 *
 * 100 bits of entropy read straight off `randomBytes` — five bits per symbol —
 * so the space is 2¹⁰⁰. Even against the per-username lock lifted and a
 * limiter-free server, a guesser answering one code every millisecond needs on
 * the order of 10¹⁹ years for even odds; the grouping is purely so a human can
 * copy it. Rejection-sampling nothing: 100 is a multiple of 8 AND of 5, so 13
 * random bytes carry ≥100 bits and each 5-bit slice maps to exactly one symbol.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(Math.ceil((RECOVERY_CODE_SYMBOLS * 5) / 8))
  let bits = 0
  let value = 0
  const symbols: string[] = []
  for (let i = 0; symbols.length < RECOVERY_CODE_SYMBOLS; ) {
    if (bits < 5) {
      value = (value << 8) | bytes[i]!
      bits += 8
      i += 1
    }
    bits -= 5
    symbols.push(RECOVERY_ALPHABET[(value >> bits) & 0x1f]!)
  }
  const groups: string[] = []
  for (let g = 0; g < RECOVERY_GROUPS; g++) {
    groups.push(symbols.slice(g * RECOVERY_GROUP_LEN, (g + 1) * RECOVERY_GROUP_LEN).join(""))
  }
  return groups.join("-")
}

/**
 * A typed recovery code → its canonical symbol string, or null when it is not
 * one. Dashes and spaces are dropped, the case is folded up, and the Crockford
 * look-alikes a reader is likely to write are mapped to the symbol they meant
 * (`O`→`0`, `I`/`L`→`1`) — so `k7qf2 9mxba 3rjtn vw8hc` and the on-screen form
 * verify identically. Anything with a symbol outside the alphabet, or of the
 * wrong length, is null and the route treats it as a wrong code (never a
 * different error — the code's shape must not be an oracle either).
 */
export function canonicalizeRecoveryCode(raw: string): string | null {
  const cleaned = raw
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
  if (cleaned.length !== RECOVERY_CODE_SYMBOLS) return null
  for (const ch of cleaned) {
    if (!RECOVERY_ALPHABET.includes(ch)) return null
  }
  return cleaned
}

/**
 * The scrypt hash a recovery code is STORED as — the same one-way function and
 * the same `timingSafeEqual` compare passwords use, over the CANONICAL symbol
 * string. Store this, never the code.
 */
export function hashRecoveryCode(code: string): Promise<string> {
  return hashPassword(code)
}

/** Constant-time verify of a canonical recovery code against its stored hash. */
export function verifyRecoveryCode(code: string, stored: string): Promise<boolean> {
  return verifyPassword(code, stored)
}

export type RecoveryRow = {
  code_hash: string
  updated_at: number
  fail_count: number
  locked_until: number
}

/** Store (replacing) a user's recovery hash; clears any failure/lock state. */
export function setRecovery(db: UsersDb, userId: number, codeHash: string, now: number): void {
  db.q(
    `INSERT INTO user_recovery (user_id, code_hash, updated_at, fail_count, locked_until)
     VALUES (?, ?, ?, 0, 0)
     ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, updated_at = excluded.updated_at,
                                        fail_count = 0, locked_until = 0`,
  ).run(userId, codeHash, now)
}

export function getRecovery(db: UsersDb, userId: number): RecoveryRow | null {
  const row = db
    .q("SELECT code_hash, updated_at, fail_count, locked_until FROM user_recovery WHERE user_id = ?")
    .get(userId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    code_hash: String(row.code_hash),
    updated_at: Number(row.updated_at),
    fail_count: Number(row.fail_count),
    locked_until: Number(row.locked_until),
  }
}

/** A few wrong codes, then the reset door is locked for a window. */
export const RECOVERY_MAX_FAILS = 5
export const RECOVERY_LOCK_MS = 15 * 60 * 1000

/**
 * Record one wrong recovery code for a user. On the `RECOVERY_MAX_FAILS`th
 * failure the account's reset door locks for `RECOVERY_LOCK_MS` and the counter
 * resets, so the next window starts clean. Returns whether the door is now
 * locked. A user with no recovery row cannot be attacked here, so this is a
 * no-op for them (they were the non-oracle dummy path).
 */
export function recordRecoveryFailure(
  db: UsersDb,
  userId: number,
  now: number,
  maxFails = RECOVERY_MAX_FAILS,
  lockMs = RECOVERY_LOCK_MS,
): boolean {
  const row = getRecovery(db, userId)
  if (!row) return false
  const nextCount = row.fail_count + 1
  if (nextCount >= maxFails) {
    db.q("UPDATE user_recovery SET fail_count = 0, locked_until = ? WHERE user_id = ?").run(now + lockMs, userId)
    return true
  }
  db.q("UPDATE user_recovery SET fail_count = ? WHERE user_id = ?").run(nextCount, userId)
  return false
}

/** Clear a user's recovery failure/lock state (on a successful verify). */
export function clearRecoveryFailures(db: UsersDb, userId: number): void {
  db.q("UPDATE user_recovery SET fail_count = 0, locked_until = 0 WHERE user_id = ?").run(userId)
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
  /** 0 = active; an epoch-ms timestamp in the future = suspended until then (Track 3) */
  suspended_until: number
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
    suspended_until: Number(r.suspended_until ?? 0),
  }
}

const USER_COLS = "id, username, display_name, pass_hash, created_at, last_seen, suspended_until"

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

/**
 * IRREVERSIBLY delete an account and every trace of it (a Google Play
 * requirement for an app with accounts). One transaction, and it leans on the
 * FK design `migrate()` laid down rather than deleting table by table:
 *
 *  • Truly the user's — `sessions`, `user_avatars`, `profile_arsenal`,
 *    `room_knocks`, and the rooms he HOSTED — are `ON DELETE CASCADE` off
 *    `users(id)`, so the single `DELETE FROM users` at the end takes all of
 *    them. A hosted room is the host's to keep or destroy; it goes with him.
 *  • SHARED match history — a room he JOINED as guest, the `winner_user_id` of
 *    a match he won, and each `match_turns.user_id` he answered on — is
 *    `ON DELETE SET NULL`, so those rows SURVIVE with his reference blanked.
 *    The opponent's «آخر المساجلات» still lists the match and it opens without a
 *    dangling FK; `snapshot()` renders the emptied seat as «لاعب محذوف» (a room
 *    that STARTED — `started_at` set — with a null seat is a departed player,
 *    not an empty chair).
 *
 * Before the delete cascades, any room he was still LIVE in is settled so no
 * opponent is left staring at a clock that will never move: an active room ends
 * with the opponent as the winner («resign»), a waiting room is abandoned, and
 * a knocker at a door that is closing is refused. The codes of the rooms that
 * were live are returned so the route can push the ending to anyone still
 * watching — the rooms he hosted are gone by then and are simply skipped, which
 * is exactly what a spectator's poll would find.
 */
export function deleteUserAccount(db: UsersDb, userId: number, now: number): { endedRoomCodes: string[] } {
  db.raw.exec("BEGIN IMMEDIATE")
  try {
    // The live rooms whose OPPONENT should be told it is over — the ones he was
    // the GUEST in. Those survive his deletion (the host owns them), so there is
    // a room and a watcher to notify; a live room he HOSTED cascades away with
    // him, leaving nothing to broadcast to, so it is not named here.
    const live = db
      .q(`SELECT code FROM rooms WHERE guest_user_id = ?1 AND status IN ('waiting', 'active')`)
      .all(userId) as { code: string }[]

    // Active room he hosts → the guest wins by his leaving; he was the guest →
    // the host wins. A waiting room → nobody has a claim, it is abandoned.
    db.q(
      `UPDATE rooms SET status = 'done', winner_user_id = guest_user_id, end_reason = 'resign',
                        ended_at = ?2, turn_deadline_at = NULL, updated_at = ?2
       WHERE status = 'active' AND host_user_id = ?1`,
    ).run(userId, now)
    db.q(
      `UPDATE rooms SET status = 'done', winner_user_id = host_user_id, end_reason = 'resign',
                        ended_at = ?2, turn_deadline_at = NULL, updated_at = ?2
       WHERE status = 'active' AND guest_user_id = ?1`,
    ).run(userId, now)
    db.q(
      `UPDATE rooms SET status = 'done', winner_user_id = NULL, end_reason = 'abandoned',
                        ended_at = ?2, turn_deadline_at = NULL, updated_at = ?2
       WHERE status = 'waiting' AND (host_user_id = ?1 OR guest_user_id = ?1)`,
    ).run(userId, now)

    // A knocker still waiting on one of his (now-closing) rooms is refused; his
    // «بانتظار الإذن» poll turns to «لم يُؤذن لك». Knocks on his HOSTED rooms
    // would cascade away with the room anyway; this also covers a room he only
    // played in, which survives.
    db.q(
      `UPDATE room_knocks SET status = 'rejected', updated_at = ?2
       WHERE status = 'pending' AND room_id IN (SELECT id FROM rooms WHERE host_user_id = ?1 OR guest_user_id = ?1)`,
    ).run(userId, now)

    // The one delete that fans out: sessions (cookie AND bearer), avatar bytes,
    // arsenal snapshot, knocks, hosted rooms and — since migration 8 — his
    // دواوين and every بيت on them, by CASCADE; guest seats, won matches and
    // answered turns blanked by SET NULL.
    db.q("DELETE FROM users WHERE id = ?").run(userId)

    db.raw.exec("COMMIT")
    return { endedRoomCodes: live.map((r) => String(r.code)) }
  } catch (err) {
    try {
      db.raw.exec("ROLLBACK")
    } catch {
      /* the transaction was never opened */
    }
    throw err
  }
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
// Avatars (owner's request — a custom profile picture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The type of an uploaded avatar, decided by its MAGIC BYTES and nothing else.
 *
 * The client's `Content-Type` is a claim, not a fact: an SVG (which can carry a
 * `<script>`) or an HTML page renamed `photo.png` would sail past a header
 * check and then be served back to a browser. So the bytes themselves are read.
 * Only three raster signatures are accepted — PNG, JPEG, WEBP — and everything
 * else, SVG included, returns `null` and the route answers 415. WEBP is a RIFF
 * container, so both the `RIFF` prefix and the `WEBP` fourCC are required, or a
 * WAV renamed `.webp` would pass the prefix alone.
 */
export function detectImageMime(bytes: Buffer | Uint8Array): AvatarMime | null {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png"
  }
  // JPEG: FF D8 FF … (SOI + a marker). The third byte is always FF for a real
  // JFIF/EXIF stream; requiring it rejects a two-byte lookalike.
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg"
  }
  // WEBP: "RIFF" …4 size bytes… "WEBP".
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp"
  }
  return null
}

/** A short, stable etag for an avatar — the first 16 hex of the bytes' SHA-256. */
export function avatarEtag(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16)
}

/** Store (replacing) a user's avatar. The caller has already validated the bytes. */
export function putAvatar(db: UsersDb, userId: number, mime: AvatarMime, bytes: Buffer, now: number): string {
  const etag = avatarEtag(bytes)
  db.q("INSERT OR REPLACE INTO user_avatars (user_id, mime, bytes, etag, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    mime,
    bytes,
    etag,
    now,
  )
  return etag
}

export type AvatarRow = { mime: AvatarMime; bytes: Buffer; etag: string; updatedAt: number }

/** The stored avatar with its bytes — for the serve route only. */
export function getAvatar(db: UsersDb, userId: number): AvatarRow | null {
  const row = db.q("SELECT mime, bytes, etag, updated_at FROM user_avatars WHERE user_id = ?").get(userId) as
    | { mime: string; bytes: Uint8Array; etag: string; updated_at: number }
    | undefined
  if (!row) return null
  return {
    mime: String(row.mime) as AvatarMime,
    bytes: Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes),
    etag: String(row.etag),
    updatedAt: Number(row.updated_at),
  }
}

/**
 * The avatar's etag WITHOUT its bytes — what a DTO needs to build the versioned
 * URL. Kept separate so the profile/masthead/seat payloads never read the blob.
 */
export function getAvatarEtag(db: UsersDb, userId: number): string | null {
  const row = db.q("SELECT etag FROM user_avatars WHERE user_id = ?").get(userId) as { etag: string } | undefined
  return row ? String(row.etag) : null
}

/** Remove a user's avatar (revert to the نِيب fallback). Returns whether one went. */
export function deleteAvatar(db: UsersDb, userId: number): boolean {
  return Number(db.q("DELETE FROM user_avatars WHERE user_id = ?").run(userId).changes ?? 0) > 0
}

// ─────────────────────────────────────────────────────────────────────────────
// UGC moderation — reports, blocks, suspension (Track 3)
// ─────────────────────────────────────────────────────────────────────────────

/** File one report of `targetId` by `reporterId`. Free of any dedupe on purpose:
 *  three players reporting the same account is three signals, not one. */
export function createReport(
  db: UsersDb,
  input: {
    reporterId: number
    targetId: number
    reason: string
    note: string | null
    context: string | null
    /** the reported ديوان, when the report is about a shelf and not an account */
    targetAlbumId?: number | null
    now: number
  },
): void {
  db.q(
    `INSERT INTO user_reports (reporter_id, target_id, reason, note, context, target_album_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    input.reporterId,
    input.targetId,
    input.reason,
    input.note,
    input.context,
    input.targetAlbumId ?? null,
    input.now,
  )
}

export type ReportRow = {
  id: number
  reporter: string | null
  target: string | null
  reason: string
  note: string | null
  context: string | null
  status: "open" | "resolved"
  createdAt: number
  targetHasAvatar: boolean
  targetSuspendedUntil: number
  /** the reported ديوان, when there is one — enough of it to judge and to act */
  album: { code: string; title: string; description: string | null; visibility: AlbumRow["visibility"] } | null
}

/**
 * The owner's report queue. `status` filters it — «open» is the working set,
 * «all» the archive. Newest first, capped. It joins the reporter and target
 * usernames (a report about a since-deleted account shows a null name, never a
 * dangling id) and reports whether the target still has an avatar and a live
 * suspension, so the admin can decide the next action without a second lookup.
 */
export function listReports(db: UsersDb, opts: { status?: "open" | "resolved" | "all"; limit: number }): ReportRow[] {
  const status = opts.status ?? "open"
  const where = status === "all" ? "" : "WHERE r.status = ?1"
  const rows = db
    .q(
      `SELECT r.id AS id, r.reason AS reason, r.note AS note, r.context AS context, r.status AS status,
              r.created_at AS created_at,
              rep.username AS reporter, tgt.username AS target, tgt.suspended_until AS suspended_until,
              (SELECT 1 FROM user_avatars a WHERE a.user_id = r.target_id) AS has_avatar,
              alb.code AS album_code, alb.title AS album_title,
              alb.description AS album_description, alb.visibility AS album_visibility
       FROM user_reports r
       LEFT JOIN users rep ON rep.id = r.reporter_id
       LEFT JOIN users tgt ON tgt.id = r.target_id
       LEFT JOIN albums alb ON alb.id = r.target_album_id
       ${where}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ${status === "all" ? "?1" : "?2"}`,
    )
    .all(...(status === "all" ? [opts.limit] : [status, opts.limit])) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: Number(row.id),
    reporter: row.reporter === null || row.reporter === undefined ? null : String(row.reporter),
    target: row.target === null || row.target === undefined ? null : String(row.target),
    reason: String(row.reason),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    context: row.context === null || row.context === undefined ? null : String(row.context),
    status: String(row.status) as ReportRow["status"],
    createdAt: Number(row.created_at),
    targetHasAvatar: row.has_avatar !== null && row.has_avatar !== undefined,
    targetSuspendedUntil: Number(row.suspended_until ?? 0),
    album:
      row.album_code === null || row.album_code === undefined
        ? null
        : {
            code: String(row.album_code),
            title: String(row.album_title),
            description:
              row.album_description === null || row.album_description === undefined
                ? null
                : String(row.album_description),
            visibility: String(row.album_visibility) as AlbumRow["visibility"],
          },
  }))
}

/** Mark one report resolved. Returns whether a row changed. */
export function resolveReport(db: UsersDb, id: number, now: number): boolean {
  return (
    Number(
      db.q("UPDATE user_reports SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'").run(now, id)
        .changes ?? 0,
    ) > 0
  )
}

/** How many reports are still open — the badge the owner watches. */
export function openReportCount(db: UsersDb): number {
  const row = db.q("SELECT COUNT(*) AS n FROM user_reports WHERE status = 'open'").get() as { n: number }
  return Number(row?.n ?? 0)
}

/** Block `blockedId` for `blockerId`. Idempotent (the PK makes a re-block a no-op). */
export function blockUser(db: UsersDb, blockerId: number, blockedId: number, now: number): void {
  db.q(
    `INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(blocker_id, blocked_id) DO NOTHING`,
  ).run(blockerId, blockedId, now)
}

/** Unblock. Returns whether a block was actually lifted. */
export function unblockUser(db: UsersDb, blockerId: number, blockedId: number): boolean {
  return (
    Number(db.q("DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?").run(blockerId, blockedId).changes ?? 0) >
    0
  )
}

/** Has `blockerId` blocked `blockedId`? (directed — the viewer's own action) */
export function hasBlocked(db: UsersDb, blockerId: number, blockedId: number): boolean {
  return db.q("SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?").get(blockerId, blockedId) !== undefined
}

/**
 * Is there a block in EITHER direction between two accounts? This is what the
 * room join/knock path asks: «cannot be matched with them» is symmetric even
 * though a block is directed — if A blocked B, neither should be seated with the
 * other, and B must not learn which way the block runs by finding he can still
 * join A while A cannot join him.
 */
export function blockExistsBetween(db: UsersDb, a: number, b: number): boolean {
  if (a === b) return false
  return (
    db
      .q("SELECT 1 FROM user_blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1)")
      .get(a, b) !== undefined
  )
}

export type BlockRow = { username: string; displayName: string; userId: number; createdAt: number }

/** The accounts a user has blocked, newest first — the settings list. */
export function listBlocks(db: UsersDb, blockerId: number): BlockRow[] {
  const rows = db
    .q(
      `SELECT u.id AS id, u.username AS username, u.display_name AS display_name, b.created_at AS created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ?
       ORDER BY b.created_at DESC`,
    )
    .all(blockerId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    userId: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    createdAt: Number(row.created_at),
  }))
}

/** Default suspension window when an admin names no explicit number of days. */
export const SUSPEND_DEFAULT_DAYS = 30

/** Suspend an account until `until` (epoch ms). The caller revokes its sessions. */
export function suspendUser(db: UsersDb, userId: number, until: number): void {
  db.q("UPDATE users SET suspended_until = ? WHERE id = ?").run(until, userId)
}

/** Lift a suspension. */
export function unsuspendUser(db: UsersDb, userId: number): void {
  db.q("UPDATE users SET suspended_until = 0 WHERE id = ?").run(userId)
}

/** Is this account suspended right now? */
export function isSuspended(row: UserRow, now: number): boolean {
  return row.suspended_until > now
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
       WHERE (r.host_user_id = ?1 OR r.guest_user_id = ?1)
         -- A room OPENED and never entered is not a مساجلة. It used to be
         -- listed as one — «لم تُحسم · بانتظار خصم» three times over, each
         -- linking to a dead waiting room — while the tiles above counted only
         -- the decided ones, so the list and the number disagreed on the same
         -- screen. A room that HAS a guest stays, played out or not.
         AND NOT (r.status = 'waiting' AND r.guest_user_id IS NULL)
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

// ─────────────────────────────────────────────────────────────────────────────
// الدواوين (migration 8)
// ─────────────────────────────────────────────────────────────────────────────
//
// The SQL half of «a reader compiles his own ديوان». Nothing here reads the
// corpus — resolution against the artefact is `server/routes/albums.ts`'s job,
// because this module owns the writable database and only that.

/**
 * The ديوان's code, drawn the way a room's is and for the same reason: it is
 * read aloud and photographed more often than it is copied. Ten characters
 * rather than six because THIS code is the credential (`AlbumCodeSchema`) —
 * 14⁵ × 5⁵ = 1.68 billion, drawn with the CSPRNG, retried on the UNIQUE index.
 */
const ALBUM_CONSONANTS = "BDFHJKLMNRSTWZ"
const ALBUM_VOWELS = "AEIOU"

export function newAlbumCode(): string {
  let out = ""
  for (let i = 0; i < 5; i++) {
    out += ALBUM_CONSONANTS[randomInt(ALBUM_CONSONANTS.length)]
    out += ALBUM_VOWELS[randomInt(ALBUM_VOWELS.length)]
  }
  return out
}

export type AlbumRow = {
  id: number
  code: string
  ownerUserId: number
  title: string
  description: string | null
  visibility: "private" | "unlisted" | "public"
  createdAt: number
  updatedAt: number
  /** the owner, denormalized by the join every read does anyway */
  ownerUsername: string
  ownerDisplayName: string
  count: number
}

const ALBUM_SELECT = `SELECT a.id, a.code, a.owner_user_id, a.title, a.description, a.visibility,
         a.created_at, a.updated_at, u.username, u.display_name,
         (SELECT COUNT(*) FROM album_baits ab WHERE ab.album_id = a.id) AS n
  FROM albums a JOIN users u ON u.id = a.owner_user_id`

function albumRow(row: unknown): AlbumRow | null {
  if (!row) return null
  const r = row as Record<string, unknown>
  return {
    id: Number(r.id),
    code: String(r.code),
    ownerUserId: Number(r.owner_user_id),
    title: String(r.title),
    description: r.description === null || r.description === undefined ? null : String(r.description),
    visibility: String(r.visibility) as AlbumRow["visibility"],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    ownerUsername: String(r.username),
    ownerDisplayName: String(r.display_name),
    count: Number(r.n ?? 0),
  }
}

export function findAlbumByCode(db: UsersDb, code: string): AlbumRow | null {
  return albumRow(db.q(`${ALBUM_SELECT} WHERE a.code = ? COLLATE NOCASE`).get(code))
}

export function findAlbumById(db: UsersDb, id: number): AlbumRow | null {
  return albumRow(db.q(`${ALBUM_SELECT} WHERE a.id = ?`).get(id))
}

/** YOUR دواوين, most recently touched first. There is no route to anyone else's. */
export function listAlbums(db: UsersDb, ownerUserId: number): AlbumRow[] {
  const rows = db
    .q(`${ALBUM_SELECT} WHERE a.owner_user_id = ? ORDER BY a.updated_at DESC, a.id DESC`)
    .all(ownerUserId) as unknown[]
  return rows.map((r) => albumRow(r)!).filter((r): r is AlbumRow => r !== null)
}

export function countAlbums(db: UsersDb, ownerUserId: number): number {
  const row = db.q("SELECT COUNT(*) AS n FROM albums WHERE owner_user_id = ?").get(ownerUserId) as
    | { n: number }
    | undefined
  return Number(row?.n ?? 0)
}

/** How many times `createAlbum` will re-draw a code before it gives up. */
const CODE_TRIES = 8

export function createAlbum(
  db: UsersDb,
  fields: { ownerUserId: number; title: string; description: string | null; visibility: AlbumRow["visibility"] },
  now: number,
): AlbumRow {
  for (let i = 0; i < CODE_TRIES; i++) {
    const code = newAlbumCode()
    try {
      const res = db
        .q(
          `INSERT INTO albums (code, owner_user_id, title, description, visibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(code, fields.ownerUserId, fields.title, fields.description, fields.visibility, now, now)
      return findAlbumById(db, Number(res.lastInsertRowid))!
    } catch (err) {
      // The UNIQUE index is the collision detector; anything else is real.
      if (!String(err).includes("UNIQUE")) throw err
    }
  }
  throw new Error("could not draw a free album code")
}

export function updateAlbum(
  db: UsersDb,
  albumId: number,
  fields: { title?: string; description?: string | null; visibility?: AlbumRow["visibility"] },
  now: number,
): void {
  const sets: string[] = []
  const params: Array<string | null> = []
  if (fields.title !== undefined) {
    sets.push("title = ?")
    params.push(fields.title)
  }
  if (fields.description !== undefined) {
    sets.push("description = ?")
    params.push(fields.description)
  }
  if (fields.visibility !== undefined) {
    sets.push("visibility = ?")
    params.push(fields.visibility)
  }
  if (sets.length === 0) return
  db.q(`UPDATE albums SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...params, now, albumId)
}

export function deleteAlbum(db: UsersDb, albumId: number): boolean {
  return Number(db.q("DELETE FROM albums WHERE id = ?").run(albumId).changes) > 0
}

export type AlbumBaitRow = {
  hFull: string
  position: number
  addedAt: number
  snapshotSadr: string
  snapshotAjuz: string | null
  snapshotPoet: string
}

function albumBaitRow(row: Record<string, unknown>): AlbumBaitRow {
  return {
    hFull: String(row.h_full),
    position: Number(row.position),
    addedAt: Number(row.added_at),
    snapshotSadr: String(row.snapshot_sadr),
    snapshotAjuz: row.snapshot_ajuz === null || row.snapshot_ajuz === undefined ? null : String(row.snapshot_ajuz),
    snapshotPoet: String(row.snapshot_poet),
  }
}

/** The shelf, in the curator's order. */
export function albumBaits(db: UsersDb, albumId: number): AlbumBaitRow[] {
  const rows = db
    .q(
      `SELECT h_full, position, added_at, snapshot_sadr, snapshot_ajuz, snapshot_poet
       FROM album_baits WHERE album_id = ? ORDER BY position ASC, added_at ASC`,
    )
    .all(albumId) as Array<Record<string, unknown>>
  return rows.map(albumBaitRow)
}

export function albumBaitCount(db: UsersDb, albumId: number): number {
  const row = db.q("SELECT COUNT(*) AS n FROM album_baits WHERE album_id = ?").get(albumId) as
    | { n: number }
    | undefined
  return Number(row?.n ?? 0)
}

/** Which of these anchors the shelf already holds — the duplicate half of a bulk add. */
export function albumHasAnchors(db: UsersDb, albumId: number, anchors: readonly string[]): Set<string> {
  const held = new Set<string>()
  if (anchors.length === 0) return held
  const stmt = db.q("SELECT 1 AS hit FROM album_baits WHERE album_id = ? AND h_full = ?")
  for (const a of anchors) if (stmt.get(albumId, a)) held.add(a)
  return held
}

export type AlbumBaitInsert = {
  hFull: string
  snapshotSadr: string
  snapshotAjuz: string | null
  snapshotPoet: string
}

/**
 * Append أبيات to the end of the shelf, in one transaction, and stamp the album.
 *
 * `INSERT OR IGNORE` against `UNIQUE(album_id, h_full)` is what makes a second
 * «أضِف القصيدة» add only what was missing rather than fail the whole request —
 * and the returned count is the honest «أُضيف كذا بيتًا» the toast says.
 */
export function addAlbumBaits(db: UsersDb, albumId: number, items: readonly AlbumBaitInsert[], now: number): number {
  if (items.length === 0) return 0
  db.raw.exec("BEGIN IMMEDIATE")
  try {
    const row = db.q("SELECT COALESCE(MAX(position), -1) AS p FROM album_baits WHERE album_id = ?").get(albumId) as
      | { p: number }
      | undefined
    let next = Number(row?.p ?? -1) + 1
    const stmt = db.q(
      `INSERT OR IGNORE INTO album_baits (album_id, h_full, position, snapshot_sadr, snapshot_ajuz, snapshot_poet, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    let added = 0
    for (const item of items) {
      const res = stmt.run(albumId, item.hFull, next, item.snapshotSadr, item.snapshotAjuz, item.snapshotPoet, now)
      if (Number(res.changes) > 0) {
        added += 1
        next += 1
      }
    }
    if (added > 0) db.q("UPDATE albums SET updated_at = ? WHERE id = ?").run(now, albumId)
    db.raw.exec("COMMIT")
    return added
  } catch (err) {
    try {
      db.raw.exec("ROLLBACK")
    } catch {
      /* never opened */
    }
    throw err
  }
}

export function removeAlbumBait(db: UsersDb, albumId: number, hFull: string, now: number): boolean {
  const res = db.q("DELETE FROM album_baits WHERE album_id = ? AND h_full = ?").run(albumId, hFull)
  if (Number(res.changes) === 0) return false
  db.q("UPDATE albums SET updated_at = ? WHERE id = ?").run(now, albumId)
  return true
}

/**
 * Re-seat the shelf in the order the owner named.
 *
 * The request carries the WHOLE anchor list, not a move, so a drag that arrives
 * twice or out of sequence cannot leave a shelf half-ordered. Anchors the
 * request does not name keep their relative order AFTER the ones it does — a
 * concurrent add from another tab is appended, not dropped.
 *
 * Positions are written NEGATIVE first and then flipped, because
 * `(album_id, position)` has no uniqueness to violate but a partial UPDATE
 * sequence briefly collides with itself in a way that is hard to reason about;
 * two passes in one transaction is simply always right.
 */
export function reorderAlbum(db: UsersDb, albumId: number, order: readonly string[], now: number): void {
  db.raw.exec("BEGIN IMMEDIATE")
  try {
    const current = db
      .q("SELECT h_full FROM album_baits WHERE album_id = ? ORDER BY position ASC, added_at ASC")
      .all(albumId) as Array<{ h_full: string }>
    const held = new Set(current.map((r) => String(r.h_full)))
    const seen = new Set<string>()
    const seq: string[] = []
    for (const a of order) {
      if (!held.has(a) || seen.has(a)) continue
      seen.add(a)
      seq.push(a)
    }
    for (const r of current) if (!seen.has(String(r.h_full))) seq.push(String(r.h_full))

    const stmt = db.q("UPDATE album_baits SET position = ? WHERE album_id = ? AND h_full = ?")
    for (let i = 0; i < seq.length; i++) stmt.run(-(i + 1), albumId, seq[i]!)
    for (let i = 0; i < seq.length; i++) stmt.run(i, albumId, seq[i]!)
    db.q("UPDATE albums SET updated_at = ? WHERE id = ?").run(now, albumId)
    db.raw.exec("COMMIT")
  } catch (err) {
    try {
      db.raw.exec("ROLLBACK")
    } catch {
      /* never opened */
    }
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// المكتبة — other people's دواوين, kept
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A saved shelf, as the listing reads it: the EDGE (which album, when), plus the
 * album row itself.
 *
 * The gate is not applied here — `visibility` comes back raw and the route
 * decides what the viewer may see, because «private» and «you blocked its
 * curator» are two different sentences on the screen and only one of them is a
 * fact about the shelf.
 */
export type SavedAlbumRow = { savedAt: number; album: AlbumRow }

/**
 * Keep somebody else's ديوان. Idempotent — a second press is not an error, the
 * desired end state already holds — and it never stamps the ALBUM's
 * `updated_at`: saving is the reader's act, not the curator's, and moving the
 * shelf's timestamp would re-sort his own list and blow the resolution memo for
 * every visitor (server/routes/albums.ts).
 */
export function saveAlbum(db: UsersDb, userId: number, albumId: number, now: number): void {
  db.q(
    `INSERT INTO saved_albums (user_id, album_id, saved_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, album_id) DO NOTHING`,
  ).run(userId, albumId, now)
}

/** Drop it from the مكتبة. Returns whether a row went. */
export function unsaveAlbum(db: UsersDb, userId: number, albumId: number): boolean {
  return Number(db.q("DELETE FROM saved_albums WHERE user_id = ? AND album_id = ?").run(userId, albumId).changes) > 0
}

export function isAlbumSaved(db: UsersDb, userId: number, albumId: number): boolean {
  return db.q("SELECT 1 AS hit FROM saved_albums WHERE user_id = ? AND album_id = ?").get(userId, albumId) !== undefined
}

export function countSavedAlbums(db: UsersDb, userId: number): number {
  const row = db.q("SELECT COUNT(*) AS n FROM saved_albums WHERE user_id = ?").get(userId) as { n: number } | undefined
  return Number(row?.n ?? 0)
}

/**
 * The مكتبة, most recently saved first — the ROWS, ungated.
 *
 * It joins the album (and through it the curator) because a listing that
 * returned ids would need a second query per row anyway, and it deliberately
 * does NOT filter on visibility: a shelf that has gone private is still a row
 * the reader owns and must be able to remove.
 */
export function listSavedAlbums(db: UsersDb, userId: number): SavedAlbumRow[] {
  // The album SELECT is wrapped rather than re-spelled: `albumRow` reads column
  // names, and `sub.*` hands them through unchanged, so the one place the album
  // columns are named stays the one place.
  const rows = db
    .q(
      `SELECT s.saved_at AS saved_at, sub.* FROM (${ALBUM_SELECT}) sub
       JOIN saved_albums s ON s.album_id = sub.id
       WHERE s.user_id = ? ORDER BY s.saved_at DESC, sub.id DESC`,
    )
    .all(userId) as Array<Record<string, unknown>>
  return rows
    .map((r) => ({ savedAt: Number(r.saved_at), album: albumRow(r) }))
    .filter((r): r is SavedAlbumRow => r.album !== null)
}

/** The PUBLIC دواوين of one account — the shelf on `#/u/<name>` and nothing else. */
export function listPublicAlbums(db: UsersDb, ownerUserId: number): AlbumRow[] {
  const rows = db
    .q(
      `${ALBUM_SELECT} WHERE a.owner_user_id = ? AND a.visibility = 'public'
       ORDER BY a.updated_at DESC, a.id DESC`,
    )
    .all(ownerUserId) as unknown[]
  return rows.map((r) => albumRow(r)!).filter((r): r is AlbumRow => r !== null)
}
