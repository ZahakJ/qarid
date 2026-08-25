/**
 * The three doors a cookie can be walked through, and the one thing a public
 * page must not publish.
 *
 * Everything here drives the REAL app over a REAL users database, because each
 * of these was reproduced end to end against exactly that: a `text/plain` POST
 * from a sibling `*.avicenna.space` page renamed a signed-in reader's account,
 * and `GET /api/profile/:username` — which needs no cookie at all — handed an
 * unauthenticated scraper the live code of every مساجلة the site had open.
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Hono } from "hono"

import { ProfileResponseSchema } from "../shared/schema.ts"
import { REPO_ROOT } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig, type Config } from "./config.ts"
import { fetchSiteAllowed, needsOriginCheck, originAllowed } from "./origin.ts"
import { createSession, createUser, hashToken, newSessionToken, openUsersDb, type UsersDb } from "./users.ts"

const PUBLIC_ORIGIN = "https://qarid.avicenna.space"
const HOST = "qarid.avicenna.space"

const TEMP_DBS: string[] = []

function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `sec-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
  TEMP_DBS.push(p)
  return p
}

let users: UsersDb
let app: Hono
let config: Config
let token: string

beforeAll(() => {
  users = openUsersDb(tempUsersPath("main"))
  config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "5750",
    NODE_ENV: "test",
    PUBLIC_ORIGIN,
  } as NodeJS.ProcessEnv)
  app = createApp(config, null, users).app

  const now = Date.now()
  const row = createUser(users, { username: "victim", displayName: "ضحية", passHash: "scrypt$x", now })!
  token = newSessionToken()
  createSession(users, { userId: row.id, tokenHash: hashToken(token), now })
})

afterAll(() => {
  users?.close()
  for (const p of TEMP_DBS) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(p + suffix, { force: true })
      } catch {
        /* the assertion that mattered already ran */
      }
    }
  }
})

async function post(pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(pathname, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: HOST,
      Cookie: `qarid_sess=${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

// ─────────────────────────────────────────────────────────────────────────────

describe("originAllowed / fetchSiteAllowed", () => {
  it("accepts the site's own origin, and the host this request was addressed to", () => {
    expect(originAllowed(PUBLIC_ORIGIN, HOST, PUBLIC_ORIGIN)).toBe(true)
    // dev: vite on 5751 proxies /api to 5750, so Origin and Host agree
    expect(originAllowed("http://localhost:5751", "localhost:5751", PUBLIC_ORIGIN)).toBe(true)
    // …and a smoke run on loopback, where PUBLIC_ORIGIN is something else
    expect(originAllowed("http://127.0.0.1:6750", "127.0.0.1:6750", PUBLIC_ORIGIN)).toBe(true)
  })

  it("refuses a SIBLING under the same registrable domain — the whole point", () => {
    // SameSite=Lax is computed on `avicenna.space`, so every one of these sends
    // the session cookie with a forged POST.
    for (const sibling of [
      "https://meme.avicenna.space",
      "https://alchemy.avicenna.space",
      "https://vestige.avicenna.space",
    ]) {
      expect(originAllowed(sibling, HOST, PUBLIC_ORIGIN), sibling).toBe(false)
    }
    expect(originAllowed("https://evil.example", HOST, PUBLIC_ORIGIN)).toBe(false)
    // A sandboxed iframe or a `data:` document sends the literal string.
    expect(originAllowed("null", HOST, PUBLIC_ORIGIN)).toBe(false)
  })

  it("allows a request with no Origin at all — curl, a native client, a test", () => {
    expect(originAllowed(undefined, HOST, PUBLIC_ORIGIN)).toBe(true)
  })

  it("reads Sec-Fetch-Site the way the browser means it", () => {
    expect(fetchSiteAllowed("same-origin")).toBe(true)
    expect(fetchSiteAllowed("none")).toBe(true)
    expect(fetchSiteAllowed("same-site")).toBe(false)
    expect(fetchSiteAllowed("cross-site")).toBe(false)
    expect(fetchSiteAllowed(undefined)).toBe(true)
  })

  it("guards what changes something, and the upgrade — not ordinary reads", () => {
    expect(needsOriginCheck("POST", "/api/profile/update")).toBe(true)
    expect(needsOriginCheck("DELETE", "/api/anything")).toBe(true)
    expect(needsOriginCheck("GET", "/ws/room/BADIRU")).toBe(true)
    expect(needsOriginCheck("GET", "/api/search")).toBe(false)
    expect(needsOriginCheck("HEAD", "/api/meta")).toBe(false)
  })
})

describe("the forged cross-site POST", () => {
  it("refuses a rename from a sibling subdomain, cookie and all", async () => {
    const res = await post(
      "/api/profile/update",
      { displayName: "مخترق" },
      { Origin: "https://meme.avicenna.space", "Sec-Fetch-Site": "same-site" },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: "origin_rejected" })

    const still = users.raw.prepare("SELECT display_name AS n FROM users WHERE username = 'victim'").get() as {
      n: string
    }
    expect(still.n).toBe("ضحية")
  })

  it("refuses a forged logout, which takes no body at all", async () => {
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { Host: HOST, Cookie: `qarid_sess=${token}`, Origin: "https://meme.avicenna.space" },
    })
    expect(res.status).toBe(403)
    // the session is untouched
    expect((await app.request("/api/auth/me", { headers: { Cookie: `qarid_sess=${token}` } })).status).toBe(200)
  })

  it("refuses a same-site WebSocket upgrade before it can carry the cookie", async () => {
    const res = await app.request("/ws/room/BADIRU", {
      headers: { Host: HOST, Cookie: `qarid_sess=${token}`, "Sec-Fetch-Site": "same-site" },
    })
    expect(res.status).toBe(403)
  })

  it("still takes the site's own POST", async () => {
    const res = await post(
      "/api/profile/update",
      { displayName: "ضحية سعيدة" },
      { Origin: PUBLIC_ORIGIN, "Sec-Fetch-Site": "same-origin" },
    )
    expect(res.status).toBe(200)
  })
})

describe("the body parser's content type", () => {
  it("refuses `text/plain`, the shape that needs no preflight", async () => {
    // The exploit did not need CORS at all: a simple request or an
    // `<form enctype="text/plain">` carrying JSON reached the handler.
    const res = await app.request("/api/profile/update", {
      method: "POST",
      headers: {
        Host: HOST,
        Cookie: `qarid_sess=${token}`,
        "content-type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify({ displayName: "مخترق" }),
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ error: "unsupported_media_type" })
  })

  it("refuses a form encoding too, and accepts a charset on the JSON type", async () => {
    const form = await app.request("/api/profile/update", {
      method: "POST",
      headers: { Host: HOST, Cookie: `qarid_sess=${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: "displayName=x",
    })
    expect(form.status).toBe(415)

    const ok = await app.request("/api/profile/update", {
      method: "POST",
      headers: { Host: HOST, Cookie: `qarid_sess=${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ displayName: "لبيد" }),
    })
    expect(ok.status).toBe(200)
  })
})

describe("GET /api/profile/:username", () => {
  it("does not publish room codes to a reader who is not the account", async () => {
    const now = Date.now()
    const alice = createUser(users, { username: "alicepoet", displayName: "أليس", passHash: "scrypt$x", now })!
    users.raw
      .prepare(
        `INSERT INTO rooms (code, host_user_id, guest_user_id, starting_bait_id, mode, timer_s, strikes, status,
                            created_at, updated_at, join_key)
         VALUES ('BADIRU', ?, NULL, 1, 'rhyme', 30, 3, 'waiting', ?, ?, 'abcdefghijkmnpqrstuvwxyz')`,
      )
      .run(alice.id, now, now)

    // No cookie at all — this route is reached before `currentUser`.
    const anon = await app.request("/api/profile/alicepoet", { headers: { Host: HOST } })
    expect(anon.status).toBe(200)
    const seen = ProfileResponseSchema.parse(await anon.json())
    expect(seen.recent).toHaveLength(1)
    // The RECORD is public — status, opponent, when — and the way in is not.
    expect(seen.recent[0]!.status).toBe("waiting")
    expect(seen.recent[0]!.code).toBeNull()

    // A signed-in stranger gets exactly the same page.
    const stranger = await app.request("/api/profile/alicepoet", {
      headers: { Host: HOST, Cookie: `qarid_sess=${token}` },
    })
    expect(ProfileResponseSchema.parse(await stranger.json()).recent[0]!.code).toBeNull()
  })

  it("gives the account its OWN codes back — the profile is the way into your rooms", async () => {
    const aliceToken = newSessionToken()
    const alice = users.raw.prepare("SELECT id FROM users WHERE username = 'alicepoet'").get() as { id: number }
    createSession(users, { userId: alice.id, tokenHash: hashToken(aliceToken), now: Date.now() })

    const mine = await app.request("/api/profile/alicepoet", {
      headers: { Host: HOST, Cookie: `qarid_sess=${aliceToken}` },
    })
    const body = ProfileResponseSchema.parse(await mine.json())
    expect(body.isSelf).toBe(true)
    expect(body.recent[0]!.code).toBe("BADIRU")
  })
})
