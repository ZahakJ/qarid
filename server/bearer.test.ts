/**
 * Optional bearer-token sessions + the Capacitor CORS allowlist
 * (docs/roadmap-mobile.md §M1). This is a security surface, so every bullet of
 * the roadmap's «Security bar for the bearer-token work» has a test here:
 *
 *   • a token is issued ONLY when the client asks (a header or a body flag),
 *   • `Authorization: Bearer <token>` is accepted everywhere the cookie is —
 *     /auth/me, /auth/logout, /profile/*, /api/room/* and the /ws/room upgrade,
 *   • tokens EXPIRE and ROLL exactly like cookie sessions,
 *   • a password change REVOKES every session — cookie and bearer alike,
 *   • a token is never written to a log, a URL, or an error message,
 *   • issuance is confined to an https origin or localhost,
 *   • issuance rides the auth (login) rate-limit bucket,
 *   • the CORS allowlist echoes an allowlisted origin (never `*`), handles
 *     credentials and the OPTIONS preflight, and COMPOSES with the CSRF guard —
 *     a capacitor origin is let through, every other cross-origin write is not.
 *
 * Everything drives the REAL app over a REAL users database, exactly like
 * auth.test.ts; the /room and WebSocket halves add the fixture corpus and a
 * real listening socket, exactly like rooms.test.ts.
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { serve, type ServerType } from "@hono/node-server"
import type { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AuthSessionResponseSchema, RoomStateResponseSchema } from "../shared/schema.ts"
import { FIXTURE_DB, REPO_ROOT, ensureFixtureDb } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig, type Config } from "./config.ts"
import { openDb, type Db } from "./db.ts"
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createUser,
  hashPassword,
  hashToken,
  openUsersDb,
  sessionUser,
  type UsersDb,
} from "./users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DBS: string[] = []

function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `bearer-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
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

/** Every `Set-Cookie` on a response, runtime-independent. */
function setCookies(res: Response): string[] {
  const all = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
  if (all && all.length) return all
  const one = res.headers.get("set-cookie")
  return one ? [one] : []
}

function bearer(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } }
}

afterAll(removeTempDbs)

// ─────────────────────────────────────────────────────────────────────────────
// Issuance: only on request, only over a secure origin, rate-limited
// ─────────────────────────────────────────────────────────────────────────────

describe("bearer issuance", () => {
  let db: UsersDb
  let app: Hono

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("issue"))
    app = createApp(configFor(), null, db).app
  })
  afterAll(() => db.close())

  it("mints NO token unless the client asks — the web flow is unchanged", async () => {
    const res = await app.request("/api/auth/register", json({ username: "webonly", password: "a good password" }))
    expect(res.status).toBe(201)
    const body = AuthSessionResponseSchema.parse(await res.json())
    expect(body.token).toBeUndefined()
    // …but a cookie was set, as always.
    expect(setCookies(res).some((c) => c.includes(`${SESSION_COOKIE}=`))).toBe(true)
  })

  it("mints one when the body flag asks, and it authenticates over the header", async () => {
    const res = await app.request("/api/auth/register", json({ username: "flaguser", password: "a good password", bearer: true }))
    expect(res.status).toBe(201)
    const body = AuthSessionResponseSchema.parse(await res.json())
    expect(typeof body.token).toBe("string")

    // The token is a live session — with NO cookie on the request.
    const me = await app.request("/api/auth/me", bearer(body.token!))
    expect((await me.json()).user).toMatchObject({ username: "flaguser" })
  })

  it("mints one when the X-Client: capacitor header asks", async () => {
    const res = await app.request(
      "/api/auth/register",
      json({ username: "headeruser", password: "a good password" }, { "X-Client": "capacitor" }),
    )
    const body = AuthSessionResponseSchema.parse(await res.json())
    expect(typeof body.token).toBe("string")
  })

  it("returns a token on login too, only when asked", async () => {
    const bare = await app.request("/api/auth/login", json({ username: "flaguser", password: "a good password" }))
    expect(AuthSessionResponseSchema.parse(await bare.json()).token).toBeUndefined()

    const asked = await app.request("/api/auth/login", json({ username: "flaguser", password: "a good password", bearer: true }))
    expect(typeof AuthSessionResponseSchema.parse(await asked.json()).token).toBe("string")
  })
})

describe("bearer issuance is confined to a secure origin", () => {
  it("is allowed on https and on localhost, refused over plain http to a public host", async () => {
    // https production origin → allowed
    const httpsDb = openUsersDb(tempUsersPath("https"))
    const https = createApp(configFor({ PUBLIC_ORIGIN: "https://qarid.example.com" }), null, httpsDb).app
    const a = await https.request("/api/auth/register", json({ username: "onhttps", password: "a good password", bearer: true }))
    expect(a.status).toBe(201)
    expect(typeof AuthSessionResponseSchema.parse(await a.json()).token).toBe("string")
    httpsDb.close()

    // http localhost (dev / smoke / emulator) → allowed
    const localDb = openUsersDb(tempUsersPath("local"))
    const local = createApp(configFor({ PUBLIC_ORIGIN: "http://localhost:6750" }), null, localDb).app
    const b = await local.request("/api/auth/register", json({ username: "onlocal", password: "a good password", bearer: true }))
    expect(b.status).toBe(201)
    expect(typeof AuthSessionResponseSchema.parse(await b.json()).token).toBe("string")
    localDb.close()

    // http to a public host → a token in the clear, refused
    const insecureDb = openUsersDb(tempUsersPath("insecure"))
    const insecure = createApp(configFor({ PUBLIC_ORIGIN: "http://qarid.example.com" }), null, insecureDb).app
    const c = await insecure.request("/api/auth/register", json({ username: "onhttp", password: "a good password", bearer: true }))
    expect(c.status).toBe(403)
    expect(await c.json()).toMatchObject({ error: "insecure_bearer" })
    // and it did not create the account behind the refusal
    expect(insecureDb.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE username='onhttp'").get()).toMatchObject({ n: 0 })
    insecureDb.close()
  })
})

describe("bearer issuance rides the login rate-limit bucket", () => {
  it("429s once the auth bucket is spent", async () => {
    const db = openUsersDb(tempUsersPath("limit"))
    const app = createApp(configFor(), null, db).app
    createUser(db, { username: "spendme", displayName: "spendme", passHash: await hashPassword("a good password"), now: Date.now() })

    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const res = await app.request("/api/auth/login", json({ username: "spendme", password: "a good password", bearer: true }))
      statuses.push(res.status)
    }
    // 10 per hour (LOGIN_LIMIT), then the eleventh is refused.
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Acceptance on the HTTP surfaces
// ─────────────────────────────────────────────────────────────────────────────

describe("Authorization: Bearer is accepted wherever the cookie is", () => {
  let db: UsersDb
  let app: Hono
  let token: string

  beforeAll(async () => {
    db = openUsersDb(tempUsersPath("accept"))
    app = createApp(configFor(), null, db).app
    const res = await app.request("/api/auth/register", json({ username: "bearerme", displayName: "حامل", password: "a good password", bearer: true }))
    token = AuthSessionResponseSchema.parse(await res.json()).token!
  })
  afterAll(() => db.close())

  it("names me on /auth/me", async () => {
    const me = await app.request("/api/auth/me", bearer(token))
    expect((await me.json()).user).toMatchObject({ username: "bearerme" })
  })

  it("renames me on /profile/update — a POST the origin guard also let through", async () => {
    const res = await app.request("/api/profile/update", bearer(token, json({ displayName: "الحامل الجديد" })))
    expect(res.status).toBe(200)
    expect((await res.json()).user.displayName).toBe("الحامل الجديد")
  })

  it("revokes exactly that session on /auth/logout", async () => {
    // A throwaway session so the shared one survives for later tests.
    const reg = await app.request("/api/auth/register", json({ username: "logoutme", password: "a good password", bearer: true }))
    const t = AuthSessionResponseSchema.parse(await reg.json()).token!
    expect(sessionUser(db, hashToken(t), Date.now())).not.toBeNull()

    const out = await app.request("/api/auth/logout", bearer(t, json({})))
    expect(out.status).toBe(200)
    expect(sessionUser(db, hashToken(t), Date.now())).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Expiry and roll — exactly the cookie behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("bearer sessions expire and roll like cookie sessions", () => {
  let db: UsersDb
  let app: Hono

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("roll"))
    app = createApp(configFor(), null, db).app
  })
  afterAll(() => db.close())

  it("rolls a two-day-old session in the TABLE, and sets NO cookie doing it", async () => {
    const reg = await app.request("/api/auth/register", json({ username: "roller", password: "a good password", bearer: true }))
    const token = AuthSessionResponseSchema.parse(await reg.json()).token!
    const hash = hashToken(token)
    const aged = Date.now() - 2 * 24 * 60 * 60 * 1000
    db.raw.prepare("UPDATE sessions SET created_at = ?, expires_at = ? WHERE token_hash = ?").run(aged, aged + SESSION_TTL_MS, hash)

    const me = await app.request("/api/auth/me", bearer(token))
    expect((await me.json()).user).toMatchObject({ username: "roller" })
    // Rolled in the table…
    const row = db.raw.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(hash) as { expires_at: number }
    expect(Number(row.expires_at)).toBeGreaterThan(aged + SESSION_TTL_MS)
    // …but a header-authenticated request must not try to set a cookie.
    expect(setCookies(me)).toEqual([])
  })

  it("treats an expired token as nobody, and sweeps the row", async () => {
    const reg = await app.request("/api/auth/register", json({ username: "expiring", password: "a good password", bearer: true }))
    const token = AuthSessionResponseSchema.parse(await reg.json()).token!
    const hash = hashToken(token)
    db.raw.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1000, hash)

    const me = await app.request("/api/auth/me", bearer(token))
    expect((await me.json()).user).toBeNull()
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?").get(hash)).toMatchObject({ n: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Password change revokes every session
// ─────────────────────────────────────────────────────────────────────────────

describe("a password change revokes every token — cookie and bearer", () => {
  let db: UsersDb
  let app: Hono

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("password"))
    app = createApp(configFor(), null, db).app
  })
  afterAll(() => db.close())

  it("kills a pre-existing cookie session AND a pre-existing bearer session", async () => {
    // One account, two live sessions the way two devices would hold them.
    const reg = await app.request("/api/auth/register", json({ username: "changer", password: "old password here", bearer: true }))
    const cookieToken = setCookies(reg)
      .flatMap((c) => /qarid_sess=([^;]*)/.exec(c) ?? [])
      .at(1) as string
    const bearerA = AuthSessionResponseSchema.parse(await reg.json()).token!
    const login = await app.request("/api/auth/login", json({ username: "changer", password: "old password here", bearer: true }))
    const bearerB = AuthSessionResponseSchema.parse(await login.json()).token!

    expect(sessionUser(db, hashToken(bearerA), Date.now())).not.toBeNull()
    expect(sessionUser(db, hashToken(bearerB), Date.now())).not.toBeNull()

    // Change the password using one of them, asking for a fresh bearer back.
    const changed = await app.request(
      "/api/auth/password",
      bearer(bearerB, json({ oldPassword: "old password here", newPassword: "a brand new password", bearer: true })),
    )
    expect(changed.status).toBe(200)
    const fresh = AuthSessionResponseSchema.parse(await changed.json()).token!

    // Every OLD token — cookie and both bearers — is dead.
    expect(sessionUser(db, hashToken(cookieToken), Date.now())).toBeNull()
    expect(sessionUser(db, hashToken(bearerA), Date.now())).toBeNull()
    expect(sessionUser(db, hashToken(bearerB), Date.now())).toBeNull()
    // The device that changed it keeps a working, freshly-minted session.
    expect((await (await app.request("/api/auth/me", bearer(fresh))).json()).user).toMatchObject({ username: "changer" })
    // And the new password works, the old one does not.
    expect((await app.request("/api/auth/login", json({ username: "changer", password: "a brand new password" }))).status).toBe(200)
    expect((await app.request("/api/auth/login", json({ username: "changer", password: "old password here" }))).status).toBe(401)
  })

  it("refuses the wrong current password, leaving sessions intact", async () => {
    const reg = await app.request("/api/auth/register", json({ username: "careful", password: "the real password", bearer: true }))
    const token = AuthSessionResponseSchema.parse(await reg.json()).token!
    const res = await app.request(
      "/api/auth/password",
      bearer(token, json({ oldPassword: "not the password", newPassword: "a fine new password" })),
    )
    expect(res.status).toBe(401)
    expect(sessionUser(db, hashToken(token), Date.now())).not.toBeNull()
  })

  it("400s a new password under eight characters, and 401s an anonymous caller", async () => {
    const reg = await app.request("/api/auth/register", json({ username: "shorty", password: "the real password", bearer: true }))
    const token = AuthSessionResponseSchema.parse(await reg.json()).token!
    const short = await app.request("/api/auth/password", bearer(token, json({ oldPassword: "the real password", newPassword: "1234567" })))
    expect(short.status).toBe(400)
    const anon = await app.request("/api/auth/password", json({ oldPassword: "x", newPassword: "a fine new password" }))
    expect(anon.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A token never appears in a log, a URL, or an error message
// ─────────────────────────────────────────────────────────────────────────────

describe("a token never leaks into a log or an error message", () => {
  it("logs nothing containing the token across a whole login lifecycle", async () => {
    const db = openUsersDb(tempUsersPath("nolog"))
    const app = createApp(configFor(), null, db).app

    const logged: string[] = []
    const patch = (m: "log" | "warn" | "error") => {
      const orig = console[m]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console[m] = (...args: any[]) => {
        logged.push(args.map((a) => String(a)).join(" "))
        orig(...args)
      }
      return () => (console[m] = orig)
    }
    const restore = [patch("log"), patch("warn"), patch("error")]
    let token: string
    try {
      const reg = await app.request("/api/auth/register", json({ username: "quiet", password: "a good password", bearer: true }))
      token = AuthSessionResponseSchema.parse(await reg.json()).token!
      await app.request("/api/auth/me", bearer(token))
      // A rejected turn / bad request path, to sweep the error messages too.
      const bad = await app.request("/api/auth/password", bearer(token, json({ oldPassword: "wrong", newPassword: "another good one" })))
      expect(bad.status).toBe(401)
      expect(JSON.stringify(await bad.json())).not.toContain(token)
      await app.request("/api/auth/logout", bearer(token, json({})))
    } finally {
      restore.forEach((r) => r())
    }
    expect(logged.some((line) => line.includes(token!))).toBe(false)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CORS allowlist, preflight, and composition with the CSRF guard
// ─────────────────────────────────────────────────────────────────────────────

describe("CORS allowlist for the Capacitor app", () => {
  let db: UsersDb
  let app: Hono
  let token: string
  const HOST = "qarid.example.com"

  beforeAll(async () => {
    db = openUsersDb(tempUsersPath("cors"))
    app = createApp(configFor({ PUBLIC_ORIGIN: "https://qarid.example.com" }), null, db).app
    const reg = await app.request("/api/auth/register", json({ username: "capuser", password: "a good password", bearer: true }))
    token = AuthSessionResponseSchema.parse(await reg.json()).token!
  })
  afterAll(() => db.close())

  it("answers a preflight, echoing the origin and allowing credentials — never *", async () => {
    for (const origin of ["capacitor://localhost", "https://localhost", "ionic://localhost"]) {
      const res = await app.request("/api/auth/login", { method: "OPTIONS", headers: { Origin: origin } })
      expect(res.status).toBe(204)
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin)
      expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*")
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true")
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization")
    }
  })

  it("echoes the allow-origin on the real response too", async () => {
    const res = await app.request("/api/auth/me", bearer(token, { headers: { Origin: "capacitor://localhost" } }))
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("capacitor://localhost")
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true")
  })

  it("lets an allowlisted origin through the CSRF guard on a write — even cross-site", async () => {
    // A Capacitor WebView's fetch is genuinely cross-site: Sec-Fetch-Site says so.
    const res = await app.request("/api/profile/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: HOST,
        Origin: "capacitor://localhost",
        "Sec-Fetch-Site": "cross-site",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ displayName: "من الهاتف" }),
    })
    expect(res.status).toBe(200)
  })

  it("still 403s every OTHER cross-origin write — the CSRF fix is not weakened", async () => {
    for (const origin of ["https://meme.example.com", "https://evil.example", "https://localhost.example.com"]) {
      const res = await app.request("/api/profile/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: HOST,
          Origin: origin,
          "Sec-Fetch-Site": "cross-site",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ displayName: "مخترق" }),
      })
      expect(res.status, origin).toBe(403)
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
    }
  })

  it("does not answer a preflight for a non-allowlisted origin", async () => {
    const res = await app.request("/api/auth/login", { method: "OPTIONS", headers: { Origin: "https://meme.example.com" } })
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
    expect(res.status).not.toBe(204)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The corpus-backed surfaces: /api/room and the /ws/room upgrade
// ─────────────────────────────────────────────────────────────────────────────

describe("bearer on the room surfaces", () => {
  let server: ServerType
  let db: Db
  let users: UsersDb
  let app: Hono
  let port = 0
  let token: string

  beforeAll(async () => {
    await ensureFixtureDb()
    db = openDb(FIXTURE_DB)
    users = openUsersDb(tempUsersPath("room"))
    app = createApp(loadConfig({ HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test" } as NodeJS.ProcessEnv), db, users)
      .app
    const reg = await app.request("/api/auth/register", json({ username: "roomer", password: "a good password", bearer: true }))
    token = AuthSessionResponseSchema.parse(await reg.json()).token!
  }, 60_000)
  afterAll(() => {
    db?.close()
    users?.close()
  })

  it("authenticates GET /api/room/opening over the header", async () => {
    const res = await app.request("/api/room/opening", bearer(token))
    expect(res.status).toBe(200)
    expect((await res.json()).bait).toBeTruthy()
  })

  it("authenticates POST /api/room over the header", async () => {
    const res = await app.request("/api/room", bearer(token, json({ baitId: 1 })))
    expect(res.status).toBe(201)
    expect(RoomStateResponseSchema.parse(await res.json()).state.status).toBe("waiting")
  })

  it("authenticates the /ws/room upgrade over an Authorization header", async () => {
    // A separate real server, because the socket needs a real listener.
    const wsUsers = openUsersDb(tempUsersPath("wsroom"))
    const built = createApp(loadConfig({ HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test" } as NodeJS.ProcessEnv), db, wsUsers)
    const wsApp = built.app
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: wsApp.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s))
    })
    built.injectWebSocket(server)
    const addr = server.address()
    port = typeof addr === "object" && addr !== null ? addr.port : 0

    const reg = await wsApp.request("/api/auth/register", json({ username: "wsbearer", password: "a good password", bearer: true }))
    const wsToken = AuthSessionResponseSchema.parse(await reg.json()).token!
    const created = RoomStateResponseSchema.parse(
      await (await wsApp.request("/api/room", bearer(wsToken, json({ baitId: 1 })))).json(),
    ).state

    // The WebView sets the header on the upgrade — a browser could not.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/room/${created.code}`, {
      headers: { Authorization: `Bearer ${wsToken}` },
    } as unknown as string[])

    const firstEvent: unknown = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 8000)
      ws.addEventListener("message", (evt) => {
        clearTimeout(timer)
        resolve(JSON.parse(String((evt as MessageEvent).data)))
      }, { once: true })
      ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("socket errored"))
      }, { once: true })
    })
    // A live session on the upgrade → the room's own state, not an auth error.
    expect(firstEvent).toMatchObject({ type: "state" })

    ws.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    wsUsers.close()
  }, 20_000)
})
