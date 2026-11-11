/**
 * One meaning of «the same username» everywhere (server/username.ts).
 *
 *  1. The key: NFKC then lowercase, so look-alike characters fold to the letter
 *     they imitate.
 *  2. Registration refuses a non-canonical name, a name another account owns
 *     under the key, and a name on the admin allowlist.
 *  3. Admin is the ACCOUNT that owns the allowlisted key, never a look-alike.
 *  4. Migration 12 gives existing accounts their key without locking anyone
 *     out, including accounts that collide under the new key.
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"

import { REPO_ROOT } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { isAdminAccount, isAdminUsername, loadConfig } from "./config.ts"
import { usernameKey } from "./username.ts"
import {
  SESSION_COOKIE,
  USERS_SCHEMA_VERSION,
  createSession,
  createUser,
  findUserByUsername,
  hashToken,
  migrate,
  newSessionToken,
  openUsersDb,
  type UsersDb,
} from "./users.ts"

const KELVIN = "K" // K KELVIN SIGN: a letter, lowercases to ASCII «k»
const ANGSTROM = "Å" // Å ANGSTROM SIGN

const TEMP: string[] = []
function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `username-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
  TEMP.push(p)
  return p
}
afterAll(() => {
  for (const p of TEMP) for (const s of ["", "-wal", "-shm"]) fs.rmSync(p + s, { force: true })
})

const configFor = (env: Record<string, string> = {}) =>
  loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test", ...env } as NodeJS.ProcessEnv)

let ip = 0
/** A JSON POST from a client of its own, so the register rate limit stays out of the way. */
function json(body: unknown): RequestInit {
  ip += 1
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": `10.77.${ip >> 8}.${ip & 255}` }
  return { method: "POST", headers, body: JSON.stringify(body) }
}

function sessionFor(users: UsersDb, username: string): string {
  const row = findUserByUsername(users, username)!
  const token = newSessionToken()
  createSession(users, { userId: row.id, tokenHash: hashToken(token), now: Date.now() })
  return token
}

describe("usernameKey", () => {
  it("folds case and look-alike characters to one key", () => {
    expect(usernameKey("Zahak")).toBe("zahak")
    expect(usernameKey(`zaha${KELVIN}`)).toBe("zahak")
    expect(usernameKey(`${ANGSTROM}sa`)).toBe(usernameKey("åsa"))
    expect(usernameKey("ｚａｈａｋ")).toBe("zahak") // full-width
    expect(usernameKey("Émile")).toBe(usernameKey("émile"))
    expect(usernameKey("الخنساء")).toBe("الخنساء")
  })
})

describe("registration and the admin allowlist", () => {
  it("refuses look-alikes, case variants and allowlisted names; admin is the account, not the name", async () => {
    const users = openUsersDb(tempUsersPath("register"))
    try {
      // The operator's account exists, then is listed; «ghost» is listed but has no account.
      createUser(users, { username: "zahak", displayName: "Owner", passHash: "scrypt$x", now: Date.now() })
      const config = configFor({ ADMIN_USERNAMES: "zahak, ghost" })
      const { app } = createApp(config, null, users)
      const register = (username: string) =>
        app.request("/api/auth/register", json({ username, password: "a long enough password" }))

      // A Kelvin-sign look-alike of the admin passes the username regex (it is a letter) but is refused.
      const kelvin = await register(`zaha${KELVIN}`)
      expect(kelvin.status).toBe(400)
      expect((await kelvin.json()).error).toBe("invalid_username")
      expect(await (await register("ｚａｈａｋ")).status).toBe(400)

      // A case variant is the same name.
      expect((await register("ZAHAK")).status).toBe(409)

      // A listed name with no account cannot be claimed, in any spelling.
      expect((await register("ghost")).status).toBe(409)
      expect((await register("GHOST")).status).toBe(409)
      expect(findUserByUsername(users, "ghost")).toBeNull()

      // Non-ASCII case variants collide too (SQLite's NOCASE alone would have let both in).
      expect((await register("Émile")).status).toBe(201)
      expect((await register("émile")).status).toBe(409)

      // The admin routes: the owner is admin, an ordinary account is not.
      const owner = sessionFor(users, "zahak")
      expect((await app.request("/api/admin/reports", { headers: { Cookie: `${SESSION_COOKIE}=${owner}` } })).status).toBe(200)
      const emile = sessionFor(users, "Émile")
      expect((await app.request("/api/admin/reports", { headers: { Cookie: `${SESSION_COOKIE}=${emile}` } })).status).toBe(403)

      // Login still finds the owner by any spelling of the name.
      expect(findUserByUsername(users, "ZAHAK")?.username).toBe("zahak")
      expect(findUserByUsername(users, `zaha${KELVIN}`)?.username).toBe("zahak")
    } finally {
      users.close()
    }
  })

  it("isAdminAccount needs the key, a canonical name, and the allowlist", () => {
    const config = configFor({ ADMIN_USERNAMES: "Zahak" })
    expect(isAdminUsername(config, `zaha${KELVIN}`)).toBe(true) // the NAME is reserved…
    expect(isAdminAccount(config, { username: "zahak", username_key: "zahak" })).toBe(true)
    expect(isAdminAccount(config, { username: `zaha${KELVIN}`, username_key: "zahak" })).toBe(false) // …the look-alike ACCOUNT is not admin
    expect(isAdminAccount(config, { username: `zaha${KELVIN}`, username_key: null })).toBe(false)
    expect(isAdminAccount(config, { username: "zahak", username_key: null })).toBe(false)
    expect(isAdminAccount(configFor(), { username: "zahak", username_key: "zahak" })).toBe(false)
  })
})

describe("migration 12 (username_key)", () => {
  it("keys existing accounts; a pre-existing look-alike keeps its login but not the name", async () => {
    const users = openUsersDb(tempUsersPath("migrate"))
    try {
      const raw = users.raw
      // Stand the database at schema 11 and seed it the old way: the look-alike was
      // registered FIRST, before the real owner, and two non-ASCII case variants exist.
      raw.exec("DROP INDEX users_username_key")
      raw.exec("ALTER TABLE users DROP COLUMN username_key")
      raw.exec("PRAGMA user_version = 11")
      const insert = raw.prepare(
        "INSERT INTO users (username, display_name, pass_hash, created_at, last_seen) VALUES (?, ?, 'scrypt$x', 0, 0)",
      )
      for (const name of [`zaha${KELVIN}`, "zahak", "Émile", "émile", "khansa"]) insert.run(name, name)

      expect(migrate(raw)).toBe(USERS_SCHEMA_VERSION)
      const keys = Object.fromEntries(
        (raw.prepare("SELECT username, username_key FROM users").all() as { username: string; username_key: string | null }[]).map(
          (r) => [r.username, r.username_key],
        ),
      )
      // The canonical spelling owns the key even though the look-alike is older.
      expect(keys).toEqual({ [`zaha${KELVIN}`]: null, zahak: "zahak", "Émile": "émile", "émile": null, khansa: "khansa" })

      // Nobody is locked out: every account is still found by its exact name.
      for (const name of [`zaha${KELVIN}`, "zahak", "Émile", "émile", "khansa"]) {
        expect(findUserByUsername(users, name)?.username).toBe(name)
      }
      // And the look-alike is never the admin.
      const config = configFor({ ADMIN_USERNAMES: "zahak" })
      const { app } = createApp(config, null, users)
      const lookalike = sessionFor(users, `zaha${KELVIN}`)
      expect((await app.request("/api/admin/reports", { headers: { Cookie: `${SESSION_COOKIE}=${lookalike}` } })).status).toBe(403)
      const owner = sessionFor(users, "zahak")
      expect((await app.request("/api/admin/reports", { headers: { Cookie: `${SESSION_COOKIE}=${owner}` } })).status).toBe(200)
    } finally {
      users.close()
    }
  })
})
