/**
 * الدواوين end to end — the real routes, the real writable database, the real
 * fixture artefact built by `scripts/ingest/build.ts`.
 *
 * Nothing here is mocked, and the entries are not hard-coded: every test reads
 * a بيت or a قصيدة out of the fixture, sends what the client would (the بيت's
 * anchor, computed with the SAME `baitAnchor`; the قصيدة's public id), and
 * reads back what the server anchored and snapshotted — which is exactly the
 * contract. A re-ingest that renumbers `baits.id` and `poems.id` therefore
 * breaks none of it, which is the property the whole feature exists to have.
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import type { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { baitAnchor, poemAnchor } from "../../shared/arabic.ts"
import {
  ALBUM_LIMITS,
  AlbumAddEntriesResponseSchema,
  AlbumResponseSchema,
  AlbumsResponseSchema,
  AlbumMutationResponseSchema,
} from "../../shared/schema.ts"
import { FIXTURE_DB, REPO_ROOT, ensureFixtureDb } from "../../test/fixtureDb.ts"
import { createApp } from "../app.ts"
import { loadConfig, type Config } from "../config.ts"
import { openDb, type Db } from "../db.ts"
import {
  SESSION_COOKIE,
  createAlbum,
  createSession,
  createUser,
  findUserByUsername,
  saveAlbum,
  hashToken,
  listAlbums,
  migrate,
  newAlbumCode,
  newSessionToken,
  openUsersDb,
  USERS_SCHEMA_VERSION,
  type UsersDb,
} from "../users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DBS: string[] = []

function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `albums-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
  TEMP_DBS.push(p)
  return p
}

let db: Db
let users: UsersDb
let app: Hono
let config: Config

type Reader = { username: string; token: string; ip: string }

let seq = 0
function reader(name: string): Reader {
  const username = `${name}${++seq}`
  const now = Date.now()
  const row = createUser(users, { username, displayName: name, passHash: "scrypt$not-a-login", now })
  if (!row) throw new Error(`could not create ${username}`)
  const token = newSessionToken()
  createSession(users, { userId: row.id, tokenHash: hashToken(token), now })
  // One address per reader: every write here is on a per-IP token bucket, and a
  // suite that all looks like one anonymous client would 429 itself.
  return { username, token, ip: `10.${(seq >> 8) & 255}.${seq & 255}.9` }
}

async function req(pathname: string, init: RequestInit = {}, who?: Reader): Promise<Response> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) }
  if (who) {
    headers.Cookie = `${SESSION_COOKIE}=${who.token}`
    headers["CF-Connecting-IP"] = who.ip
  }
  return app.request(pathname, { ...init, headers })
}

function body(method: string, payload: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
}

/** أبيات from the fixture that carry a عجز — the only ones an anchor can name. */
function fixtureBaits(limit: number): Array<{ sadr: string; ajuz: string; poet: string; poemId: number }> {
  return db
    .q(
      `SELECT b.sadr AS sadr, b.ajuz AS ajuz, po.name AS poet, p.id AS poem
       FROM baits b JOIN poems p ON p.id = b.poem_id JOIN poets po ON po.id = p.poet_id
       WHERE b.ajuz IS NOT NULL ORDER BY b.id LIMIT ?`,
    )
    .all(limit)
    .map((r) => {
      const row = r as Record<string, unknown>
      return {
        sadr: String(row.sadr),
        ajuz: String(row.ajuz),
        poet: String(row.poet),
        poemId: Number(row.poem),
      }
    })
}

function anchorsOf(rows: ReturnType<typeof fixtureBaits>): string[] {
  return rows.map((r) => {
    const a = baitAnchor(r.sadr, r.ajuz)
    if (!a) throw new Error("a fixture بيت with a عجز must have an anchor")
    return a
  })
}

/** The add body for a list of بيت anchors. */
function baitItems(anchors: readonly string[]): Array<{ kind: "bait"; hFull: string }> {
  return anchors.map((hFull) => ({ kind: "bait", hFull }))
}

type FixturePoem = { publicId: string; dedupKey: string; title: string; poet: string; baitCount: number }

/** قصائد from the fixture, longest first — the playlist's unit. */
function fixturePoems(limit: number): FixturePoem[] {
  return (
    db
      .q(
        `SELECT p.public_id AS pid, p.dedup_key AS key, p.title AS title, po.name AS poet, p.bait_count AS n
         FROM poems p JOIN poets po ON po.id = p.poet_id ORDER BY p.bait_count DESC, p.id ASC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>
  ).map((r) => ({
    publicId: String(r.pid),
    dedupKey: String(r.key),
    title: String(r.title),
    poet: String(r.poet),
    baitCount: Number(r.n),
  }))
}

async function makeAlbum(who: Reader, fields: Record<string, unknown> = {}): Promise<string> {
  const res = await req("/api/albums", body("POST", { title: "ديوانٌ لي", ...fields }), who)
  expect(res.status).toBe(201)
  const parsed = AlbumMutationResponseSchema.parse(await res.json())
  return parsed.album.code
}

beforeAll(async () => {
  await ensureFixtureDb()
  db = openDb(FIXTURE_DB)
  users = openUsersDb(tempUsersPath("main"))
  config = loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test" } as NodeJS.ProcessEnv)
  app = createApp(config, db, users).app
})

afterAll(() => {
  db.close()
  users.close()
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

// ─────────────────────────────────────────────────────────────────────────────
// The code
// ─────────────────────────────────────────────────────────────────────────────

describe("the album code", () => {
  it("is ten letters of five speakable pairs, and never a digit", () => {
    for (let i = 0; i < 200; i++) {
      const code = newAlbumCode()
      expect(code).toMatch(/^([BDFHJKLMNRSTWZ][AEIOU]){5}$/)
    }
  })

  it("is WIDER than a room code, because here the code IS the credential", () => {
    // A room has `join_key` behind its six letters; an unlisted ديوان has
    // nothing but the link it was shared in.
    expect(newAlbumCode().length).toBe(10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Creation, listing, caps
// ─────────────────────────────────────────────────────────────────────────────

describe("creating a ديوان", () => {
  it("refuses a signed-out reader", async () => {
    const res = await req("/api/albums", body("POST", { title: "ديوان" }))
    expect(res.status).toBe(401)
  })

  it("defaults to private, and lists only under its own owner", async () => {
    const a = reader("labid")
    const b = reader("nabigha")
    const code = await makeAlbum(a, { title: "ما اخترته", description: "أبياتٌ أعود إليها" })

    const mine = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, a)).json())
    expect(mine.albums).toHaveLength(1)
    expect(mine.albums[0]!.visibility).toBe("private")
    expect(mine.albums[0]!.title).toBe("ما اخترته")
    expect(mine.albums[0]!.description).toBe("أبياتٌ أعود إليها")
    expect(mine.albums[0]!.isOwner).toBe(true)
    expect(mine.albums[0]!.count).toBe(0)

    const theirs = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, b)).json())
    expect(theirs.albums).toHaveLength(0)
    expect(code).toMatch(/^[A-Z]{10}$/)
  })

  it("refuses a title that is blank, or longer than sixty characters", async () => {
    const a = reader("kuthayyir")
    expect((await req("/api/albums", body("POST", { title: "   " }), a)).status).toBe(400)
    expect((await req("/api/albums", body("POST", { title: "ب".repeat(61) }), a)).status).toBe(400)
    expect((await req("/api/albums", body("POST", { title: "ب".repeat(60) }), a)).status).toBe(201)
  })

  it("caps a reader at ALBUM_LIMITS.perUser دواوين", async () => {
    const a = reader("farazdaq")
    for (let i = 0; i < ALBUM_LIMITS.perUser; i++) {
      const res = await req("/api/albums", body("POST", { title: `ديوان ${i}` }), a)
      expect(res.status).toBe(201)
    }
    const over = await req("/api/albums", body("POST", { title: "واحدٌ زائد" }), a)
    expect(over.status).toBe(409)
    expect((await over.json()).error).toBe("too_many_albums")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The entries — a قصيدة is ONE, and everything is anchored by content
// ─────────────────────────────────────────────────────────────────────────────

describe("a قصيدة is one entry", () => {
  it("adds a قصيدة by its public id, anchors it by its dedup key, and snapshots it whole", async () => {
    const a = reader("imru")
    const code = await makeAlbum(a)
    const [poem] = fixturePoems(1)
    const res = await req(`/api/albums/${code}/entries`, body("POST", { items: [{ kind: "poem", id: poem!.publicId }] }), a)
    expect(res.status).toBe(200)
    const added = AlbumAddEntriesResponseSchema.parse(await res.json())
    expect(added.added).toBe(1)
    expect(added.album.count).toBe(1)
    expect(added.album.poems).toBe(1)
    expect(added.album.baits).toBe(0)

    const shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.entries).toHaveLength(1)
    const entry = shelf.entries[0]!
    expect(entry.kind).toBe("poem")
    if (entry.kind !== "poem") return
    // The anchor is the dedup key's hash, never the id the client sent.
    expect(entry.anchor).toBe(poemAnchor(poem!.dedupKey))
    expect(entry.anchor).not.toContain(poem!.publicId)
    expect(entry.poem?.id).toBe(poem!.publicId)
    expect(entry.poem?.baitCount).toBe(poem!.baitCount)
    // The SERVER wrote the snapshot, and it is the whole قصيدة's card.
    expect(entry.snapshot.title).toBe(poem!.title)
    expect(entry.snapshot.poet).toBe(poem!.poet)
    expect(entry.snapshot.baitCount).toBe(poem!.baitCount)
    expect(entry.snapshot.sadr.length).toBeGreaterThan(0)
  })

  it("keeps a قصيدة and single أبيات on ONE ordered list", async () => {
    const a = reader("tarafa")
    const code = await makeAlbum(a)
    const [p1, p2] = fixturePoems(2)
    const anchors = anchorsOf(fixtureBaits(2))
    const res = await req(
      `/api/albums/${code}/entries`,
      body("POST", {
        items: [
          { kind: "bait", hFull: anchors[0] },
          { kind: "poem", id: p1!.publicId },
          { kind: "bait", hFull: anchors[1] },
          { kind: "poem", id: p2!.publicId },
        ],
      }),
      a,
    )
    expect(res.status).toBe(200)
    const shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.entries.map((e) => e.kind)).toEqual(["bait", "poem", "bait", "poem"])
    expect(shelf.entries.map((e) => e.position)).toEqual([0, 1, 2, 3])
    expect(shelf.album.count).toBe(4)
    expect(shelf.album.poems).toBe(2)
    expect(shelf.album.baits).toBe(2)
  })

  it("counts a re-added قصيدة as a duplicate — however it was named", async () => {
    const a = reader("zuhayr")
    const code = await makeAlbum(a)
    const [poem] = fixturePoems(1)
    await req(`/api/albums/${code}/entries`, body("POST", { items: [{ kind: "poem", id: poem!.publicId }] }), a)
    // Sent twice in one request AND once already on the shelf: one entry.
    const res = await req(
      `/api/albums/${code}/entries`,
      body("POST", { items: [{ kind: "poem", id: poem!.publicId }, { kind: "poem", id: poem!.publicId }] }),
      a,
    )
    const again = AlbumAddEntriesResponseSchema.parse(await res.json())
    expect(again.added).toBe(0)
    expect(again.duplicates).toBe(1)
    expect(again.album.count).toBe(1)
  })

  it("keeps rendering a قصيدة the artefact can no longer answer — the snapshot is the floor", async () => {
    const a = reader("amr")
    const code = await makeAlbum(a)
    const [poem] = fixturePoems(1)
    await req(`/api/albums/${code}/entries`, body("POST", { items: [{ kind: "poem", id: poem!.publicId }] }), a)

    // Simulate the rebuild that drops the قصيدة: point the stored key at one
    // no row carries. Everything else is untouched, which is exactly the state
    // a re-ingest leaves behind.
    users.q("UPDATE album_entries SET poem_key = ? WHERE poem_key = ?").run("nobody|nothing", poem!.dedupKey)
    users.q("UPDATE albums SET updated_at = updated_at + 1 WHERE code = ?").run(code)

    const shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    const entry = shelf.entries[0]!
    expect(entry.kind).toBe("poem")
    if (entry.kind !== "poem") return
    expect(entry.poem).toBeNull()
    expect(entry.snapshot.title).toBe(poem!.title)
    expect(entry.snapshot.poet).toBe(poem!.poet)
    expect(entry.snapshot.baitCount).toBe(poem!.baitCount)
  })

  it("refuses an id the artefact cannot answer rather than storing it on trust", async () => {
    const a = reader("harith")
    const code = await makeAlbum(a)
    const res = await req(`/api/albums/${code}/entries`, body("POST", { items: [{ kind: "poem", id: "q999999" }] }), a)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("unknown_entry")
  })
})

describe("أبيات are anchored by content, not by id", () => {
  it("resolves an h_full into the live بيت and writes the snapshot itself", async () => {
    const a = reader("jarir")
    const code = await makeAlbum(a)
    const rows = fixtureBaits(3)
    const res = await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems(anchorsOf(rows)) }), a)
    expect(res.status).toBe(200)
    const added = AlbumAddEntriesResponseSchema.parse(await res.json())
    expect(added.added).toBe(3)
    expect(added.unresolved).toBe(0)
    expect(added.album.count).toBe(3)
    expect(added.album.baits).toBe(3)

    const shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.entries).toHaveLength(3)
    for (const [i, entry] of shelf.entries.entries()) {
      expect(entry.position).toBe(i)
      expect(entry.kind).toBe("bait")
      if (entry.kind !== "bait") continue
      // The live row came back, and the snapshot the SERVER wrote agrees with it.
      expect(entry.bait).not.toBeNull()
      expect(entry.snapshot.sadr).toBe(rows[i]!.sadr)
      expect(entry.snapshot.poet).toBe(rows[i]!.poet)
      expect(entry.bait!.sadr).toBe(rows[i]!.sadr)
    }
  })

  it("keeps rendering a بيت the artefact can no longer answer — the snapshot is the floor", async () => {
    const a = reader("umar")
    const code = await makeAlbum(a)
    const [row] = fixtureBaits(1)
    const anchor = baitAnchor(row!.sadr, row!.ajuz)!
    await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems([anchor]) }), a)

    // Simulate the rebuild that drops the قصيدة: rewrite the stored anchor to
    // one no بيت carries. The row is untouched otherwise, which is exactly the
    // state a re-ingest leaves behind.
    users.q("UPDATE album_entries SET anchor = ? WHERE anchor = ?").run("123456789", anchor)
    users.q("UPDATE albums SET updated_at = updated_at + 1 WHERE code = ?").run(code)

    const shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.entries).toHaveLength(1)
    const entry = shelf.entries[0]!
    expect(entry.kind).toBe("bait")
    if (entry.kind !== "bait") return
    expect(entry.bait).toBeNull()
    expect(entry.snapshot.sadr).toBe(row!.sadr)
    expect(entry.snapshot.poet).toBe(row!.poet)
  })

  it("refuses an anchor the artefact cannot answer rather than storing it on trust", async () => {
    const a = reader("dhurumma")
    const code = await makeAlbum(a)
    const res = await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems(["-987654321"]) }), a)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("unknown_entry")
  })

  it("counts a re-added بيت as a duplicate, not as an error", async () => {
    const a = reader("mutanabi")
    const code = await makeAlbum(a)
    const anchors = anchorsOf(fixtureBaits(4))
    await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems(anchors.slice(0, 2)) }), a)
    const res = await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems(anchors) }), a)
    const again = AlbumAddEntriesResponseSchema.parse(await res.json())
    expect(again.added).toBe(2)
    expect(again.duplicates).toBe(2)
    expect(again.album.count).toBe(4)
  })

  it("rejects a bulk add over ALBUM_LIMITS.bulk before it reads the corpus", async () => {
    const a = reader("bashshar")
    const code = await makeAlbum(a)
    const items = baitItems(Array.from({ length: ALBUM_LIMITS.bulk + 1 }, (_, i) => String(i + 1)))
    const res = await req(`/api/albums/${code}/entries`, body("POST", { items }), a)
    expect(res.status).toBe(400)
  })

  it("truncates at ALBUM_LIMITS.entries instead of losing the shelf that was already there", async () => {
    const a = reader("ibnrumi")
    const code = await makeAlbum(a)
    const rows = fixtureBaits(ALBUM_LIMITS.entries + 40)
    // Only run the cap test when the fixture is big enough to reach it.
    if (rows.length <= ALBUM_LIMITS.entries) return
    const anchors = [...new Set(anchorsOf(rows))]
    for (let i = 0; i < anchors.length; i += ALBUM_LIMITS.bulk) {
      const slice = anchors.slice(i, i + ALBUM_LIMITS.bulk)
      const res = await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems(slice) }), a)
      if (res.status === 409) {
        expect((await res.json()).error).toBe("album_full")
        break
      }
      expect(res.status).toBe(200)
    }
    const shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.entries.length).toBeLessThanOrEqual(ALBUM_LIMITS.entries)
    expect(shelf.album.count).toBeLessThanOrEqual(ALBUM_LIMITS.entries)
  })

  it("removes one entry by its anchor — either kind — and closes the gap in the order", async () => {
    const a = reader("abunuwas")
    const code = await makeAlbum(a)
    const anchors = anchorsOf(fixtureBaits(2))
    const [poem] = fixturePoems(1)
    await req(
      `/api/albums/${code}/entries`,
      body("POST", {
        items: [
          { kind: "bait", hFull: anchors[0] },
          { kind: "poem", id: poem!.publicId },
          { kind: "bait", hFull: anchors[1] },
        ],
      }),
      a,
    )
    const pAnchor = poemAnchor(poem!.dedupKey)
    const drop = (anchor: string) => req(`/api/albums/${code}/entries/${encodeURIComponent(anchor)}`, { method: "DELETE" }, a)
    expect((await drop(anchors[0]!)).status).toBe(200)
    let shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.entries.map((e) => e.anchor)).toEqual([pAnchor, anchors[1]])
    expect(shelf.entries.map((e) => e.position)).toEqual([0, 1])

    expect((await drop(pAnchor)).status).toBe(200)
    shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.entries.map((e) => e.anchor)).toEqual([anchors[1]])
    expect(shelf.album.poems).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Migration 11 — the shelves that already existed
// ─────────────────────────────────────────────────────────────────────────────

describe("migration 10 → 11", () => {
  it("carries every `album_baits` row over as a بيت entry, in place and in order", () => {
    const p = tempUsersPath("migrate")
    const raw = new DatabaseSync(p)
    raw.exec("PRAGMA foreign_keys = ON")
    expect(migrate(raw, 10)).toBe(10)

    // A shelf the way the OLD build wrote it — straight into the old table.
    raw
      .prepare("INSERT INTO users (username, display_name, pass_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)")
      .run("kaab", "كعب", "scrypt$not-a-login", 1, 1)
    raw
      .prepare(
        "INSERT INTO albums (code, owner_user_id, title, visibility, created_at, updated_at) VALUES (?, 1, ?, 'unlisted', 1, 1)",
      )
      .run("BADIRUKAMO", "بانت سعاد")
    const ins = raw.prepare(
      "INSERT INTO album_baits (album_id, h_full, position, snapshot_sadr, snapshot_ajuz, snapshot_poet, added_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
    )
    ins.run("111", 5, "صدرٌ أوّل", "عجزٌ أوّل", "كعب بن زهير", 10)
    ins.run("222", 9, "صدرٌ ثانٍ", null, "كعب بن زهير", 11)

    expect(migrate(raw)).toBe(USERS_SCHEMA_VERSION)
    raw.close()

    // …and the new build reads it as the same shelf.
    const moved = openUsersDb(p)
    const owner = findUserByUsername(moved, "kaab")!
    const [album] = listAlbums(moved, owner.id)
    expect(album?.count).toBe(2)
    expect(album?.baits).toBe(2)
    expect(album?.poems).toBe(0)
    const rows = moved
      .q(
        `SELECT kind, anchor, poem_key, position, snapshot_sadr, snapshot_ajuz, snapshot_poet, snapshot_title,
                snapshot_count, added_at
         FROM album_entries ORDER BY position`,
      )
      .all() as Array<Record<string, unknown>>
    expect(rows).toEqual([
      {
        kind: "bait",
        anchor: "111",
        poem_key: null,
        position: 5,
        snapshot_sadr: "صدرٌ أوّل",
        snapshot_ajuz: "عجزٌ أوّل",
        snapshot_poet: "كعب بن زهير",
        snapshot_title: null,
        snapshot_count: null,
        added_at: 10,
      },
      {
        kind: "bait",
        anchor: "222",
        poem_key: null,
        position: 9,
        snapshot_sadr: "صدرٌ ثانٍ",
        snapshot_ajuz: null,
        snapshot_poet: "كعب بن زهير",
        snapshot_title: null,
        snapshot_count: null,
        added_at: 11,
      },
    ])
    const gone = moved.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'album_baits'").get()
    expect(gone).toBeUndefined()
    moved.close()
  })

  it("makes the two row shapes exclusive — a قصيدة needs its key, a بيت may not carry one", () => {
    const fresh = openUsersDb(tempUsersPath("shapes"))
    fresh
      .q("INSERT INTO users (username, display_name, pass_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)")
      .run("x", "x", "x", 1, 1)
    fresh.q("INSERT INTO albums (code, owner_user_id, title, created_at, updated_at) VALUES ('BADIRUKAMO', 1, 'x', 1, 1)").run()
    let n = 0
    const ins = (kind: string, key: string | null, title: string | null, count: number | null) =>
      fresh
        .q(
          `INSERT INTO album_entries (album_id, kind, anchor, poem_key, position, snapshot_title, snapshot_sadr,
                                      snapshot_ajuz, snapshot_poet, snapshot_count, added_at)
           VALUES (1, ?, ?, ?, 0, ?, 'س', NULL, 'ش', ?, 1)`,
        )
        .run(kind, `a${++n}`, key, title, count)
    expect(() => ins("poem", null, "t", 3)).toThrow(/CHECK/)
    expect(() => ins("bait", "k", null, null)).toThrow(/CHECK/)
    expect(() => ins("poem", "k", null, 3)).toThrow(/CHECK/)
    expect(() => ins("verse", null, null, null)).toThrow(/CHECK/)
    expect(() => ins("poem", "k", "t", 3)).not.toThrow()
    expect(() => ins("bait", null, null, null)).not.toThrow()
    fresh.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Visibility
// ─────────────────────────────────────────────────────────────────────────────

describe("visibility", () => {
  it("hides a private ديوان from everyone but its owner — as a 404, not a 403", async () => {
    const a = reader("khansa")
    const b = reader("layla")
    const code = await makeAlbum(a, { visibility: "private" })

    expect((await req(`/api/albums/${code}`, {}, a)).status).toBe(200)
    // A 403 would confirm that a shelf exists behind a guessed code.
    expect((await req(`/api/albums/${code}`, {}, b)).status).toBe(404)
    expect((await req(`/api/albums/${code}`)).status).toBe(404)
  })

  it("opens an unlisted ديوان to whoever holds the EXACT code, signed in or not", async () => {
    const a = reader("antara")
    const b = reader("zuhayr")
    const code = await makeAlbum(a, { visibility: "unlisted" })

    const visitor = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, b)).json())
    expect(visitor.album.isOwner).toBe(false)
    expect(visitor.album.curator.username).toBe(a.username)
    expect((await req(`/api/albums/${code}`)).status).toBe(200)

    // …and to nobody who does not have it. One letter off is a different shelf.
    const wrong = code.slice(0, 9) + (code[9] === "A" ? "E" : "A")
    expect((await req(`/api/albums/${wrong}`, {}, b)).status).toBe(404)
  })

  it("never lists another reader's دواوين anywhere", async () => {
    const a = reader("imruq")
    const b = reader("tarafa")
    await makeAlbum(a, { visibility: "unlisted" })
    await makeAlbum(a, { visibility: "public" })
    const theirs = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, b)).json())
    expect(theirs.albums).toHaveLength(0)
  })

  it("refuses every WRITE from a reader who does not own the shelf", async () => {
    const a = reader("hutaya")
    const b = reader("akhtal")
    const code = await makeAlbum(a, { visibility: "public" })
    const anchor = anchorsOf(fixtureBaits(1))[0]!

    expect((await req(`/api/albums/${code}`, body("PATCH", { title: "لي أنا" }), b)).status).toBe(404)
    expect((await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems([anchor]) }), b)).status).toBe(404)
    expect((await req(`/api/albums/${code}/entries/${anchor}`, { method: "DELETE" }, b)).status).toBe(404)
    expect((await req(`/api/albums/${code}`, { method: "DELETE" }, b)).status).toBe(404)
    // …and it is still there, unchanged.
    const shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.album.title).toBe("ديوانٌ لي")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Editing
// ─────────────────────────────────────────────────────────────────────────────

describe("the owner's edits", () => {
  it("renames, describes and re-publishes in one PATCH", async () => {
    const a = reader("mutalammis")
    const code = await makeAlbum(a)
    const res = await req(
      `/api/albums/${code}`,
      body("PATCH", { title: "مختاراتي", description: "من كل بحر", visibility: "public" }),
      a,
    )
    expect(res.status).toBe(200)
    const album = AlbumMutationResponseSchema.parse(await res.json()).album
    expect(album.title).toBe("مختاراتي")
    expect(album.description).toBe("من كل بحر")
    expect(album.visibility).toBe("public")
  })

  it("clears a وصف with an empty string rather than needing a second door", async () => {
    const a = reader("shanfara")
    const code = await makeAlbum(a, { description: "وصفٌ قديم" })
    await req(`/api/albums/${code}`, body("PATCH", { description: "" }), a)
    const shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.album.description).toBeNull()
  })

  it("reorders by the WHOLE anchor list, and survives one that is short or repeated", async () => {
    const a = reader("qays")
    const code = await makeAlbum(a)
    const anchors = anchorsOf(fixtureBaits(4))
    await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems(anchors) }), a)

    // The last two named first, the first two left unnamed — and one repeat, the
    // shape a double-fired drag produces.
    await req(`/api/albums/${code}`, body("PATCH", { order: [anchors[3], anchors[2], anchors[3]] }), a)
    const shelf = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, a)).json())
    expect(shelf.entries.map((e) => e.anchor)).toEqual([anchors[3], anchors[2], anchors[0], anchors[1]])
    expect(shelf.entries.map((e) => e.position)).toEqual([0, 1, 2, 3])
  })

  it("deletes the shelf and its entries with it", async () => {
    const a = reader("waddah")
    const code = await makeAlbum(a)
    const anchors = anchorsOf(fixtureBaits(2))
    await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems(anchors) }), a)
    const { id } = users.q("SELECT id FROM albums WHERE code = ?").get(code) as { id: number }
    expect((await req(`/api/albums/${code}`, { method: "DELETE" }, a)).status).toBe(200)
    expect((await req(`/api/albums/${code}`, {}, a)).status).toBe(404)
    // The أبيات went with it — `ON DELETE CASCADE`, not a second DELETE anyone
    // has to remember to write.
    const left = users.q("SELECT COUNT(*) AS n FROM album_entries WHERE album_id = ?").get(id) as { n: number }
    expect(Number(left.n)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The wire
// ─────────────────────────────────────────────────────────────────────────────

describe("the wire", () => {
  it("never lets a ديوان be shared-cached", async () => {
    const a = reader("hassan")
    const code = await makeAlbum(a, { visibility: "public" })
    const res = await req(`/api/albums/${code}`, {}, a)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("answers a malformed code the same way it answers a wrong one", async () => {
    const a = reader("kaab")
    expect((await req("/api/albums/NOTACODE", {}, a)).status).toBe(404)
    expect((await req("/api/albums/BADIRU", {}, a)).status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// المكتبة — keeping somebody else's ديوان
// ─────────────────────────────────────────────────────────────────────────────

describe("المكتبة", () => {
  it("keeps another reader's shelf, lists it under «من مكتبتك», and lets it go", async () => {
    const curator = reader("jamil")
    const keeper = reader("busayna")
    const code = await makeAlbum(curator, { title: "ما أحفظه", visibility: "public" })

    const saved = await req(`/api/albums/${code}/save`, body("POST", {}), keeper)
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as { saved: boolean }).saved).toBe(true)

    const mine = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, keeper)).json())
    // The shelf is not among HIS — it is his مكتبة, a different section.
    expect(mine.albums.map((a) => a.code)).not.toContain(code)
    expect(mine.saved).toHaveLength(1)
    expect(mine.saved[0]!.code).toBe(code)
    expect(mine.saved[0]!.album?.title).toBe("ما أحفظه")
    expect(mine.saved[0]!.album?.curator.username).toBe(curator.username)
    expect(mine.saved[0]!.album?.saved).toBe(true)
    expect(mine.saved[0]!.gated).toBeNull()

    const dropped = await req(`/api/albums/${code}/save`, { method: "DELETE" }, keeper)
    expect(dropped.status).toBe(200)
    const after = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, keeper)).json())
    expect(after.saved).toEqual([])
  })

  it("is idempotent — a second «أضِف إلى مكتبتك» is not a second row", async () => {
    const curator = reader("qays")
    const keeper = reader("layla")
    const code = await makeAlbum(curator, { visibility: "unlisted" })
    expect((await req(`/api/albums/${code}/save`, body("POST", {}), keeper)).status).toBe(200)
    expect((await req(`/api/albums/${code}/save`, body("POST", {}), keeper)).status).toBe(200)
    const mine = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, keeper)).json())
    expect(mine.saved).toHaveLength(1)
  })

  it("refuses to save a shelf you cannot open — a private one, as a 404", async () => {
    const curator = reader("umar")
    const keeper = reader("nusayb")
    const code = await makeAlbum(curator)
    expect((await req(`/api/albums/${code}/save`, body("POST", {}), keeper)).status).toBe(404)
  })

  it("refuses your OWN shelf — it is in «دواويني» already", async () => {
    const a = reader("hutay")
    const code = await makeAlbum(a, { visibility: "public" })
    const res = await req(`/api/albums/${code}/save`, body("POST", {}), a)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("cannot_save_own")
  })

  it("says «صار خاصًّا» when the curator closes it — the row stays, the shelf does not", async () => {
    const curator = reader("kuthayir")
    const keeper = reader("azza")
    const rows = fixtureBaits(2)
    const code = await makeAlbum(curator, { title: "ديوانُ عزة", visibility: "public" })
    await req(`/api/albums/${code}/entries`, body("POST", { items: baitItems(anchorsOf(rows)) }), curator)
    await req(`/api/albums/${code}/save`, body("POST", {}), keeper)

    // The curator takes it back.
    expect((await req(`/api/albums/${code}`, body("PATCH", { visibility: "private" }), curator)).status).toBe(200)

    const mine = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, keeper)).json())
    expect(mine.saved).toHaveLength(1)
    expect(mine.saved[0]!.code).toBe(code)
    expect(mine.saved[0]!.gated).toBe("private")
    // Nothing of the retracted shelf crosses the gate — not the title, not the
    // count, not the curator's name.
    expect(mine.saved[0]!.album).toBeNull()
    expect(JSON.stringify(mine.saved[0])).not.toContain("ديوانُ عزة")
    // …and the shelf page itself is shut too.
    expect((await req(`/api/albums/${code}`, {}, keeper)).status).toBe(404)
    // The row is still removable, which is the whole reason it was kept.
    expect((await req(`/api/albums/${code}/save`, { method: "DELETE" }, keeper)).status).toBe(200)
    const after = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, keeper)).json())
    expect(after.saved).toEqual([])
  })

  it("hides a saved shelf whose curator the reader has blocked", async () => {
    const curator = reader("akhtal")
    const keeper = reader("jarir")
    const code = await makeAlbum(curator, { title: "نقائض", visibility: "public" })
    await req(`/api/albums/${code}/save`, body("POST", {}), keeper)

    expect((await req("/api/block", body("POST", { username: curator.username }), keeper)).status).toBe(200)

    const mine = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, keeper)).json())
    expect(mine.saved).toHaveLength(1)
    expect(mine.saved[0]!.gated).toBe("blocked")
    expect(mine.saved[0]!.album).toBeNull()
  })

  it("carries `saved` on the shelf's own page, for the button's two states", async () => {
    const curator = reader("farazdaq")
    const keeper = reader("nawar")
    const code = await makeAlbum(curator, { visibility: "public" })
    const before = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, keeper)).json())
    expect(before.album.saved).toBe(false)
    await req(`/api/albums/${code}/save`, body("POST", {}), keeper)
    const after = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {}, keeper)).json())
    expect(after.album.saved).toBe(true)
    // A signed-out reader has no مكتبة, so it is false rather than absent.
    const out = AlbumResponseSchema.parse(await (await req(`/api/albums/${code}`, {})).json())
    expect(out.album.saved).toBe(false)
  })

  it("caps a مكتبة at ALBUM_LIMITS.saved", async () => {
    const curator = reader("ibnzurayq")
    const keeper = reader("saqi")
    // The hundred rows are seeded through the same helpers the route calls: a
    // hundred HTTP saves would spend the keeper's own write bucket long before
    // they reached the cap, and the cap is what this test is about.
    const now = Date.now()
    const owner = findUserByUsername(users, curator.username)!
    for (let i = 0; i < ALBUM_LIMITS.saved; i++) {
      const album = createAlbum(
        users,
        { ownerUserId: owner.id, title: `ديوان ${i}`, description: null, visibility: "public" },
        now,
      )
      saveAlbum(users, findUserByUsername(users, keeper.username)!.id, album.id, now)
    }
    // The hundred-and-first comes from a second curator: the first is at his own
    // fifty-shelf cap by now (the seeding above went around the route).
    const other = reader("dhulrumma")
    const code = await makeAlbum(other, { visibility: "public" })
    const over = await req(`/api/albums/${code}/save`, body("POST", {}), keeper)
    expect(over.status).toBe(409)
    expect(((await over.json()) as { error: string }).error).toBe("too_many_saved")
    // A shelf ALREADY in a full مكتبة is still saveable — the cap counts rows,
    // and a re-save adds none.
    const held = AlbumsResponseSchema.parse(await (await req("/api/albums/mine", {}, keeper)).json())
    const first = held.saved[0]!.code
    expect((await req(`/api/albums/${first}/save`, body("POST", {}), keeper)).status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The shelf on a profile — the ONE listing of another account's دواوين
// ─────────────────────────────────────────────────────────────────────────────

describe("«دواوينه» on a profile", () => {
  it("shows the PUBLIC shelves and nothing else — unlisted is a link, not a page", async () => {
    const curator = reader("ibnzaydun")
    await makeAlbum(curator, { title: "إلى ولّادة", visibility: "public" })
    await makeAlbum(curator, { title: "بالرابط", visibility: "unlisted" })
    await makeAlbum(curator, { title: "لي وحدي" })

    const res = await req(`/api/profile/${curator.username}`, {})
    expect(res.status).toBe(200)
    const page = (await res.json()) as { albums: Array<{ title: string; visibility: string }> }
    expect(page.albums.map((a) => a.title)).toEqual(["إلى ولّادة"])
    expect(page.albums[0]!.visibility).toBe("public")
  })

  it("is a listing a signed-out reader sees too — published is published", async () => {
    const curator = reader("wallada")
    await makeAlbum(curator, { title: "ديوانٌ منشور", visibility: "public" })
    const page = (await req(`/api/profile/${curator.username}`, {}).then((r) => r.json())) as {
      albums: Array<{ title: string; saved: boolean }>
    }
    expect(page.albums.map((a) => a.title)).toEqual(["ديوانٌ منشور"])
    expect(page.albums[0]!.saved).toBe(false)
  })

  it("does not render a blocked curator's shelves for the blocker", async () => {
    const curator = reader("bashshar")
    const viewer = reader("khalaf")
    await makeAlbum(curator, { title: "مفتوح", visibility: "public" })

    const before = (await req(`/api/profile/${curator.username}`, {}, viewer).then((r) => r.json())) as {
      albums: unknown[]
    }
    expect(before.albums).toHaveLength(1)

    await req("/api/block", body("POST", { username: curator.username }), viewer)
    const after = (await req(`/api/profile/${curator.username}`, {}, viewer).then((r) => r.json())) as {
      albums: unknown[]
    }
    expect(after.albums).toEqual([])
    // …and it is only the BLOCKER's screen: everyone else still sees it.
    const other = (await req(`/api/profile/${curator.username}`, {}).then((r) => r.json())) as { albums: unknown[] }
    expect(other.albums).toHaveLength(1)
  })

  it("marks a shelf the viewer already keeps, so the button knows its state", async () => {
    const curator = reader("abunuwas")
    const keeper = reader("aminn")
    const code = await makeAlbum(curator, { title: "الخمريات", visibility: "public" })
    await req(`/api/albums/${code}/save`, body("POST", {}), keeper)
    const page = (await req(`/api/profile/${curator.username}`, {}, keeper).then((r) => r.json())) as {
      albums: Array<{ saved: boolean }>
    }
    expect(page.albums[0]!.saved).toBe(true)
  })
})
