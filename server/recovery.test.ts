/**
 * No-email password recovery (Play launch).
 *
 * A recovery code is shown ONCE at registration and stored only as a scrypt
 * hash. `POST /api/auth/reset` sets a new password with it, revokes every
 * session, and rotates the code; `POST /api/auth/recovery` regenerates it for a
 * signed-in reader. The whole thing must be neither a user-enumeration oracle
 * nor a code-guessing tool — those are the properties these tests pin.
 *
 * Same harness as `auth.test.ts`: a REAL app over a REAL, gitignored users db
 * under `data/`, corpus handle `null` (accounts work on a box that never ran
 * `npm run ingest`).
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest"
import type { Hono } from "hono"

import { AuthSessionResponseSchema, RecoveryRegenerateResponseSchema } from "../shared/schema.ts"
import { REPO_ROOT } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig, type Config } from "./config.ts"
import {
  SESSION_COOKIE,
  canonicalizeRecoveryCode,
  generateRecoveryCode,
  hashToken,
  openUsersDb,
  sessionUser,
  verifyPassword,
  verifyRecoveryCode,
  type UsersDb,
} from "./users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DBS: string[] = []

function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `recovery-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
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

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

function setCookies(res: Response): string[] {
  const all = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
  if (all && all.length) return all
  const one = res.headers.get("set-cookie")
  return one ? [one] : []
}

function sessionCookie(res: Response): string | null {
  for (const c of setCookies(res)) {
    const m = /(?:^|,\s*)qarid_sess=([^;]*)/.exec(c)
    if (m) return m[1] ?? null
  }
  return null
}

function withCookie(init: RequestInit, token: string): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: `${SESSION_COOKIE}=${token}` } }
}

/** Register a user, returning the app response and the once-shown code. */
async function registerUser(app: Hono, username: string, password: string) {
  const res = await app.request("/api/auth/register", json({ username, password }))
  const body = AuthSessionResponseSchema.parse(await res.json())
  return { res, body, code: body.recoveryCode! }
}

// ─────────────────────────────────────────────────────────────────────────────
// The code itself
// ─────────────────────────────────────────────────────────────────────────────

describe("recovery code format", () => {
  it("is grouped, high-entropy, and canonicalizes look-alikes back in", () => {
    const code = generateRecoveryCode()
    // 4 groups of 5 Crockford symbols.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/)
    const canon = canonicalizeRecoveryCode(code)!
    expect(canon).toHaveLength(20)
    // Dashes, case and O/I/L look-alikes all fold to the same canonical string.
    const messy = code.toLowerCase().replace(/-/g, " ")
    expect(canonicalizeRecoveryCode(messy)).toBe(canon)
    expect(canonicalizeRecoveryCode("OIL" + code)).toBeNull() // wrong length → null
    expect(canonicalizeRecoveryCode("!!!!!-!!!!!-!!!!!-!!!!!")).toBeNull() // illegal symbols
  })

  it("maps O→0 and I/L→1 rather than rejecting them", () => {
    // A canonical string with a 0 and a 1 can be typed back with O and L.
    const canon = canonicalizeRecoveryCode(generateRecoveryCode())!
    const typed = canon.replace(/0/g, "O").replace(/1/g, "L")
    expect(canonicalizeRecoveryCode(typed)).toBe(canon)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The wire
// ─────────────────────────────────────────────────────────────────────────────

describe("recovery over the app", () => {
  let db: UsersDb
  const config = configFor()

  // A FRESH app per test, sharing the one db: the register/reset limiters live
  // on the app instance, so a new one gives each test its own untouched buckets
  // and the six registrations below never collide on the 5/hour/IP cap.
  const freshApp = (): Hono => createApp(config, null, db).app
  let app: Hono

  beforeAll(() => {
    db = openUsersDb(tempUsersPath("wire"))
  })
  beforeEach(() => {
    app = freshApp()
  })
  afterAll(() => {
    db.close()
  })

  it("hands a recovery code back on register, and stores ONLY its hash", async () => {
    const { code } = await registerUser(app, "farazdaq", "a good password")
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/)

    const row = db.raw
      .prepare(
        "SELECT r.code_hash FROM user_recovery r JOIN users u ON u.id = r.user_id WHERE u.username = 'farazdaq'",
      )
      .get() as { code_hash: string } | undefined
    expect(row).toBeTruthy()
    // A scrypt hash, never the plaintext, and never a substring of it.
    expect(row!.code_hash.startsWith("scrypt$")).toBe(true)
    expect(row!.code_hash).not.toContain(canonicalizeRecoveryCode(code)!)
    expect(await verifyRecoveryCode(canonicalizeRecoveryCode(code)!, row!.code_hash)).toBe(true)
  })

  it("resets with the right code: new password works, sessions revoked, code rotated", async () => {
    const { res, code } = await registerUser(app, "jarir", "old password here")
    const oldToken = sessionCookie(res)!
    expect(sessionUser(db, hashToken(oldToken), Date.now())).not.toBeNull()

    const reset = await app.request(
      "/api/auth/reset",
      json({ username: "jarir", recoveryCode: code, newPassword: "brand new password" }),
    )
    expect(reset.status).toBe(200)
    const body = AuthSessionResponseSchema.parse(await reset.json())
    // A NEW code came back — and it is not the one just spent.
    expect(body.recoveryCode).toBeTruthy()
    expect(body.recoveryCode).not.toBe(code)

    // Every prior session is revoked; a fresh one was minted for this device.
    expect(sessionUser(db, hashToken(oldToken), Date.now())).toBeNull()
    expect(sessionCookie(reset)).toBeTruthy()

    // The new password logs in; the old one does not.
    const good = await app.request("/api/auth/login", json({ username: "jarir", password: "brand new password" }))
    expect(good.status).toBe(200)
    const stale = await app.request("/api/auth/login", json({ username: "jarir", password: "old password here" }))
    expect(stale.status).toBe(401)

    // The OLD code no longer resets anything.
    const reused = await app.request(
      "/api/auth/reset",
      json({ username: "jarir", recoveryCode: code, newPassword: "another one entirely" }),
    )
    expect(reused.status).toBe(401)
    expect(await reused.json()).toMatchObject({ error: "bad_recovery" })

    // The NEW code does.
    const again = await app.request(
      "/api/auth/reset",
      json({ username: "jarir", recoveryCode: body.recoveryCode!, newPassword: "third password now" }),
    )
    expect(again.status).toBe(200)
  })

  it("re-keys the password with scrypt (the stored hash actually verifies)", async () => {
    const { code } = await registerUser(app, "akhtal", "first password")
    await app.request("/api/auth/reset", json({ username: "akhtal", recoveryCode: code, newPassword: "second password" }))
    const row = db.raw.prepare("SELECT pass_hash FROM users WHERE username = 'akhtal'").get() as { pass_hash: string }
    expect(row.pass_hash.startsWith("scrypt$")).toBe(true)
    expect(await verifyPassword("second password", row.pass_hash)).toBe(true)
    expect(await verifyPassword("first password", row.pass_hash)).toBe(false)
  })

  it("refuses a wrong code, and unknown-user is indistinguishable from bad-code", async () => {
    await registerUser(app, "buhturi", "a good password")

    const wrongCode = await app.request(
      "/api/auth/reset",
      json({ username: "buhturi", recoveryCode: generateRecoveryCode(), newPassword: "would-be new password" }),
    )
    const unknownUser = await app.request(
      "/api/auth/reset",
      json({ username: "nobody-at-all", recoveryCode: generateRecoveryCode(), newPassword: "would-be new password" }),
    )
    expect(wrongCode.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    // Byte-identical bodies — the reset route is not an account-existence oracle.
    expect(await wrongCode.json()).toEqual(await unknownUser.json())

    // And the password was NOT changed by the failed attempt.
    const still = await app.request("/api/auth/login", json({ username: "buhturi", password: "a good password" }))
    expect(still.status).toBe(200)
  })

  it("400s a too-short new password before touching anything", async () => {
    const { code } = await registerUser(app, "nabigha", "a good password")
    const res = await app.request(
      "/api/auth/reset",
      json({ username: "nabigha", recoveryCode: code, newPassword: "1234567" }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "bad_body" })
    // The good code is still spendable — the 400 rejected before any rotation.
    const ok = await app.request(
      "/api/auth/reset",
      json({ username: "nabigha", recoveryCode: code, newPassword: "an eight-plus password" }),
    )
    expect(ok.status).toBe(200)
  })

  it("regenerates for a signed-in reader, invalidating the old code", async () => {
    const { res, code } = await registerUser(app, "khansa", "a good password")
    const token = sessionCookie(res)!

    const anon = await app.request("/api/auth/recovery", json({}))
    expect(anon.status).toBe(401)

    const regen = await app.request("/api/auth/recovery", withCookie(json({}), token))
    expect(regen.status).toBe(200)
    const body = RecoveryRegenerateResponseSchema.parse(await regen.json())
    expect(body.recoveryCode).toBeTruthy()
    expect(body.recoveryCode).not.toBe(code)

    // The ORIGINAL signup code no longer resets; the regenerated one does.
    const oldFails = await app.request(
      "/api/auth/reset",
      json({ username: "khansa", recoveryCode: code, newPassword: "would-be password" }),
    )
    expect(oldFails.status).toBe(401)
    const newWorks = await app.request(
      "/api/auth/reset",
      json({ username: "khansa", recoveryCode: body.recoveryCode, newPassword: "a fresh strong password" }),
    )
    expect(newWorks.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Guessing defences
// ─────────────────────────────────────────────────────────────────────────────

describe("recovery lockout (per-username) and IP rate limit", () => {
  it("locks the reset door for a username after five wrong codes", async () => {
    const db = openUsersDb(tempUsersPath("lock"))
    try {
      const app = createApp(configFor(), null, db).app
      const { code } = await registerUser(app, "labid", "a good password")

      // Five wrong codes → the fifth trips the lock.
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) {
        const r = await app.request(
          "/api/auth/reset",
          json({ username: "labid", recoveryCode: generateRecoveryCode(), newPassword: "would-be password" }),
        )
        statuses.push(r.status)
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401])

      // Now even the RIGHT code is refused with 429 while the window holds — the
      // door is shut, not just the guess.
      const lockedOut = await app.request(
        "/api/auth/reset",
        json({ username: "labid", recoveryCode: code, newPassword: "a real new password" }),
      )
      expect(lockedOut.status).toBe(429)
      expect(await lockedOut.json()).toMatchObject({ error: "recovery_locked" })

      // The account was NOT re-keyed while locked.
      const stillOld = await app.request("/api/auth/login", json({ username: "labid", password: "a good password" }))
      expect(stillOld.status).toBe(200)
    } finally {
      db.close()
    }
  })

  it("hard-limits reset attempts by IP", async () => {
    const db = openUsersDb(tempUsersPath("iprate"))
    try {
      const app = createApp(configFor(), null, db).app
      // Spread across distinct usernames so the per-username lock never fires —
      // this isolates the IP bucket (10/hour).
      const statuses: number[] = []
      for (let i = 0; i < 11; i++) {
        const r = await app.request(
          "/api/auth/reset",
          json({ username: `ghost${i}`, recoveryCode: generateRecoveryCode(), newPassword: "would-be password" }),
        )
        statuses.push(r.status)
      }
      // Ten 401s (unknown user), then the eleventh is throttled by IP.
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true)
      expect(statuses[10]).toBe(429)
    } finally {
      db.close()
    }
  })
})

afterAll(removeTempDbs)
