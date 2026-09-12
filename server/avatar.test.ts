/**
 * Custom profile pictures (owner's request).
 *
 * The security surface, exercised through the REAL app over a REAL users
 * database (gitignored, never /tmp): owner-only writes, magic-byte validation
 * (an SVG or HTML page renamed `.png` is 415), the size cap off the stream, a
 * serve route whose content-type is LOCKED and never sniffable, the etag
 * cache-bust, and the DTO carrying presence + URL and never the bytes.
 *
 * Auth is by bearer token throughout: a bearer request carries no `Origin`, so
 * it clears the CSRF guard the way `curl` and the native client do — the guard
 * itself is proven separately (a cross-site POST is refused even with valid
 * bytes).
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { Hono } from "hono"

import { AuthMeResponseSchema, ProfileResponseSchema } from "../shared/schema.ts"
import { REPO_ROOT } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig, type Config } from "./config.ts"
import { detectImageMime, openUsersDb, type UsersDb } from "./users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DBS: string[] = []

function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `avatar-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
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

function bearer(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } }
}

/** Register (asking for a bearer) and return the token. */
async function registerToken(app: Hono, username: string): Promise<string> {
  const res = await app.request("/api/auth/register", json({ username, password: "a good password", bearer: true }))
  expect(res.status).toBe(201)
  return (await res.json()).token as string
}

/** POST raw bytes to the avatar route as `username`'s owner. */
async function upload(app: Hono, token: string, bytes: Buffer, type: string): Promise<Response> {
  return app.request(
    "/api/profile/avatar",
    bearer(token, { method: "POST", headers: { "Content-Type": type }, body: new Uint8Array(bytes) }),
  )
}

// ── image fixtures. The server validates the SIGNATURE and stores the bytes; it
// never decodes, so a real signature followed by arbitrary tail round-trips. ──
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
function pngBytes(tail = "one"): Buffer {
  return Buffer.concat([PNG_SIG, Buffer.from(tail)])
}
function jpegBytes(tail = "one"): Buffer {
  return Buffer.concat([JPEG_SIG, Buffer.from(tail)])
}
function webpBytes(tail = "one"): Buffer {
  const body = Buffer.from("WEBPVP8 " + tail)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(body.length, 0)
  return Buffer.concat([Buffer.from("RIFF"), size, body])
}

afterAll(removeTempDbs)

// ─────────────────────────────────────────────────────────────────────────────
// magic bytes — the unit that decides the truth
// ─────────────────────────────────────────────────────────────────────────────

describe("detectImageMime", () => {
  it("accepts only the three raster signatures", () => {
    expect(detectImageMime(pngBytes())).toBe("image/png")
    expect(detectImageMime(jpegBytes())).toBe("image/jpeg")
    expect(detectImageMime(webpBytes())).toBe("image/webp")
  })

  it("rejects SVG, HTML and a truncated header", () => {
    expect(detectImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull()
    expect(detectImageMime(Buffer.from("<!DOCTYPE html><html></html>"))).toBeNull()
    expect(detectImageMime(Buffer.from([0x89, 0x50]))).toBeNull()
    // A RIFF that is not WEBP (a WAV renamed) fails the fourCC check.
    expect(detectImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]))).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// the routes
// ─────────────────────────────────────────────────────────────────────────────

describe("avatar upload, serve and delete", () => {
  let db: UsersDb
  let app: Hono
  let token: string

  beforeAll(async () => {
    db = openUsersDb(tempUsersPath("routes"))
    app = createApp(configFor(), null, db).app
    token = await registerToken(app, "lubna")
  })
  afterAll(() => db.close())

  it("has the user_avatars table at schema 5", () => {
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    )
    expect(tables).toContain("user_avatars")
  })

  it("404s the serve route and reports null presence before any upload", async () => {
    const img = await app.request("/api/profile/lubna/avatar")
    expect(img.status).toBe(404)
    const page = ProfileResponseSchema.parse(await (await app.request("/api/profile/lubna")).json())
    expect(page.user.avatar).toBeNull()
  })

  it("stores a PNG for the owner and serves it back with a LOCKED content-type", async () => {
    const set = await upload(app, token, pngBytes("first"), "image/png")
    expect(set.status).toBe(200)
    const body = await set.json()
    expect(body.ok).toBe(true)
    expect(String(body.avatar)).toMatch(/^\/api\/profile\/lubna\/avatar\?v=/)

    const img = await app.request(String(body.avatar))
    expect(img.status).toBe(200)
    expect(img.headers.get("content-type")).toBe("image/png")
    expect(img.headers.get("x-content-type-options")).toBe("nosniff")
    expect(img.headers.get("content-disposition")).toBe("inline")
    expect(img.headers.get("etag")).toBeTruthy()
    // never text/html, never a sniff — the bytes come back byte-for-byte
    expect(img.headers.get("content-type")).not.toContain("text/html")
    expect(Buffer.from(await img.arrayBuffer())).toEqual(pngBytes("first"))
  })

  it("carries presence + the versioned URL on both the profile and /auth/me DTOs", async () => {
    const page = ProfileResponseSchema.parse(await (await app.request("/api/profile/lubna")).json())
    expect(page.user.avatar).toMatch(/^\/api\/profile\/lubna\/avatar\?v=/)

    const me = AuthMeResponseSchema.parse(await (await app.request("/api/auth/me", bearer(token))).json())
    expect(me.user?.avatar).toMatch(/^\/api\/profile\/lubna\/avatar\?v=/)
    // the bytes are NEVER in the JSON
    expect(JSON.stringify(page)).not.toContain(PNG_SIG.toString("latin1"))
  })

  it("busts the etag when the picture changes, and 304s a matching If-None-Match", async () => {
    const first = ProfileResponseSchema.parse(await (await app.request("/api/profile/lubna")).json()).user.avatar!
    await upload(app, token, jpegBytes("second"), "image/jpeg")
    const second = ProfileResponseSchema.parse(await (await app.request("/api/profile/lubna")).json()).user.avatar!
    expect(second).not.toBe(first)

    const img = await app.request(second)
    expect(img.headers.get("content-type")).toBe("image/jpeg")
    const etag = img.headers.get("etag")!
    const again = await app.request(second, { headers: { "If-None-Match": etag } })
    expect(again.status).toBe(304)
  })

  it("removes the avatar for the owner, back to the نِيب fallback (404 + null)", async () => {
    const del = await app.request("/api/profile/avatar", bearer(token, { method: "DELETE" }))
    expect(del.status).toBe(200)
    expect((await del.json()).avatar).toBeNull()
    expect((await app.request("/api/profile/lubna/avatar")).status).toBe(404)
    const page = ProfileResponseSchema.parse(await (await app.request("/api/profile/lubna")).json())
    expect(page.user.avatar).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// validation and abuse
// ─────────────────────────────────────────────────────────────────────────────

describe("avatar validation", () => {
  let db: UsersDb
  let app: Hono
  let token: string

  beforeAll(async () => {
    db = openUsersDb(tempUsersPath("validate"))
    app = createApp(configFor(), null, db).app
    token = await registerToken(app, "maysun")
  })
  afterAll(() => db.close())

  it("415s an SVG payload declared image/png, and stores NOTHING", async () => {
    const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')
    const res = await upload(app, token, evil, "image/png")
    expect(res.status).toBe(415)
    expect((await app.request("/api/profile/maysun/avatar")).status).toBe(404)
  })

  it("415s an HTML page renamed .png", async () => {
    const res = await upload(app, token, Buffer.from("<!DOCTYPE html><script>alert(1)</script>"), "image/png")
    expect(res.status).toBe(415)
  })

  it("415s a disallowed declared content-type before reading the body", async () => {
    const res = await upload(app, token, pngBytes(), "text/plain")
    expect(res.status).toBe(415)
  })

  it("413s a body over the 256 KB cap", async () => {
    const big = Buffer.concat([PNG_SIG, randomBytes(300 * 1024)])
    const res = await upload(app, token, big, "image/png")
    expect(res.status).toBe(413)
    expect((await app.request("/api/profile/maysun/avatar")).status).toBe(404)
  })

  it("400s an empty body", async () => {
    const res = await upload(app, token, Buffer.alloc(0), "image/png")
    expect(res.status).toBe(400)
  })

  it("413s a CHUNKED oversized body — the cap is off the stream, not Content-Length", async () => {
    // A ReadableStream body carries no Content-Length, so undici sends it
    // chunked. The 300 KB it streams must be rejected by BYTE COUNT.
    const chunk = new Uint8Array(64 * 1024)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 300 * 1024) return controller.close()
        controller.enqueue(chunk)
        sent += chunk.byteLength
      },
    })
    const res = await app.request(
      "/api/profile/avatar",
      // @ts-expect-error duplex is required for a streaming body but absent from the DOM types
      bearer(token, { method: "POST", headers: { "Content-Type": "image/png" }, body: stream, duplex: "half" }),
    )
    expect(res.status).toBe(413)
  })

  it("accepts a WEBP just under the cap", async () => {
    const ok = Buffer.concat([webpBytes(), randomBytes(200 * 1024)])
    const res = await upload(app, token, ok, "image/webp")
    expect(res.status).toBe(200)
    expect((await app.request("/api/profile/maysun/avatar")).headers.get("content-type")).toBe("image/webp")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// authorization — a user only ever writes their OWN row
// ─────────────────────────────────────────────────────────────────────────────

describe("avatar authorization", () => {
  let db: UsersDb
  let app: Hono
  let a: string
  let b: string

  beforeAll(async () => {
    db = openUsersDb(tempUsersPath("authz"))
    app = createApp(configFor(), null, db).app
    a = await registerToken(app, "aisha")
    b = await registerToken(app, "bakr")
  })
  afterAll(() => db.close())

  it("401s an unauthenticated upload and delete", async () => {
    expect((await upload(app, "", pngBytes(), "image/png")).status).toBe(401)
    expect((await app.request("/api/profile/avatar", { method: "DELETE" })).status).toBe(401)
  })

  it("scopes a write to the caller — B cannot touch A's picture", async () => {
    await upload(app, a, pngBytes("aisha"), "image/png")
    const aUrl = ProfileResponseSchema.parse(await (await app.request("/api/profile/aisha")).json()).user.avatar
    expect(aUrl).toBeTruthy()

    // B has no username param to aim at A; B's own DELETE removes only B's (none)
    // and B's own upload writes only B's row. A's picture is untouched by either.
    await app.request("/api/profile/avatar", bearer(b, { method: "DELETE" }))
    await upload(app, b, jpegBytes("bakr"), "image/jpeg")

    const aStill = ProfileResponseSchema.parse(await (await app.request("/api/profile/aisha")).json()).user.avatar
    expect(aStill).toBe(aUrl)
    expect((await app.request("/api/profile/aisha/avatar")).headers.get("content-type")).toBe("image/png")
    expect((await app.request("/api/profile/bakr/avatar")).headers.get("content-type")).toBe("image/jpeg")
  })

  it("refuses a cross-site POST even with valid bytes (the CSRF guard holds)", async () => {
    const res = await app.request(
      "/api/profile/avatar",
      bearer(a, {
        method: "POST",
        headers: { "Content-Type": "image/png", Origin: "https://meme.example.com", "Sec-Fetch-Site": "cross-site" },
        body: new Uint8Array(pngBytes("evil")),
      }),
    )
    expect(res.status).toBe(403)
  })
})
