/**
 * Accounts, sessions and profiles (v2.md §4).
 *
 * Every test drives the REAL app through `app.request()` over a REAL users
 * database in `data/` (gitignored), created fresh per file and deleted after —
 * `node:sqlite` has no in-memory-with-WAL mode worth pretending with, and the
 * point of these tests is the disk-backed thing that ships.
 *
 * The corpus handle is `null` throughout on purpose: accounts must work on a
 * box that has never run `npm run ingest`, which is also the shape of the
 * `/api/*` 503 gate in `server/app.ts`.
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { Hono } from "hono"

import { AuthMeResponseSchema, AuthSessionResponseSchema, ProfileResponseSchema } from "../shared/schema.ts"
import { REPO_ROOT } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig, type Config } from "./config.ts"
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  USERS_SCHEMA_VERSION,
  createSession,
  createUser,
  duelStats,
  hashPassword,
  hashToken,
  migrate,
  newSessionToken,
  openUsersDb,
  openUsersDbIfWritable,
  purgeExpiredSessions,
  recentMatches,
  sessionUser,
  verifyPassword,
  type UsersDb,
} from "./users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DBS: string[] = []

/** A throwaway users database under data/ (gitignored, never /tmp). */
function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `users-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
  TEMP_DBS.push(p)
  return p
}

function removeTempDbs(): void {
  for (const p of TEMP_DBS) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(p + suffix, { force: true })
      } catch {
        /* the test already told us what matters */
      }
    }
  }
}

function configFor(env: Record<string, string> = {}): Config {
  return loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test", ...env } as NodeJS.ProcessEnv)
}

/** Every `Set-Cookie` on a response, in a runtime-independent way. */
function setCookies(res: Response): string[] {
  const all = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
  if (all && all.length) return all
  const one = res.headers.get("set-cookie")
  return one ? [one] : []
}

/** The session cookie's VALUE, or null when the response did not set one. */
function sessionCookie(res: Response): string | null {
  for (const c of setCookies(res)) {
    const m = /(?:^|,\s*)qarid_sess=([^;]*)/.exec(c)
    if (m) return m[1] ?? null
  }
  return null
}

function cookieAttrs(res: Response): string {
  return setCookies(res).find((c) => c.includes(`${SESSION_COOKIE}=`)) ?? ""
}

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

function withCookie(init: RequestInit, token: string): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: `${SESSION_COOKIE}=${token}` } }
}

// ─────────────────────────────────────────────────────────────────────────────
// The database itself
// ─────────────────────────────────────────────────────────────────────────────

describe("users database", () => {
  let db: UsersDb

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("schema"))
  })
  afterAll(() => {
    db.close()
  })

  it("is created at the current schema version, in WAL, with foreign keys on", () => {
    const version = (db.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(Number(version)).toBe(USERS_SCHEMA_VERSION)
    const mode = db.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    expect(String(mode.journal_mode).toLowerCase()).toBe("wal")
    const fk = db.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(Number(fk.foreign_keys)).toBe(1)
  })

  it("carries §5's match tables from day one, so multiplayer is code and not a migration", () => {
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name)
      .sort()
    expect(tables).toEqual(expect.arrayContaining(["match_turns", "profile_arsenal", "rooms", "sessions", "users"]))
  })

  it("migrates idempotently — re-opening an existing file changes nothing", () => {
    const before = (db.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(migrate(db.raw)).toBe(USERS_SCHEMA_VERSION)
    const after = (db.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(after).toBe(before)
  })

  it("refuses a database written by a newer build rather than dropping its columns", () => {
    db.raw.exec(`PRAGMA user_version = ${USERS_SCHEMA_VERSION + 5}`)
    expect(() => migrate(db.raw)).toThrow(/schema/)
    db.raw.exec(`PRAGMA user_version = ${USERS_SCHEMA_VERSION}`)
  })

  it("holds usernames unique case-insensitively", () => {
    const now = Date.now()
    expect(createUser(db, { username: "Farazdaq", displayName: "الفرزدق", passHash: "x", now })).not.toBeNull()
    expect(createUser(db, { username: "FARAZDAQ", displayName: "آخر", passHash: "x", now })).toBeNull()
  })

  it("expires a session at its deadline and sweeps it on the way past", () => {
    const now = Date.now()
    const user = createUser(db, { username: "jarir", displayName: "جرير", passHash: "x", now })!
    const token = newSessionToken()
    createSession(db, { userId: user.id, tokenHash: hashToken(token), now: now - 10, ttlMs: 5 })
    expect(sessionUser(db, hashToken(token), now)).toBeNull()
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(user.id)).toMatchObject({ n: 0 })

    const live = newSessionToken()
    createSession(db, { userId: user.id, tokenHash: hashToken(live), now })
    expect(sessionUser(db, hashToken(live), now)?.user.username).toBe("jarir")
    expect(purgeExpiredSessions(db, now)).toBe(0)
  })

  it("deletes a user's sessions with the user (ON DELETE CASCADE)", () => {
    const now = Date.now()
    const user = createUser(db, { username: "akhtal", displayName: "الأخطل", passHash: "x", now })!
    createSession(db, { userId: user.id, tokenHash: hashToken(newSessionToken()), now })
    db.raw.prepare("DELETE FROM users WHERE id = ?").run(user.id)
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(user.id)).toMatchObject({ n: 0 })
  })
})

describe("duel statistics over the §5 tables", () => {
  let db: UsersDb

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("stats"))
  })
  afterAll(() => {
    db.close()
  })

  it("reads zeros for a player who has never entered a room", () => {
    const now = Date.now()
    const user = createUser(db, { username: "buhturi", displayName: "البحتري", passHash: "x", now })!
    expect(duelStats(db, user.id)).toEqual({ matches: 0, wins: 0, losses: 0, turns: 0, bestChain: 0 })
    expect(recentMatches(db, user.id, 10)).toEqual([])
  })

  /**
   * The profile's numbers are QUERIES, not placeholders — this writes the rows
   * §5's agent will write and proves the page is already correct, including the
   * longest-run window function behind أطول سلسلة.
   */
  it("counts wins, losses and the longest accepted run once rooms exist", () => {
    const now = Date.now()
    const me = createUser(db, { username: "mutanabbi", displayName: "المتنبي", passHash: "x", now })!
    const foe = createUser(db, { username: "abunuwas", displayName: "أبو نواس", passHash: "x", now })!

    const room = (code: string, winner: number | null, status = "done") => {
      db.raw
        .prepare(
          `INSERT INTO rooms (code, host_user_id, guest_user_id, starting_bait_id, mode, status, winner_user_id, created_at, updated_at, ended_at)
           VALUES (?, ?, ?, 1, 'rhyme', ?, ?, ?, ?, ?)`,
        )
        .run(code, me.id, foe.id, status, winner, now, now, status === "done" ? now : null)
      return Number((db.raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id)
    }
    const turn = (roomId: number, no: number, userId: number, verdict: string) => {
      db.raw
        .prepare("INSERT INTO match_turns (room_id, turn_no, user_id, bait_id, verdict, played_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(roomId, no, userId, 100 + no, verdict, now + no)
    }

    const won = room("ALIFBA", me.id)
    const lost = room("BAYTUN", foe.id)
    const open = room("WAITIN", null, "waiting")

    // ok, ok, ok, miss, ok  → longest accepted run is 3
    for (const [no, verdict] of [
      [0, "ok"],
      [2, "ok"],
      [4, "ok"],
      [6, "wrong_letter"],
      [8, "ok"],
    ] as const) {
      turn(won, no, me.id, verdict)
    }
    turn(lost, 1, me.id, "ok")
    turn(open, 0, me.id, "ok")

    expect(duelStats(db, me.id)).toEqual({ matches: 2, wins: 1, losses: 1, turns: 6, bestChain: 3 })
    expect(duelStats(db, foe.id)).toMatchObject({ matches: 2, wins: 1, losses: 1, turns: 0, bestChain: 0 })

    const recent = recentMatches(db, me.id, 10)
    expect(recent).toHaveLength(3)
    expect(recent.map((r) => r.code).sort()).toEqual(["ALIFBA", "BAYTUN", "WAITIN"])
    const winRow = recent.find((r) => r.code === "ALIFBA")!
    expect(winRow).toMatchObject({ result: "win", opponent: "أبو نواس", status: "done", turns: 5 })
    expect(recent.find((r) => r.code === "BAYTUN")).toMatchObject({ result: "loss" })
    expect(recent.find((r) => r.code === "WAITIN")).toMatchObject({ result: "open", status: "waiting" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Passwords
// ─────────────────────────────────────────────────────────────────────────────

describe("password hashing", () => {
  it("round-trips, and salts so two identical passwords hash differently", async () => {
    const a = await hashPassword("قفا نبك من ذكرى")
    const b = await hashPassword("قفا نبك من ذكرى")
    expect(a).not.toBe(b)
    expect(a.startsWith("scrypt$16384$8$1$")).toBe(true)
    expect(await verifyPassword("قفا نبك من ذكرى", a)).toBe(true)
    expect(await verifyPassword("قفا نبك من ذكري", a)).toBe(false)
  })

  it("answers false — never throws — for a hash it cannot read", async () => {
    for (const bad of ["", "x", "scrypt$1$1$1$$", "argon2$a$b$c$d$e", "scrypt$99999999$8$1$AAAA$AAAA"]) {
      expect(await verifyPassword("whatever", bad)).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The wire
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/auth over the app", () => {
  let db: UsersDb
  let app: Hono
  const config = configFor()

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("wire"))
    app = createApp(config, null, db).app
  })
  afterAll(() => {
    db.close()
  })

  it("says nobody is signed in, with 200 and not 401", async () => {
    const res = await app.request("/api/auth/me")
    expect(res.status).toBe(200)
    const body = AuthMeResponseSchema.parse(await res.json())
    expect(body).toEqual({ user: null, requiresInvite: false, available: true })
  })

  it("never lets a shared cache hold an identity", async () => {
    const res = await app.request("/api/auth/me")
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("registers, sets an HttpOnly SameSite=Lax cookie, and knows me afterwards", async () => {
    const res = await app.request("/api/auth/register", json({ username: "khansa", displayName: "الخنساء", password: "بيت من الشعر" }))
    expect(res.status).toBe(201)
    const body = AuthSessionResponseSchema.parse(await res.json())
    expect(body.user).toMatchObject({ username: "khansa", displayName: "الخنساء" })
    expect(body.user.joinedAt).toBeGreaterThan(0)

    const attrs = cookieAttrs(res)
    expect(attrs).toMatch(/HttpOnly/i)
    expect(attrs).toMatch(/SameSite=Lax/i)
    expect(attrs).toMatch(/Path=\//i)
    expect(attrs).toMatch(/Max-Age=7776000/)

    const token = sessionCookie(res)
    expect(token).toBeTruthy()
    const me = await app.request("/api/auth/me", withCookie({}, token!))
    expect(AuthMeResponseSchema.parse(await me.json()).user).toMatchObject({ username: "khansa" })
  })

  it("stores only the HASH of a session token, so the file is not a drawer of live sessions", () => {
    const rows = db.raw.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("refuses a taken name in either case, with 409 and no new row", async () => {
    const res = await app.request("/api/auth/register", json({ username: "KHANSA", password: "another password" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "username_taken" })
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'khansa' COLLATE NOCASE").get()).toMatchObject({ n: 1 })
  })

  it("400s a password under eight characters and a username that is not one", async () => {
    const short = await app.request("/api/auth/register", json({ username: "shortpw", password: "1234567" }))
    expect(short.status).toBe(400)
    expect(await short.json()).toMatchObject({ error: "bad_body" })

    const spaced = await app.request("/api/auth/register", json({ username: "two words", password: "long enough" }))
    expect(spaced.status).toBe(400)
  })

  it("logs in with the right password and refuses the wrong one identically to an unknown name", async () => {
    const good = await app.request("/api/auth/login", json({ username: "Khansa", password: "بيت من الشعر" }))
    expect(good.status).toBe(200)
    expect(sessionCookie(good)).toBeTruthy()

    const badPassword = await app.request("/api/auth/login", json({ username: "khansa", password: "not it at all" }))
    const noSuchUser = await app.request("/api/auth/login", json({ username: "nobody", password: "not it at all" }))
    expect(badPassword.status).toBe(401)
    expect(noSuchUser.status).toBe(401)
    expect(await badPassword.json()).toEqual(await noSuchUser.json())
  })

  it("logs out: the row is gone and the cookie is cleared", async () => {
    const login = await app.request("/api/auth/login", json({ username: "khansa", password: "بيت من الشعر" }))
    const token = sessionCookie(login)!
    expect(sessionUser(db, hashToken(token), Date.now())).not.toBeNull()

    const out = await app.request("/api/auth/logout", withCookie(json({}), token))
    expect(out.status).toBe(200)
    expect(await out.json()).toEqual({ ok: true })
    expect(cookieAttrs(out)).toMatch(/Max-Age=0/)
    expect(sessionUser(db, hashToken(token), Date.now())).toBeNull()

    const me = await app.request("/api/auth/me", withCookie({}, token))
    expect(AuthMeResponseSchema.parse(await me.json()).user).toBeNull()
  })

  it("ignores a forged or stale cookie instead of erroring", async () => {
    const me = await app.request("/api/auth/me", withCookie({}, "not-a-real-token"))
    expect(me.status).toBe(200)
    expect(AuthMeResponseSchema.parse(await me.json()).user).toBeNull()
  })

  it("rolls a session that is more than a day old", async () => {
    const login = await app.request("/api/auth/login", json({ username: "khansa", password: "بيت من الشعر" }))
    const token = sessionCookie(login)!
    const hash = hashToken(token)
    // Backdate the session by two days, the way two days of use would.
    const aged = Date.now() - 2 * 24 * 60 * 60 * 1000
    db.raw.prepare("UPDATE sessions SET created_at = ?, expires_at = ? WHERE token_hash = ?").run(aged, aged + SESSION_TTL_MS, hash)

    const me = await app.request("/api/auth/me", withCookie({}, token))
    expect(sessionCookie(me)).toBe(token)
    const row = db.raw.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(hash) as { expires_at: number }
    expect(Number(row.expires_at)).toBeGreaterThan(aged + SESSION_TTL_MS)
  })
})

describe("registration rate limit (v2.md §4: 5/hour/IP)", () => {
  let db: UsersDb

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("ratelimit"))
  })
  afterAll(() => {
    db.close()
  })

  it("hands out five and then 429s the sixth", async () => {
    const { app } = createApp(configFor(), null, db)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await app.request("/api/auth/register", json({ username: `poet${i}`, password: "a good password" }))
      statuses.push(res.status)
      if (res.status === 429) expect(res.headers.get("Retry-After")).toBeTruthy()
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429])
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM users").get()).toMatchObject({ n: 5 })
  })
})

describe("invite-only registration", () => {
  let db: UsersDb

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("invite"))
  })
  afterAll(() => {
    db.close()
  })

  it("refuses without a code, accepts with one, and says so on /me", async () => {
    const config = configFor({ REQUIRE_INVITE: "1", INVITE_CODES: "diwan-2026, second-code" })
    const { app } = createApp(config, null, db)

    const me = AuthMeResponseSchema.parse(await (await app.request("/api/auth/me")).json())
    expect(me.requiresInvite).toBe(true)

    const bare = await app.request("/api/auth/register", json({ username: "uninvited", password: "a good password" }))
    expect(bare.status).toBe(403)
    expect(await bare.json()).toMatchObject({ error: "invite_required" })

    const wrong = await app.request("/api/auth/register", json({ username: "uninvited", password: "a good password", invite: "nope" }))
    expect(wrong.status).toBe(403)

    const right = await app.request("/api/auth/register", json({ username: "invited", password: "a good password", invite: "second-code" }))
    expect(right.status).toBe(201)
  })
})

describe("without a writable users database", () => {
  const config = configFor()
  const { app } = createApp(config, null, null)

  it("still answers /api/auth/me, saying accounts are unavailable", async () => {
    const res = await app.request("/api/auth/me")
    expect(res.status).toBe(200)
    expect(AuthMeResponseSchema.parse(await res.json())).toEqual({ user: null, requiresInvite: false, available: false })
  })

  it("503s the writes rather than crashing", async () => {
    for (const path of ["/api/auth/register", "/api/auth/login"]) {
      const res = await app.request(path, json({ username: "someone", password: "a good password" }))
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: "auth_unavailable" })
    }
    const profile = await app.request("/api/profile/someone")
    expect(profile.status).toBe(503)
  })

  it("treats logout as a no-op the client may always call", async () => {
    const res = await app.request("/api/auth/logout", json({}))
    expect(res.status).toBe(200)
  })

  it("never throws out of openUsersDbIfWritable — a read-only directory is a log line", () => {
    const dir = path.join(REPO_ROOT, "data", `ro-${process.pid}-${randomBytes(3).toString("hex")}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o555)
    try {
      expect(openUsersDbIfWritable(path.join(dir, "users.db"))).toBeNull()
    } finally {
      fs.chmodSync(dir, 0o755)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cookie Secure flag", () => {
  let db: UsersDb

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("secure"))
  })
  afterAll(() => {
    db.close()
  })

  it("is set behind an https PUBLIC_ORIGIN and absent on a plain-http dev box", async () => {
    const https = createApp(configFor({ PUBLIC_ORIGIN: "https://qarid.avicenna.space" }), null, db).app
    const secure = await https.request("/api/auth/register", json({ username: "secureone", password: "a good password" }))
    expect(cookieAttrs(secure)).toMatch(/Secure/)

    const http = createApp(configFor({ PUBLIC_ORIGIN: "http://localhost:6750" }), null, db).app
    const plain = await http.request("/api/auth/register", json({ username: "plainone", password: "a good password" }))
    expect(cookieAttrs(plain)).not.toMatch(/Secure/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/profile", () => {
  let db: UsersDb
  let app: Hono
  let token: string

  beforeAll(async () => {
    db = openUsersDb(tempUsersPath("profile"))
    app = createApp(configFor(), null, db).app
    const res = await app.request("/api/auth/register", json({ username: "labid", displayName: "لبيد", password: "a good password" }))
    token = sessionCookie(res)!
  })
  afterAll(() => {
    db.close()
  })

  it("serves a public page with an honest empty duel record", async () => {
    const res = await app.request("/api/profile/labid")
    expect(res.status).toBe(200)
    const body = ProfileResponseSchema.parse(await res.json())
    expect(body.user).toMatchObject({ username: "labid", displayName: "لبيد" })
    expect(body.isSelf).toBe(false)
    expect(body.stats).toEqual({ matches: 0, wins: 0, losses: 0, turns: 0, bestChain: 0 })
    expect(body.recent).toEqual([])
    expect(body.arsenal).toBeNull()
  })

  it("marks the page as mine when I am the one reading it", async () => {
    const res = await app.request("/api/profile/labid", withCookie({}, token))
    expect(ProfileResponseSchema.parse(await res.json()).isSelf).toBe(true)
  })

  it("is case-insensitive on the name and 404s an unknown or illegal one", async () => {
    expect((await app.request("/api/profile/LABID")).status).toBe(200)
    expect((await app.request("/api/profile/nobody")).status).toBe(404)
    expect((await app.request("/api/profile/a")).status).toBe(404)
    expect((await app.request(`/api/profile/${encodeURIComponent("لا أحد")}`)).status).toBe(404)
  })

  it("renames only my own account, and only when I am signed in", async () => {
    const anon = await app.request("/api/profile/update", json({ displayName: "منتحل" }))
    expect(anon.status).toBe(401)

    const mine = await app.request("/api/profile/update", withCookie(json({ displayName: "لبيد بن ربيعة" }), token))
    expect(mine.status).toBe(200)
    expect(ProfileResponseSchema.parse(await mine.json()).user.displayName).toBe("لبيد بن ربيعة")

    const empty = await app.request("/api/profile/update", withCookie(json({ displayName: "   " }), token))
    expect(empty.status).toBe(400)
  })

  it("stores an opt-in ترسانة snapshot and shows it to a visitor", async () => {
    const arsenal = { ب: { used: 12, mastered: 3, lastAt: 1 }, ر: { used: 4, mastered: 0, lastAt: 0 } }
    const res = await app.request("/api/profile/arsenal", withCookie(json({ arsenal }), token))
    expect(res.status).toBe(200)
    const synced = await res.json()
    expect(synced).toMatchObject({ ok: true })

    const page = ProfileResponseSchema.parse(await (await app.request("/api/profile/labid")).json())
    expect(page.arsenal?.letters["ب"]).toMatchObject({ used: 12, mastered: 3 })
    expect(page.arsenal?.updatedAt).toBeGreaterThan(0)
  })

  it("refuses a snapshot that is not the ترسانة shape, and one from nobody", async () => {
    const bad = await app.request("/api/profile/arsenal", withCookie(json({ arsenal: { "!": { used: 1 } } }), token))
    expect(bad.status).toBe(400)
    const anon = await app.request("/api/profile/arsenal", json({ arsenal: {} }))
    expect(anon.status).toBe(401)
  })

  it("caps an oversized body before it is parsed", async () => {
    const huge = "x".repeat(40 * 1024)
    const res = await app.request("/api/profile/arsenal", withCookie(json({ arsenal: {}, pad: huge }), token))
    expect(res.status).toBe(413)
  })
})

afterAll(removeTempDbs)
