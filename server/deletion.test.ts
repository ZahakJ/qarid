/**
 * Account deletion — the irreversible, self-serve erase Google Play requires of
 * any app with accounts.
 *
 * Two surfaces, both real. The first block drives `deleteUserAccount` against a
 * real users database (no corpus, exactly the auth.test.ts shape): it proves
 * every trace of the account goes, that shared match history is anonymized
 * rather than orphaned, and that a room the deleter was live in is settled so no
 * opponent is left on a dead clock. The second block drives the whole
 * `POST /api/profile/delete` route over the app with the REAL fixture corpus, so
 * the wire — password re-confirmation, cookie clear, dead sessions, and the
 * opponent opening the anonymized match without a crash — is exercised end to
 * end.
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { Hono } from "hono"

import { AuthMeResponseSchema, AuthSessionResponseSchema, RoomStateResponseSchema } from "../shared/schema.ts"
import { FIXTURE_DB, REPO_ROOT, ensureFixtureDb } from "../test/fixtureDb.ts"
import { openDb, type Db } from "./db.ts"
import { createApp } from "./app.ts"
import { loadConfig, type Config } from "./config.ts"
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  deleteUserAccount,
  findUserById,
  hashPassword,
  hashToken,
  newSessionToken,
  putArsenal,
  putAvatar,
  sessionUser,
  type UsersDb,
} from "./users.ts"
import { openUsersDb } from "./users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DBS: string[] = []

function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `deletion-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
  TEMP_DBS.push(p)
  return p
}

function removeTempDbs(): void {
  for (const p of TEMP_DBS) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(p + suffix, { force: true })
      } catch {
        /* the assertion that mattered already ran */
      }
    }
  }
}

function configFor(env: Record<string, string> = {}): Config {
  return loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test", ...env } as NodeJS.ProcessEnv)
}

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }
}

function withCookie(init: RequestInit, token: string): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: `${SESSION_COOKIE}=${token}` } }
}

function sessionCookie(res: Response): string | null {
  const all = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  const list = all.length ? all : res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []
  for (const c of list) {
    const m = /(?:^|,\s*)qarid_sess=([^;]*)/.exec(c)
    if (m) return m[1] ?? null
  }
  return null
}

function cookieAttrs(res: Response): string {
  const all = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  const list = all.length ? all : res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []
  return list.find((c) => c.includes(`${SESSION_COOKIE}=`)) ?? ""
}

// Count helpers that read the raw tables directly — the point is what is left on
// disk, so nothing here goes through a query that might hide a survivor.
function count(db: UsersDb, sql: string, ...args: unknown[]): number {
  return Number((db.raw.prepare(sql).get(...(args as [])) as { n: number }).n)
}

// ─────────────────────────────────────────────────────────────────────────────
// deleteUserAccount over the users database
// ─────────────────────────────────────────────────────────────────────────────

describe("deleteUserAccount removes every trace and anonymizes shared history", () => {
  let db: UsersDb

  beforeAll(async () => {
    db = openUsersDb(tempUsersPath("core"))
  })
  afterAll(() => db.close())

  it("erases the row, sessions (cookie AND bearer), avatar, arsenal, and hosted rooms with their knocks", () => {
    const now = Date.now()
    const me = createUser(db, { username: "labid", displayName: "لبيد", passHash: "x", now })!
    const foe = createUser(db, { username: "nabigha", displayName: "النابغة", passHash: "x", now })!

    // Two live sessions — the cookie one and a bearer one — must both die.
    createSession(db, { userId: me.id, tokenHash: hashToken(newSessionToken()), now })
    createSession(db, { userId: me.id, tokenHash: hashToken(newSessionToken()), now })
    putAvatar(db, me.id, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), now)
    putArsenal(db, me.id, JSON.stringify({ ب: { used: 1, mastered: 1, lastAt: 1 } }), now)

    // A room he HOSTS, still waiting, with a knocker at the door — his to keep,
    // so it and the knock cascade away with him.
    db.raw
      .prepare(
        `INSERT INTO rooms (code, host_user_id, starting_bait_id, mode, status, created_at, updated_at, join_key)
         VALUES ('HOSTED', ?, 1, 'rhyme', 'waiting', ?, ?, 'k')`,
      )
      .run(me.id, now, now)
    const hostedId = Number((db.raw.prepare("SELECT id FROM rooms WHERE code = 'HOSTED'").get() as { id: number }).id)
    db.raw
      .prepare("INSERT INTO room_knocks (room_id, user_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)")
      .run(hostedId, foe.id, now, now)

    const { endedRoomCodes } = deleteUserAccount(db, me.id, now)

    expect(findUserById(db, me.id)).toBeNull()
    expect(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", me.id)).toBe(0)
    expect(count(db, "SELECT COUNT(*) AS n FROM user_avatars WHERE user_id = ?", me.id)).toBe(0)
    expect(count(db, "SELECT COUNT(*) AS n FROM profile_arsenal WHERE user_id = ?", me.id)).toBe(0)
    // Hosted room and its knock are gone by CASCADE.
    expect(count(db, "SELECT COUNT(*) AS n FROM rooms WHERE code = 'HOSTED'")).toBe(0)
    expect(count(db, "SELECT COUNT(*) AS n FROM room_knocks WHERE room_id = ?", hostedId)).toBe(0)
    // A waiting room that never started is not "live" to broadcast about.
    expect(endedRoomCodes).toEqual([])
    // The opponent is untouched.
    expect(findUserById(db, foe.id)?.username).toBe("nabigha")
  })

  it("keeps a finished match the deleter only JOINED, blanking his reference (no dangling FK)", () => {
    const now = Date.now()
    const host = createUser(db, { username: "farazdaq", displayName: "الفرزدق", passHash: "x", now })!
    const guest = createUser(db, { username: "jarir", displayName: "جرير", passHash: "x", now })!

    // A done match hosted by `host`, WON by the guest, with a بيت the guest
    // answered — the shared history that must survive anonymized.
    db.raw
      .prepare(
        `INSERT INTO rooms (code, host_user_id, guest_user_id, starting_bait_id, mode, status, winner_user_id,
                            created_at, started_at, ended_at, updated_at, join_key)
         VALUES ('SHARED', ?, ?, 1, 'rhyme', 'done', ?, ?, ?, ?, ?, 'k')`,
      )
      .run(host.id, guest.id, guest.id, now, now, now, now)
    const roomId = Number((db.raw.prepare("SELECT id FROM rooms WHERE code = 'SHARED'").get() as { id: number }).id)
    db.raw
      .prepare("INSERT INTO match_turns (room_id, turn_no, user_id, bait_id, verdict, played_at) VALUES (?, 0, ?, 1, 'opening', ?)")
      .run(roomId, host.id, now)
    db.raw
      .prepare("INSERT INTO match_turns (room_id, turn_no, user_id, bait_id, verdict, played_at) VALUES (?, 1, ?, 2, 'ok', ?)")
      .run(roomId, guest.id, now)

    deleteUserAccount(db, guest.id, now)

    const room = db.raw.prepare("SELECT * FROM rooms WHERE code = 'SHARED'").get() as Record<string, unknown>
    expect(room).toBeTruthy() // survives — the host still has this match
    expect(room.guest_user_id).toBeNull() // anonymized
    expect(room.winner_user_id).toBeNull() // the winner reference blanked, not dangling
    expect(room.started_at).not.toBeNull() // still reads as a real, started match
    const guestTurn = db.raw.prepare("SELECT user_id FROM match_turns WHERE room_id = ? AND turn_no = 1").get(roomId) as {
      user_id: number | null
    }
    expect(guestTurn.user_id).toBeNull() // the بيت stays, unattributed
    // No orphaned match_turns, and the host's turn is untouched.
    const hostTurn = db.raw.prepare("SELECT user_id FROM match_turns WHERE room_id = ? AND turn_no = 0").get(roomId) as {
      user_id: number | null
    }
    expect(hostTurn.user_id).toBe(host.id)
  })

  it("settles a live match: an ACTIVE room the deleter played hands the win to the opponent", () => {
    const now = Date.now()
    const host = createUser(db, { username: "akhtal", displayName: "الأخطل", passHash: "x", now })!
    const guest = createUser(db, { username: "kuthayyir", displayName: "كثير", passHash: "x", now })!

    // Active room, deleter is the GUEST → it survives (host owns it), ends done,
    // and the host wins by the guest's leaving.
    db.raw
      .prepare(
        `INSERT INTO rooms (code, host_user_id, guest_user_id, starting_bait_id, mode, status,
                            created_at, started_at, turn_deadline_at, updated_at, join_key)
         VALUES ('LIVEGX', ?, ?, 1, 'rhyme', 'active', ?, ?, ?, ?, 'k')`,
      )
      .run(host.id, guest.id, now, now, now + 60000, now)

    const { endedRoomCodes } = deleteUserAccount(db, guest.id, now)
    expect(endedRoomCodes).toContain("LIVEGX")

    const room = db.raw.prepare("SELECT status, winner_user_id, end_reason, turn_deadline_at FROM rooms WHERE code = 'LIVEGX'").get() as {
      status: string
      winner_user_id: number | null
      end_reason: string
      turn_deadline_at: number | null
    }
    expect(room.status).toBe("done")
    expect(room.winner_user_id).toBe(host.id)
    expect(room.end_reason).toBe("resign")
    expect(room.turn_deadline_at).toBeNull() // the clock the host was waiting on is stopped
  })

  it("cascade-deletes an ACTIVE room the deleter HOSTED (his room goes with him)", () => {
    const now = Date.now()
    const host = createUser(db, { username: "tarafa", displayName: "طرفة", passHash: "x", now })!
    const guest = createUser(db, { username: "zuhayr", displayName: "زهير", passHash: "x", now })!
    db.raw
      .prepare(
        `INSERT INTO rooms (code, host_user_id, guest_user_id, starting_bait_id, mode, status,
                            created_at, started_at, turn_deadline_at, updated_at, join_key)
         VALUES ('HOSTGX', ?, ?, 1, 'rhyme', 'active', ?, ?, ?, ?, 'k')`,
      )
      .run(host.id, guest.id, now, now, now + 60000, now)

    const { endedRoomCodes } = deleteUserAccount(db, host.id, now)
    // Host-owned: it cascades away, so there is nothing left to broadcast to and
    // it is not named among the rooms to notify.
    expect(endedRoomCodes).not.toContain("HOSTGX")
    expect(count(db, "SELECT COUNT(*) AS n FROM rooms WHERE code = 'HOSTGX'")).toBe(0)
    expect(findUserById(db, guest.id)?.username).toBe("zuhayr") // the guest is fine
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/profile/delete over the whole app, with the real corpus
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/profile/delete over the app", () => {
  let db: Db
  let users: UsersDb
  let app: Hono
  let openingBaitId: number

  beforeAll(async () => {
    await ensureFixtureDb()
    db = openDb(FIXTURE_DB)
    users = openUsersDb(tempUsersPath("wire"))
    app = createApp(configFor(), db, users).app
    openingBaitId = Number(
      (db.raw.prepare("SELECT bait_id FROM game_baits LIMIT 1").get() as { bait_id: number }).bait_id,
    )
  })
  afterAll(() => {
    db.close()
    users.close()
  })

  async function register(username: string, password: string): Promise<string> {
    const res = await app.request("/api/auth/register", json({ username, displayName: username, password }))
    expect(res.status).toBe(201)
    AuthSessionResponseSchema.parse(await res.json())
    return sessionCookie(res)!
  }

  it("refuses a wrong password (401) and leaves the account standing", async () => {
    const token = await register("victim1", "a good password")
    const bad = await app.request("/api/profile/delete", withCookie(json({ password: "not it at all" }), token))
    expect(bad.status).toBe(401)
    expect(await bad.json()).toMatchObject({ error: "bad_credentials" })
    // still signed in and present
    const me = await app.request("/api/auth/me", withCookie({}, token))
    expect(AuthMeResponseSchema.parse(await me.json()).user?.username).toBe("victim1")
  })

  it("401s an anonymous caller — deletion needs the session it is deleting", async () => {
    const res = await app.request("/api/profile/delete", json({ password: "whatever" }))
    expect(res.status).toBe(401)
  })

  it("deletes on the right password, clears the cookie, and kills the session immediately", async () => {
    const token = await register("victim2", "a good password")
    // Give the account a picture and a published arsenal, so we can prove they go.
    const uid = Number(
      (users.raw.prepare("SELECT id FROM users WHERE username = 'victim2'").get() as { id: number }).id,
    )
    putAvatar(users, uid, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), Date.now())
    putArsenal(users, uid, JSON.stringify({ ب: { used: 1, mastered: 1, lastAt: 1 } }), Date.now())

    const res = await app.request("/api/profile/delete", withCookie(json({ password: "a good password" }), token))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(cookieAttrs(res)).toMatch(/Max-Age=0/) // the cookie is cleared

    // The session is dead the instant the row is gone.
    expect(sessionUser(users, hashToken(token), Date.now())).toBeNull()
    const me = await app.request("/api/auth/me", withCookie({}, token))
    expect(AuthMeResponseSchema.parse(await me.json()).user).toBeNull()

    // Every trace of victim2 is gone.
    expect(users.raw.prepare("SELECT id FROM users WHERE username = 'victim2'").get()).toBeUndefined()
    expect(count(users, "SELECT COUNT(*) AS n FROM user_avatars WHERE user_id = ?", uid)).toBe(0)
    expect(count(users, "SELECT COUNT(*) AS n FROM profile_arsenal WHERE user_id = ?", uid)).toBe(0)
    // A public profile lookup for the deleted name is now a 404.
    expect((await app.request("/api/profile/victim2")).status).toBe(404)
  })

  it("lets the opponent open the old match, showing the deleter as «لاعب محذوف»", async () => {
    const hostToken = await register("survivor", "a good password")
    const guestToken = await register("departing", "a good password")
    const hostId = Number((users.raw.prepare("SELECT id FROM users WHERE username = 'survivor'").get() as { id: number }).id)
    const guestId = Number((users.raw.prepare("SELECT id FROM users WHERE username = 'departing'").get() as { id: number }).id)

    // A finished match: survivor hosted, departing was the guest, and it was
    // played (started_at set, a real opening بيت in the transcript).
    const now = Date.now()
    users.raw
      .prepare(
        `INSERT INTO rooms (code, host_user_id, guest_user_id, starting_bait_id, mode, status, winner_user_id,
                            created_at, started_at, ended_at, updated_at, join_key)
         VALUES ('OLDGAM', ?, ?, ?, 'rhyme', 'done', ?, ?, ?, ?, ?, 'k')`,
      )
      .run(hostId, guestId, openingBaitId, hostId, now, now, now, now)
    const roomId = Number((users.raw.prepare("SELECT id FROM rooms WHERE code = 'OLDGAM'").get() as { id: number }).id)
    users.raw
      .prepare("INSERT INTO match_turns (room_id, turn_no, user_id, bait_id, verdict, played_at) VALUES (?, 0, ?, ?, 'opening', ?)")
      .run(roomId, hostId, openingBaitId, now)

    // The guest deletes their account.
    const del = await app.request("/api/profile/delete", withCookie(json({ password: "a good password" }), guestToken))
    expect(del.status).toBe(200)

    // The host opens the old room — no crash, and the emptied seat is named.
    const state = await app.request("/api/room/OLDGAM/state", withCookie({}, hostToken))
    expect(state.status).toBe(200)
    const body = RoomStateResponseSchema.parse(await state.json())
    expect(body.state.host?.username).toBe("survivor")
    expect(body.state.guest?.displayName).toBe("لاعب محذوف")
    expect(body.state.guest?.username).toBe("")
    expect(body.state.status).toBe("done")
  })
})

afterAll(removeTempDbs)
