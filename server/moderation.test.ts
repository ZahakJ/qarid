/**
 * UGC moderation — report, block, and the owner's admin routes (Track 3).
 *
 * The four properties this file pins are the ones a public app with user
 * content and live 1v1 play cannot ship without:
 *
 *  1. A logged-in reader can REPORT another account; the report is stored, the
 *     route is authenticated, CSRF-guarded and rate-limited, and self-report is
 *     refused.
 *  2. A BLOCK is enforced SERVER-SIDE, not in the UI: a blocked player genuinely
 *     cannot knock, join or be matched with the blocker — either direction — and
 *     unblocking restores it.
 *  3. ADMIN routes are 403 for a non-admin, 401 for nobody, and work for an
 *     account on the `ADMIN_USERNAMES` allowlist.
 *  4. The admin actions do what they say — remove an avatar, reset a name to the
 *     safe placeholder, suspend (which also revokes sessions and bars login),
 *     and resolve a report.
 *
 * Real everything: the fixture corpus (rooms need the verify pipeline), a real
 * gitignored users db, the real HTTP surface driven by `app.request()`.
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import type { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  AdminReportsResponseSchema,
  BlockMutationResponseSchema,
  BlocksResponseSchema,
  PLACEHOLDER_DISPLAY_NAME,
} from "../shared/schema.ts"
import { FIXTURE_DB, REPO_ROOT, ensureFixtureDb } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig, type Config } from "./config.ts"
import { openDb, type Db } from "./db.ts"
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  getAvatarEtag,
  hashPassword,
  hashToken,
  isSuspended,
  findUserByUsername,
  listReports,
  newSessionToken,
  openUsersDb,
  putAvatar,
  sessionUser,
  type UsersDb,
} from "./users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DBS: string[] = []

function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `mod-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
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

let db: Db
let users: UsersDb
/** the default app — no admin allowlist */
let app: Hono
/** an app whose config names `ADMIN_USERNAME` as an admin, same db handle */
let adminApp: Hono
let config: Config

const ADMIN_USERNAME = "owneradmin"
const ADMIN_PASSWORD = "owner-pass-123"

type Player = { username: string; displayName: string; token: string; ip: string }

let seq = 0

/** A player with a live session (fast — no register route, no scrypt-per-test). */
function player(name: string): Player {
  const username = `${name}${++seq}`
  const now = Date.now()
  const row = createUser(users, { username, displayName: name, passHash: "scrypt$not-a-login", now })
  if (!row) throw new Error(`could not create ${username}`)
  const token = newSessionToken()
  createSession(users, { userId: row.id, tokenHash: hashToken(token), now })
  return { username, displayName: name, token, ip: `10.${(seq >> 8) & 255}.${seq & 255}.9` }
}

function headers(who?: Player | string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra }
  if (typeof who === "string") h.Cookie = `${SESSION_COOKIE}=${who}`
  else if (who) {
    h.Cookie = `${SESSION_COOKIE}=${who.token}`
    h["CF-Connecting-IP"] = who.ip
  }
  return h
}

async function reqOn(a: Hono, pathname: string, init: RequestInit, who?: Player | string): Promise<Response> {
  return a.request(pathname, { ...init, headers: headers(who, (init.headers as Record<string, string>) ?? {}) })
}

function postOn(a: Hono, pathname: string, body: unknown, who?: Player | string): Promise<Response> {
  return reqOn(a, pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, who)
}

function req(pathname: string, init: RequestInit, who?: Player | string): Promise<Response> {
  return reqOn(app, pathname, init, who)
}

function postJson(pathname: string, body: unknown, who?: Player | string): Promise<Response> {
  return postOn(app, pathname, body, who)
}

/** Create a room owned by `host` and return its code and invite key. */
async function openWaitingRoom(host: Player): Promise<{ code: string; key: string }> {
  const res = await postJson("/api/room", {}, host)
  expect(res.status).toBe(201)
  const state = (await res.json()).state
  return { code: state.code, key: state.joinKey as string }
}

beforeAll(async () => {
  await ensureFixtureDb()
  db = openDb(FIXTURE_DB)
  users = openUsersDb(tempUsersPath("main"))
  config = loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test" } as NodeJS.ProcessEnv)
  app = createApp(config, db, users).app

  // The admin account, and an app whose config puts it on the allowlist. Both
  // apps share ONE users db handle, so a row created against `users` is visible
  // to either. The admin has a real password so login/suspend can be exercised.
  const now = Date.now()
  createUser(users, { username: ADMIN_USERNAME, displayName: "Owner", passHash: await hashPassword(ADMIN_PASSWORD), now })
  const adminConfig = loadConfig({
    HOST: "127.0.0.1",
    PORT: "5750",
    NODE_ENV: "test",
    ADMIN_USERNAMES: `${ADMIN_USERNAME}, someone-else`,
  } as NodeJS.ProcessEnv)
  adminApp = createApp(adminConfig, db, users).app
})

afterAll(() => {
  db?.close()
  users?.close()
  removeTempDbs()
})

/** A live cookie for the admin, minted straight through the session pair. */
function adminSession(): string {
  const row = findUserByUsername(users, ADMIN_USERNAME)!
  const token = newSessionToken()
  createSession(users, { userId: row.id, tokenHash: hashToken(token), now: Date.now() })
  return token
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Report
// ─────────────────────────────────────────────────────────────────────────────

describe("report", () => {
  it("is refused without a session", async () => {
    const target = player("muavia")
    const res = await postJson("/api/report", { targetUsername: target.username, reason: "harassment" })
    expect(res.status).toBe(401)
  })

  it("stores a report a logged-in reader files against another account", async () => {
    const reporter = player("reporter")
    const target = player("target")
    const res = await postJson(
      "/api/report",
      { targetUsername: target.username, reason: "harassment", note: "أساء في المساجلة", context: "room:BADIRU" },
      reporter,
    )
    expect(res.status).toBe(200)

    const open = listReports(users, { status: "open", limit: 50 })
    const mine = open.find((r) => r.target === target.username && r.reporter === reporter.username)
    expect(mine).toBeTruthy()
    expect(mine!.reason).toBe("harassment")
    expect(mine!.note).toBe("أساء في المساجلة")
    expect(mine!.context).toBe("room:BADIRU")
    expect(mine!.status).toBe("open")
  })

  it("refuses a self-report and an unknown target", async () => {
    const p = player("selfreport")
    const selfRes = await postJson("/api/report", { targetUsername: p.username, reason: "spam" }, p)
    expect(selfRes.status).toBe(400)

    const unknownRes = await postJson("/api/report", { targetUsername: "nobodyhere", reason: "spam" }, p)
    expect(unknownRes.status).toBe(404)
  })

  it("is behind the CSRF originGuard", async () => {
    const reporter = player("csrf")
    const target = player("csrftarget")
    const res = await req(
      "/api/report",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ targetUsername: target.username, reason: "spam" }),
      },
      reporter,
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("origin_rejected")
  })

  it("rate-limits a flood of reports from one IP", async () => {
    const reporter = player("flooder")
    const target = player("floodtarget")
    let sawLimit = false
    // REPORT_LIMIT is 15/hour/IP — well past 15 attempts one of them is a 429.
    for (let i = 0; i < 25; i++) {
      const res = await postJson("/api/report", { targetUsername: target.username, reason: "spam" }, reporter)
      if (res.status === 429) {
        sawLimit = true
        break
      }
    }
    expect(sawLimit).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Block — enforced server-side on the room path
// ─────────────────────────────────────────────────────────────────────────────

describe("block", () => {
  it("bars a blocked user from JOINING the blocker's room, and unblocking restores it", async () => {
    const host = player("host")
    const guest = player("guest")

    // Host blocks guest.
    const blockRes = await postJson("/api/block", { username: guest.username }, host)
    expect(blockRes.status).toBe(200)
    expect(BlockMutationResponseSchema.parse(await blockRes.json()).blocks.some((b) => b.username === guest.username)).toBe(
      true,
    )

    // Host opens a room; guest has the real invite key but still cannot sit down.
    const room = await openWaitingRoom(host)
    const denied = await postJson(`/api/room/${room.code}/join`, { key: room.key }, guest)
    expect(denied.status).toBe(403)
    expect((await denied.json()).error).toBe("blocked")

    // Unblock → the seat opens again.
    const unblock = await req(
      "/api/block",
      { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: guest.username }) },
      host,
    )
    expect(unblock.status).toBe(200)
    const joined = await postJson(`/api/room/${room.code}/join`, { key: room.key }, guest)
    expect(joined.status).toBe(200)
    expect((await joined.json()).state.status).toBe("active")
  })

  it("is symmetric — the blocker cannot join the blocked user's room either", async () => {
    const a = player("blockera")
    const b = player("blockedb")
    // a blocks b …
    expect((await postJson("/api/block", { username: b.username }, a)).status).toBe(200)
    // … and now b hosts a room. a, who did the blocking, still cannot join it:
    // «cannot be matched with them» is symmetric even though the block is directed.
    const room = await openWaitingRoom(b)
    const res = await postJson(`/api/room/${room.code}/join`, { key: room.key }, a)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("blocked")
  })

  it("bars a blocked user from KNOCKING the blocker's room", async () => {
    const host = player("knockhost")
    const stranger = player("knockstranger")
    expect((await postJson("/api/block", { username: stranger.username }, host)).status).toBe(200)
    const room = await openWaitingRoom(host)
    // The stranger reached the room by voice (no key) and knocks — blocked.
    const res = await postJson(`/api/room/${room.code}/knock`, {}, stranger)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("blocked")
  })

  it("lists the reader's own blocks and refuses a self-block", async () => {
    const me = player("blocklister")
    const x = player("blockx")
    const y = player("blocky")
    await postJson("/api/block", { username: x.username }, me)
    await postJson("/api/block", { username: y.username }, me)
    const listRes = await req("/api/block", { method: "GET" }, me)
    expect(listRes.status).toBe(200)
    const names = BlocksResponseSchema.parse(await listRes.json()).blocks.map((b) => b.username)
    expect(names).toContain(x.username)
    expect(names).toContain(y.username)

    const self = await postJson("/api/block", { username: me.username }, me)
    expect(self.status).toBe(400)
  })

  it("is private on the target's profile — youBlocked reflects only the viewer", async () => {
    const viewer = player("viewer")
    const subject = player("subject")
    await postJson("/api/block", { username: subject.username }, viewer)
    // The viewer sees youBlocked=true …
    const seen = await req(`/api/profile/${subject.username}`, { method: "GET" }, viewer)
    expect((await seen.json()).youBlocked).toBe(true)
    // … but a THIRD party (and the subject) is told nothing.
    const third = player("third")
    const other = await req(`/api/profile/${subject.username}`, { method: "GET" }, third)
    expect((await other.json()).youBlocked).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 + 4. Admin routes — allowlist gate and the actions
// ─────────────────────────────────────────────────────────────────────────────

describe("admin", () => {
  it("is 401 for nobody and 403 for a non-admin", async () => {
    const anon = await reqOn(adminApp, "/api/admin/reports", { method: "GET" })
    expect(anon.status).toBe(401)

    const nonAdmin = player("plebeian")
    const forbidden = await reqOn(adminApp, "/api/admin/reports", { method: "GET" }, nonAdmin)
    expect(forbidden.status).toBe(403)

    // And on the DEFAULT app (empty allowlist) even the owner account is 403 —
    // no account is an admin until the environment names it.
    const ownerOnDefault = await reqOn(app, "/api/admin/reports", { method: "GET" }, adminSession())
    expect(ownerOnDefault.status).toBe(403)
  })

  it("lists open reports for an allowlisted admin", async () => {
    const reporter = player("adminreporter")
    const target = player("admintarget")
    await postJson("/api/report", { targetUsername: target.username, reason: "hate" }, reporter)

    const res = await reqOn(adminApp, "/api/admin/reports?status=open", { method: "GET" }, adminSession())
    expect(res.status).toBe(200)
    const reports = AdminReportsResponseSchema.parse(await res.json()).reports
    expect(reports.some((r) => r.target === target.username && r.reason === "hate")).toBe(true)
  })

  it("removes a target's avatar and resets a target's display name to the placeholder", async () => {
    const offender = player("offender")
    const row = findUserByUsername(users, offender.username)!
    // A 1×1 PNG, magic-byte valid.
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
      "hex",
    )
    putAvatar(users, row.id, "image/png", png, Date.now())
    expect(getAvatarEtag(users, row.id)).toBeTruthy()

    const rm = await postOn(adminApp, "/api/admin/avatar/remove", { username: offender.username }, adminSession())
    expect(rm.status).toBe(200)
    expect(getAvatarEtag(users, row.id)).toBeNull()

    const reset = await postOn(adminApp, "/api/admin/display-name/reset", { username: offender.username }, adminSession())
    expect(reset.status).toBe(200)
    expect(findUserByUsername(users, offender.username)!.display_name).toBe(PLACEHOLDER_DISPLAY_NAME)
  })

  it("suspends an account — bars its login and revokes its live sessions", async () => {
    // A real password so the login route is exercisable.
    const now = Date.now()
    const username = `suspendme${++seq}`
    const passHash = await hashPassword("victim-pass-1")
    const row = createUser(users, { username, displayName: "victim", passHash, now })!
    const token = newSessionToken()
    createSession(users, { userId: row.id, tokenHash: hashToken(token), now })

    // Logs in fine before the suspension.
    const before = await postJson("/api/auth/login", { username, password: "victim-pass-1" })
    expect(before.status).toBe(200)

    const susp = await postOn(adminApp, "/api/admin/suspend", { username, days: 7 }, adminSession())
    expect(susp.status).toBe(200)
    expect(isSuspended(findUserByUsername(users, username)!, Date.now())).toBe(true)

    // The live session is gone …
    expect(sessionUser(users, hashToken(token), Date.now())).toBeNull()
    // … and the credentials no longer open the door.
    const after = await postJson("/api/auth/login", { username, password: "victim-pass-1" })
    expect(after.status).toBe(403)
    expect((await after.json()).error).toBe("account_suspended")

    // Unsuspend restores login.
    const un = await postOn(adminApp, "/api/admin/unsuspend", { username }, adminSession())
    expect(un.status).toBe(200)
    const restored = await postJson("/api/auth/login", { username, password: "victim-pass-1" })
    expect(restored.status).toBe(200)
  })

  it("resolves a report", async () => {
    const reporter = player("resolvereporter")
    const target = player("resolvetarget")
    await postJson("/api/report", { targetUsername: target.username, reason: "other" }, reporter)
    const open = listReports(users, { status: "open", limit: 200 })
    const mine = open.find((r) => r.target === target.username && r.reporter === reporter.username)!
    const res = await postOn(adminApp, "/api/admin/reports/resolve", { id: mine.id }, adminSession())
    expect(res.status).toBe(200)
    const stillOpen = listReports(users, { status: "open", limit: 200 }).some((r) => r.id === mine.id)
    expect(stillOpen).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. A ديوان is UGC too — reporting one, and the two admin actions over it
// ─────────────────────────────────────────────────────────────────────────────

/** A shelf owned by `who`, through the real route. */
async function makeAlbum(who: Player, fields: Record<string, unknown> = {}): Promise<string> {
  const res = await postJson("/api/albums", { title: "ديوانٌ لي", visibility: "public", ...fields }, who)
  expect(res.status).toBe(201)
  return (await res.json()).album.code as string
}

describe("reporting a ديوان", () => {
  it("files against the shelf AND its curator, and the queue carries both", async () => {
    const curator = player("albumcurator")
    const reporter = player("albumreporter")
    const code = await makeAlbum(curator, { title: "اسمٌ لا يليق", description: "وصفٌ لا يليق" })

    const res = await postJson("/api/report", { albumCode: code, reason: "inappropriate", context: "الديوان" }, reporter)
    expect(res.status).toBe(200)

    const row = listReports(users, { status: "open", limit: 200 }).find((r) => r.album?.code === code)!
    expect(row).toBeDefined()
    // The ACCOUNT is the shelf's owner — every existing admin action targets an
    // account, and a shelf has a person behind it.
    expect(row.target).toBe(curator.username)
    expect(row.reporter).toBe(reporter.username)
    expect(row.album?.title).toBe("اسمٌ لا يليق")
    expect(row.album?.description).toBe("وصفٌ لا يليق")
    expect(row.album?.visibility).toBe("public")
  })

  it("derives the reported account from the shelf, never from the name beside it", async () => {
    const curator = player("realcurator")
    const innocent = player("innocentbystander")
    const reporter = player("frameattempt")
    const code = await makeAlbum(curator)

    // The client names somebody else. The server ignores it.
    const res = await postJson(
      "/api/report",
      { albumCode: code, targetUsername: innocent.username, reason: "hate" },
      reporter,
    )
    expect(res.status).toBe(200)
    const row = listReports(users, { status: "open", limit: 200 }).find((r) => r.album?.code === code)!
    expect(row.target).toBe(curator.username)
    expect(listReports(users, { status: "all", limit: 200 }).some((r) => r.target === innocent.username)).toBe(false)
  })

  it("refuses a shelf the reporter cannot open — a private one is a 404, not a probe", async () => {
    const curator = player("privatecurator")
    const reporter = player("prober")
    const code = await makeAlbum(curator, { visibility: "private" })
    const res = await postJson("/api/report", { albumCode: code, reason: "spam" }, reporter)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("album_not_found")
  })

  it("refuses a report about your own ديوان", async () => {
    const curator = player("selfreporter")
    const code = await makeAlbum(curator)
    const res = await postJson("/api/report", { albumCode: code, reason: "other" }, curator)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("cannot_report_self")
  })

  it("still refuses a report that names neither an account nor a ديوان", async () => {
    const reporter = player("emptyreport")
    const res = await postJson("/api/report", { reason: "other" }, reporter)
    expect(res.status).toBe(400)
  })
})

describe("admin over a ديوان", () => {
  it("unlists a shelf — it leaves the profile and its link stops working, the أبيات stay", async () => {
    const curator = player("unlistme")
    const visitor = player("unlistvisitor")
    const code = await makeAlbum(curator, { title: "سيُخفى" })
    expect((await req(`/api/albums/${code}`, {}, visitor)).status).toBe(200)

    const res = await postOn(adminApp, "/api/admin/album/unlist", { code }, adminSession())
    expect(res.status).toBe(200)

    expect((await req(`/api/albums/${code}`, {}, visitor)).status).toBe(404)
    // The owner still has it, whole.
    const mine = await (await req(`/api/albums/${code}`, {}, curator)).json()
    expect(mine.album.visibility).toBe("private")
    expect(mine.album.title).toBe("سيُخفى")
    // …and it is off his page.
    const page = await (await req(`/api/profile/${curator.username}`, {})).json()
    expect(page.albums).toEqual([])
  })

  it("clears a وصف without touching the name, the أبيات or من يراه", async () => {
    const curator = player("descclear")
    const code = await makeAlbum(curator, { title: "اسمٌ سليم", description: "وصفٌ سيّئ" })
    const res = await postOn(adminApp, "/api/admin/album/description/clear", { code }, adminSession())
    expect(res.status).toBe(200)
    const after = await (await req(`/api/albums/${code}`, {}, curator)).json()
    expect(after.album.description).toBeNull()
    expect(after.album.title).toBe("اسمٌ سليم")
    expect(after.album.visibility).toBe("public")
  })

  it("is on the ALLOWLIST — an ordinary session is 403, none is 401", async () => {
    const curator = player("guardedalbum")
    const outsider = player("notanadmin")
    const code = await makeAlbum(curator)
    // The non-admin app has an empty allowlist, so even a live session is 403.
    expect((await postJson("/api/admin/album/unlist", { code }, outsider)).status).toBe(403)
    expect((await postJson("/api/admin/album/description/clear", { code }, outsider)).status).toBe(403)
    expect((await postOn(adminApp, "/api/admin/album/unlist", { code })).status).toBe(401)
    // …and the shelf is untouched by either attempt.
    const still = await (await req(`/api/albums/${code}`, {}, curator)).json()
    expect(still.album.visibility).toBe("public")
  })

  it("answers 404 for a code no ديوان carries", async () => {
    const res = await postOn(adminApp, "/api/admin/album/unlist", { code: "BADIRUBADI" }, adminSession())
    expect(res.status).toBe(404)
  })
})
