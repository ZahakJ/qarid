/**
 * مساجلة في ديوان — the pool, the floor, the concede, and the room's own rule.
 *
 * Everything here runs against the REAL fixture artefact and a REAL writable
 * users database, through the real routes, because every claim being made is
 * about the join between the two: a shelf anchored by CONTENT in one database
 * and a game pool keyed by `bait_id` in the other. A mock of either side would
 * prove nothing at all.
 *
 * The أبيات are never hard-coded. Each test reads rows out of the fixture,
 * computes the anchor with the same `baitAnchor` the client uses, and asserts on
 * what comes back — so a re-ingest that renumbers `baits.id` breaks none of it.
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import type { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { baitAnchor } from "../../shared/arabic.ts"
import {
  ALBUM_LIMITS,
  AlbumMutationResponseSchema,
  AlbumPoolResponseSchema,
  GameReplyResponseSchema,
  GameStartResponseSchema,
  RoomStateResponseSchema,
  RoomTurnResponseSchema,
} from "../../shared/schema.ts"
import { FIXTURE_DB, REPO_ROOT, ensureFixtureDb } from "../../test/fixtureDb.ts"
import { createApp } from "../app.ts"
import { loadConfig, type Config } from "../config.ts"
import { openDb, type Db } from "../db.ts"
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  hashToken,
  newSessionToken,
  openUsersDb,
  type UsersDb,
} from "../users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_DBS: string[] = []

function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `albumduel-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
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
  // One address per reader: the album and game buckets are per-IP, and a suite
  // that all looked like one client would 429 itself and read as a feature bug.
  return { username, token, ip: `10.${(seq >> 8) & 255}.${seq & 255}.11` }
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

type FixtureBait = { id: number; sadr: string; ajuz: string; letter: string; playable: boolean }

/** أبيات the game pool WILL serve — a عجز, a بحر, a row in `game_baits`. */
function playableBaits(limit: number, offset = 0): FixtureBait[] {
  return (
    db
      .q(
        `SELECT b.id AS id, b.sadr AS sadr, b.ajuz AS ajuz, gb.first_letter AS letter
         FROM game_baits gb JOIN baits b ON b.id = gb.bait_id
         WHERE b.ajuz IS NOT NULL ORDER BY gb.bait_id LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<Record<string, unknown>>
  ).map((r) => ({
    id: Number(r.id),
    sadr: String(r.sadr),
    ajuz: String(r.ajuz),
    letter: String(r.letter),
    playable: true,
  }))
}

/** أبيات with a عجز that the pool will NOT serve — the honest-count half. */
function unplayableBaits(limit: number): FixtureBait[] {
  return (
    db
      .q(
        `SELECT b.id AS id, b.sadr AS sadr, b.ajuz AS ajuz
         FROM baits b LEFT JOIN game_baits gb ON gb.bait_id = b.id
         WHERE b.ajuz IS NOT NULL AND gb.bait_id IS NULL ORDER BY b.id LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>
  ).map((r) => ({ id: Number(r.id), sadr: String(r.sadr), ajuz: String(r.ajuz), letter: "", playable: false }))
}

function anchorOf(b: { sadr: string; ajuz: string }): string {
  const a = baitAnchor(b.sadr, b.ajuz)
  if (!a) throw new Error("a بيت with a عجز must have an anchor")
  return a
}

async function makeAlbum(who: Reader, fields: Record<string, unknown> = {}): Promise<string> {
  const res = await req("/api/albums", body("POST", { title: "ما أحفظ", ...fields }), who)
  expect(res.status).toBe(201)
  return AlbumMutationResponseSchema.parse(await res.json()).album.code
}

async function fill(who: Reader, code: string, baits: readonly { sadr: string; ajuz: string }[]): Promise<void> {
  const res = await req(
    `/api/albums/${code}/baits`,
    body("POST", { items: baits.map((b) => ({ hFull: anchorOf(b) })) }),
    who,
  )
  expect(res.status).toBe(200)
}

/** A shelf big enough to play in, and the pool the server resolved it to. */
async function playableAlbum(
  who: Reader,
  size = ALBUM_LIMITS.playableFloor + 4,
  fields: Record<string, unknown> = {},
): Promise<{ code: string; pool: number[]; baits: FixtureBait[] }> {
  const code = await makeAlbum(who, fields)
  const baits = playableBaits(size)
  await fill(who, code, baits)
  const res = await req(`/api/albums/${code}/pool`, {}, who)
  expect(res.status).toBe(200)
  const parsed = AlbumPoolResponseSchema.parse(await res.json())
  return { code, pool: parsed.baitIds, baits }
}

beforeAll(async () => {
  await ensureFixtureDb()
  db = openDb(FIXTURE_DB)
  users = openUsersDb(tempUsersPath("main"))
  config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "5750",
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "https://qarid.example",
  } as NodeJS.ProcessEnv)
  app = createApp(config, db, users).app
}, 120_000)

afterAll(() => {
  db?.close()
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

// ═════════════════════════════════════════════════════════════════════════════
// The pool
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/albums/:code/pool", () => {
  it("says three different numbers, and «playable» is the one the game can honour", async () => {
    const a = reader("shanfara")
    const code = await makeAlbum(a)
    const playable = playableBaits(6)
    const mute = unplayableBaits(3)
    // A shelf a reader actually builds is both kinds mixed: أبيات the duel can
    // serve, and أبيات whose قصيدة carries no بحر (39.8 % of the corpus).
    await fill(a, code, [...playable, ...mute])

    const res = await req(`/api/albums/${code}/pool`, {}, a)
    expect(res.status).toBe(200)
    const pool = AlbumPoolResponseSchema.parse(await res.json())

    expect(pool.count).toBe(playable.length + mute.length)
    expect(pool.resolved).toBe(playable.length + mute.length)
    expect(pool.playable).toBe(playable.length)
    expect(pool.baitIds).toHaveLength(playable.length)
    expect(pool.album.title).toBe("ما أحفظ")
  })

  it("hands back ids `game_baits` actually holds, one per بيت", async () => {
    const a = reader("khansa")
    const { pool } = await playableAlbum(a)
    expect(pool.length).toBeGreaterThanOrEqual(ALBUM_LIMITS.playableFloor)
    expect(new Set(pool).size).toBe(pool.length)
    for (const id of pool) {
      expect(db.q("SELECT 1 AS ok FROM game_baits WHERE bait_id = ?").get(id)).toBeTruthy()
    }
  })

  it("is behind the SAME gate the shelf itself is — a private ديوان is a 404", async () => {
    const a = reader("aasha")
    const b = reader("hutaya")
    const { code } = await playableAlbum(a)
    expect((await req(`/api/albums/${code}/pool`, {}, b)).status).toBe(404)

    await req(`/api/albums/${code}`, body("PATCH", { visibility: "unlisted" }), a)
    expect((await req(`/api/albums/${code}/pool`, {}, b)).status).toBe(200)
  })

  it("moves with the shelf: an added بيت is in the next pool", async () => {
    const a = reader("mutalammis")
    const { code, pool } = await playableAlbum(a)
    const extra = playableBaits(2, 120)
    await fill(a, code, extra)
    const after = AlbumPoolResponseSchema.parse(await (await req(`/api/albums/${code}/pool`, {}, a)).json())
    // The memo is keyed on `updated_at`, which every write helper stamps — so
    // this is the invalidation working, not a cache that had to be cleared.
    expect(after.playable).toBeGreaterThan(pool.length)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Solo — the opponent recites from the shelf and from nowhere else
// ═════════════════════════════════════════════════════════════════════════════

describe("مساجلة في ديوان (solo)", () => {
  it("opens with a بيت from the ديوان", async () => {
    const a = reader("tarafa")
    const { pool } = await playableAlbum(a)
    for (const seed of ["a", "b", "c", "d"]) {
      const res = await req("/api/game/start", body("POST", { difficulty: "brutal", poolBaitIds: pool, seed }), a)
      expect(res.status).toBe(200)
      const started = GameStartResponseSchema.parse(await res.json())
      expect(started.ok).toBe(true)
      if (started.ok) expect(pool).toContain(started.bait.id)
    }
  })

  it("answers on a letter the shelf HAS, and concedes on one it does not", async () => {
    const a = reader("nabighah")
    const { pool } = await playableAlbum(a, 24)
    const letters = new Set(
      (
        db
          .q(`SELECT DISTINCT first_letter AS l FROM game_baits WHERE bait_id IN (${pool.map(() => "?").join(",")})`)
          .all(...pool) as Array<Record<string, unknown>>
      ).map((r) => String(r.l)),
    )
    const has = [...letters][0]!
    const hasNot = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي".split("").find((l) => !letters.has(l))!

    const on = GameReplyResponseSchema.parse(
      await (
        await req("/api/game/reply", body("POST", { letter: has, difficulty: "brutal", poolBaitIds: pool }), a)
      ).json(),
    )
    expect(on.ok).toBe(true)
    if (on.ok) expect(pool).toContain(on.bait.id)

    // «أفحمتَ الخصم»: the ديوان has nothing on this letter, and the answer to
    // that is a concede — never a بيت from outside the shelf.
    const off = GameReplyResponseSchema.parse(
      await (
        await req("/api/game/reply", body("POST", { letter: hasNot, difficulty: "brutal", poolBaitIds: pool }), a)
      ).json(),
    )
    expect(off.ok).toBe(false)
    if (!off.ok) expect(off.reason).toBe("no_bait")
  })

  it("drops the «قيود» rather than concede, and NEVER drops the ديوان", async () => {
    const a = reader("labidx")
    const { pool } = await playableAlbum(a, 24)
    const letter = String(
      (db.q(`SELECT first_letter AS l FROM game_baits WHERE bait_id = ?`).get(pool[0]!) as Record<string, unknown>).l,
    )
    // A قيد the shelf cannot satisfy: `relaxFilters` exists precisely so this
    // does not hand «أفحمتَ الخصم» over for free — but the relaxed attempt is
    // still inside the ديوان, so whatever comes back is on the shelf.
    const res = GameReplyResponseSchema.parse(
      await (
        await req(
          "/api/game/reply",
          body("POST", {
            letter,
            difficulty: "brutal",
            poolBaitIds: pool,
            filters: { era: "jahili", meter: "hazaj" },
          }),
          a,
        )
      ).json(),
    )
    if (res.ok) expect(pool).toContain(res.bait.id)
    else expect(res.reason).toBe("no_bait")
  })

  it("verifies the PLAYER's answer against the whole corpus, not the shelf", async () => {
    const a = reader("umruq")
    const { pool } = await playableAlbum(a)
    // A بيت far outside the shelf, answered on its own letter: the player draws
    // from the ديوان الأكبر, which is the asymmetry the feature is built on.
    const outside = playableBaits(1, 120)[0]!
    const res = await req(
      "/api/game/verify",
      body("POST", { text: `${outside.sadr} ${outside.ajuz}`, requiredLetter: outside.letter, poolBaitIds: pool }),
      a,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The room — the memorization contest
// ═════════════════════════════════════════════════════════════════════════════

describe("ROOM في ديوان", () => {
  async function openAlbumRoom(host: Reader, guest: Reader, code: string) {
    const created = await req("/api/room", body("POST", { albumCode: code, strikes: 3 }), host)
    expect(created.status).toBe(201)
    const state = RoomStateResponseSchema.parse(await created.json()).state
    const joined = await req(`/api/room/${state.code}/join`, body("POST", { key: state.joinKey }), guest)
    expect(joined.status).toBe(200)
    return { code: state.code, state: RoomStateResponseSchema.parse(await joined.json()).state }
  }

  it("names the ديوان on the snapshot and opens from it", async () => {
    const host = reader("qaysroom")
    const guest = reader("laylaroom")
    const { code, pool } = await playableAlbum(host, 24, { visibility: "unlisted" })
    const room = await openAlbumRoom(host, guest, code)

    expect(room.state.album).toEqual({ code, title: "ما أحفظ" })
    const opening = room.state.turns[0]!
    expect(opening.verdict).toBe("opening")
    expect(pool).toContain(opening.bait!.id)
  })

  it("refuses a shelf below the floor, and one the host cannot open", async () => {
    const host = reader("thin")
    const other = reader("elsewhere")
    const small = await makeAlbum(host)
    await fill(host, small, playableBaits(ALBUM_LIMITS.playableFloor - 1))
    const thin = await req("/api/room", body("POST", { albumCode: small }), host)
    expect(thin.status).toBe(409)
    expect((await thin.json()).error).toBe("album_too_thin")

    const { code } = await playableAlbum(other)
    const hidden = await req("/api/room", body("POST", { albumCode: code }), host)
    expect(hidden.status).toBe(404)
    expect((await hidden.json()).error).toBe("album_not_found")
  })

  it("refuses a مطلع that is not on the shelf", async () => {
    const host = reader("openoff")
    const { code, pool } = await playableAlbum(host)
    const outside = playableBaits(1, 120)[0]!
    expect(pool).not.toContain(outside.id)
    const res = await req("/api/room", body("POST", { albumCode: code, baitId: outside.id }), host)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad_bait")
  })

  it("refuses a REAL بيت that is not in the ديوان — softly, and without a row", async () => {
    const host = reader("hostmem")
    const guest = reader("guestmem")
    const { code, baits } = await playableAlbum(host, 24, { visibility: "unlisted" })
    const onShelf = new Set(baits.map(anchorOf))
    const room = await openAlbumRoom(host, guest, code)

    const letter = room.state.required!.requiredLetter
    // A بيت the whole corpus holds, on the required letter, that the shelf does
    // not: the verifier accepts it and the ROOM refuses it. The test for «not on
    // the shelf» is the ANCHOR, exactly as the server's is — an id test would
    // call a second copy of a shelf بيت an outsider.
    const outsider = (
      db
        .q(
          `SELECT b.id AS id, b.sadr AS sadr, b.ajuz AS ajuz
           FROM game_baits gb JOIN baits b ON b.id = gb.bait_id
           WHERE gb.first_letter = ? AND b.ajuz IS NOT NULL
           ORDER BY gb.fame DESC LIMIT 60`,
        )
        .all(letter) as Array<Record<string, unknown>>
    )
      .map((r) => ({ id: Number(r.id), sadr: String(r.sadr), ajuz: String(r.ajuz) }))
      .find((b) => {
        const anchor = baitAnchor(b.sadr, b.ajuz)
        return anchor !== null && !onShelf.has(anchor)
      })
    expect(outsider).toBeTruthy()

    const res = await req(`/api/room/${room.code}/turn`, body("POST", { text: `${outsider!.sadr} ${outsider!.ajuz}` }), guest)
    expect(res.status).toBe(200)
    const parsed = RoomTurnResponseSchema.parse(await res.json())

    expect(parsed.verdict.result.ok).toBe(false)
    if (!parsed.verdict.result.ok) {
      expect(parsed.verdict.result.reason).toBe("not_in_album")
      if (parsed.verdict.result.reason === "not_in_album") expect(parsed.verdict.result.albumTitle).toBe("ما أحفظ")
    }
    // SOFT: no strike, no row, and the turn is still the guest's.
    expect(parsed.verdict.strike).toBe(false)
    expect(parsed.verdict.strikesLeft).toBe(3)
    expect(parsed.state.turns).toHaveLength(1)
    expect(parsed.state.turnSeat).toBe("guest")
  })

  it("accepts a بيت that IS on the shelf", async () => {
    const host = reader("hostyes")
    const guest = reader("guestyes")
    const { code, pool } = await playableAlbum(host, 40, { visibility: "unlisted" })
    const room = await openAlbumRoom(host, guest, code)
    const letter = room.state.required!.requiredLetter
    const opening = room.state.turns[0]!.bait!.id

    const candidates = (
      db
        .q(
          `SELECT b.id AS id, b.sadr AS sadr, b.ajuz AS ajuz
           FROM game_baits gb JOIN baits b ON b.id = gb.bait_id
           WHERE gb.first_letter = ? AND gb.bait_id IN (${pool.map(() => "?").join(",")})`,
        )
        .all(letter, ...pool) as Array<Record<string, unknown>>
    )
      .map((r) => ({ id: Number(r.id), sadr: String(r.sadr), ajuz: String(r.ajuz) }))
      .filter((b) => b.id !== opening)
    if (candidates.length === 0) return // this shelf simply cannot chain; the concede path covers it

    let accepted = false
    for (const cand of candidates) {
      const res = await req(`/api/room/${room.code}/turn`, body("POST", { text: `${cand.sadr} ${cand.ajuz}` }), guest)
      const parsed = RoomTurnResponseSchema.parse(await res.json())
      if (parsed.verdict.result.ok) {
        accepted = true
        expect(parsed.state.turns).toHaveLength(2)
        expect(parsed.state.turnSeat).toBe("host")
        break
      }
      // Whatever else the verifier said, it must not be «ليس من هذا الديوان» —
      // these أبيات are on the shelf.
      if (!parsed.verdict.result.ok) expect(parsed.verdict.result.reason).not.toBe("not_in_album")
    }
    expect(accepted).toBe(true)
  })
})
