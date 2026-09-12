/**
 * مساجلة rooms, end to end (v2.md §5).
 *
 * The whole file plays REAL matches: two registered accounts, the real fixture
 * corpus built by `scripts/ingest/build.ts`, the real verify pipeline, and the
 * real HTTP and WebSocket surfaces. Nothing about a room is mocked, because
 * every interesting thing about a room is an interaction between the clock, the
 * transcript and the verifier — and each of those is exactly where a mock would
 * have been put.
 *
 * The answers are not hard-coded either. `answerOn(letter)` asks the fixture
 * for a بيت that opens on the letter the SERVER just demanded and has not been
 * played yet, and tries the next candidate if the verifier refuses this one —
 * so the test exercises the same loop a player does, over whatever the fixture
 * happens to hold, and a re-ingest that renumbers `baits.id` does not break it.
 */

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { serve, type ServerType } from "@hono/node-server"
import type { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  RoomEventSchema,
  RoomKnockResponseSchema,
  RoomStateResponseSchema,
  RoomTurnResponseSchema,
  type RoomEvent,
  type RoomState,
} from "../shared/schema.ts"
import { FIXTURE_DB, REPO_ROOT, ensureFixtureDb } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig, type Config } from "./config.ts"
import { openDb, type Db } from "./db.ts"
import { MAX_SOCKETS_PER_USER, newRoomCode } from "./rooms.ts"
import { SOCKET_FRAME_LIMIT, bearerFromSubprotocol } from "./routes/rooms.ts"
import {
  DONE_ROOM_TTL_MS,
  SESSION_COOKIE,
  WAITING_ROOM_TTL_MS,
  createSession,
  createUser,
  deleteSession,
  duelStats,
  hashToken,
  newSessionToken,
  openUsersDb,
  purgeStaleRooms,
  recentMatches,
  type UsersDb,
} from "./users.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The WebSocket suite binds a REAL socket, and it takes whatever the OS hands
 * it (`PORT=0`, read back off `server.address()`). A fixed port would make the
 * whole file fail whenever anything else on the box — another agent's dev
 * server, a screenshot run, a second copy of this suite — happened to hold it,
 * and the failure would look like a room bug.
 */
let wsPort = 0

const TEMP_DBS: string[] = []

function tempUsersPath(tag: string): string {
  const p = path.join(REPO_ROOT, "data", `rooms-test-${tag}-${process.pid}-${randomBytes(4).toString("hex")}.db`)
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
let app: Hono
let config: Config

/**
 * A logged-in player: the cookie, the two names the snapshot uses, and an IP.
 *
 * The IP is not decoration. `/api/room` and `/api/room/:code/turn` sit behind
 * the duel's own token bucket (12 per 10 s per IP, `clientKey`), and every
 * `app.request()` in a suite looks like the same anonymous client — so a file
 * that plays six matches would 429 itself halfway through and the failure
 * would look like a room bug. One address per player is also what the wire
 * actually looks like: `CF-Connecting-IP` is the header the limiter keys on,
 * because Cloudflare APPENDS to a client-supplied XFF (CLAUDE.md).
 */
type Player = { username: string; displayName: string; token: string; ip: string }

async function req(pathname: string, init: RequestInit, who?: Player | string): Promise<Response> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) }
  if (typeof who === "string") headers.Cookie = `${SESSION_COOKIE}=${who}`
  else if (who) {
    headers.Cookie = `${SESSION_COOKIE}=${who.token}`
    headers["CF-Connecting-IP"] = who.ip
  }
  return app.request(pathname, { ...init, headers })
}

async function postJson(pathname: string, body: unknown, who?: Player | string): Promise<Response> {
  return req(pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, who)
}

function tokenOf(res: Response): string {
  const all = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [
    res.headers.get("set-cookie") ?? "",
  ]
  for (const c of all) {
    const m = /(?:^|,\s*)qarid_sess=([^;]*)/.exec(c)
    if (m?.[1]) return m[1]
  }
  throw new Error("no session cookie on the response")
}

/**
 * A player, made the way a room actually needs one: a row and a live session.
 *
 * NOT through `POST /api/auth/register`, for two reasons that both matter here
 * — that route is rate-limited to five per hour per IP (v2.md §4) and a suite
 * that plays six matches needs twenty accounts, and each registration pays for
 * one scrypt (~60 ms) to protect a password no test ever types. The session
 * cookie is minted through the same `createSession`/`hashToken` pair the route
 * uses, so everything past this line is the real door.
 */
let seq = 0
function player(name: string, into: UsersDb = users): Player {
  const username = `${name}${++seq}`
  const now = Date.now()
  const row = createUser(into, { username, displayName: name, passHash: "scrypt$not-a-login", now })
  if (!row) throw new Error(`could not create ${username}`)
  const token = newSessionToken()
  createSession(into, { userId: row.id, tokenHash: hashToken(token), now })
  return { username, displayName: name, token, ip: `10.${(seq >> 8) & 255}.${seq & 255}.7` }
}

async function register(name: string): Promise<Player> {
  return player(name)
}

async function stateOf(code: string, who: Player, key?: string | null): Promise<RoomState> {
  const res = await req(`/api/room/${code}/state${key ? `?k=${encodeURIComponent(key)}` : ""}`, {}, who)
  expect(res.status).toBe(200)
  return RoomStateResponseSchema.parse(await res.json()).state
}

/**
 * Create a room, join it with the guest, and hand back the live snapshot.
 *
 * The guest presents the room's `joinKey` — the invite that rides in
 * `shareUrl` — because the code alone no longer opens a seat: a room link is
 * not public, it is a link you were given (server/rooms.ts `newJoinKey`).
 */
async function openRoom(
  host: Player,
  guest: Player | null,
  body: Record<string, unknown> = {},
): Promise<{ code: string; state: RoomState; key: string }> {
  const res = await postJson("/api/room", body, host)
  expect(res.status).toBe(201)
  const created = RoomStateResponseSchema.parse(await res.json()).state
  const key = created.joinKey!
  expect(key).toBeTruthy()
  if (!guest) return { code: created.code, state: created, key }
  const joined = await postJson(`/api/room/${created.code}/join`, { key }, guest)
  expect(joined.status).toBe(200)
  return { code: created.code, state: RoomStateResponseSchema.parse(await joined.json()).state, key }
}

/**
 * أبيات from the fixture that open on `letter`, most-famous first, minus what
 * the room has already heard. The room's own exclusions are cumulative and
 * per-قصيدة, so the candidate list drops whole قصائد, not just أبيات.
 */
function candidatesOn(letter: string, usedBaits: Set<number>, usedPoems: Set<number>): { id: number; text: string }[] {
  const rows = db
    .q(
      `SELECT gb.bait_id AS id, gb.poem_id AS poem_id, b.sadr AS sadr, b.ajuz AS ajuz
       FROM game_baits gb JOIN baits b ON b.id = gb.bait_id
       WHERE gb.first_letter = ? AND b.ajuz IS NOT NULL
       ORDER BY gb.fame DESC, gb.position ASC LIMIT 40`,
    )
    .all(letter) as Array<Record<string, unknown>>
  return rows
    .filter((r) => !usedBaits.has(Number(r.id)) && !usedPoems.has(Number(r.poem_id)))
    .map((r) => ({ id: Number(r.id), text: `${String(r.sadr)} ${String(r.ajuz)}` }))
}

/**
 * Play ONE accepted بيت for `who`, trying candidates until the verifier takes
 * one. Returns the snapshot the server answered with.
 */
async function playOne(code: string, who: Player, state: RoomState): Promise<RoomState> {
  const letter = state.required?.requiredLetter
  expect(letter).toBeTruthy()
  const usedBaits = new Set(state.turns.map((t) => t.bait?.id).filter((id): id is number => typeof id === "number"))
  const usedPoems = new Set(
    state.turns.map((t) => t.bait?.poem.poemId).filter((id): id is number => typeof id === "number"),
  )
  for (const cand of candidatesOn(letter!, usedBaits, usedPoems)) {
    const res = await postJson(`/api/room/${code}/turn`, { text: cand.text }, who)
    expect(res.status).toBe(200)
    const parsed = RoomTurnResponseSchema.parse(await res.json())
    if (parsed.verdict.result.ok) return parsed.state
    // A refusal that would cost a strike must not be silently retried — the
    // test would then be measuring the fixture's luck rather than the room.
    expect(parsed.verdict.strike).toBe(false)
  }
  throw new Error(`no acceptable بيت on «${letter}» in the fixture`)
}

beforeAll(async () => {
  await ensureFixtureDb()
  db = openDb(FIXTURE_DB)
  users = openUsersDb(tempUsersPath("main"))
  config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "https://qarid.example",
  } as NodeJS.ProcessEnv)
  app = createApp(config, db, users).app
}, 120_000)

afterAll(() => {
  db?.close()
  users?.close()
  removeTempDbs()
})

// ═════════════════════════════════════════════════════════════════════════════
// The code
// ═════════════════════════════════════════════════════════════════════════════

describe("the room code", () => {
  it("is six letters, three speakable pairs, and never a digit", () => {
    for (let i = 0; i < 200; i++) {
      const code = newRoomCode()
      expect(code).toMatch(/^[BDFHJKLMNRSTWZ][AEIOU][BDFHJKLMNRSTWZ][AEIOU][BDFHJKLMNRSTWZ][AEIOU]$/)
    }
  })

  it("does not repeat itself over a few hundred draws", () => {
    const seen = new Set(Array.from({ length: 400 }, () => newRoomCode()))
    expect(seen.size).toBeGreaterThan(390)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Creating and joining
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/room", () => {
  it("refuses an anonymous host — both players MUST be logged in", async () => {
    const res = await postJson("/api/room", {})
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "unauthenticated" })
  })

  it("opens a waiting room whose transcript already holds the opening بيت", async () => {
    const host = await register("host")
    const res = await postJson("/api/room", {}, host)
    expect(res.status).toBe(201)
    const state = RoomStateResponseSchema.parse(await res.json()).state

    expect(state.status).toBe("waiting")
    expect(state.host?.username).toBe(host.username)
    expect(state.guest).toBeNull()
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0]!.verdict).toBe("opening")
    expect(state.turns[0]!.seat).toBe("host")
    expect(state.turns[0]!.bait?.sadr.length).toBeGreaterThan(0)
    // The guest answers first, so the required letter is live before he arrives.
    expect(state.required?.requiredLetter).toBeTruthy()
    expect(state.turnSeat).toBeNull()
    expect(state.deadlineAt).toBeNull()
    expect(state.you.role).toBe("host")
    // The link the host hands over carries the invite; the code alone names
    // the room but does not open its seat.
    expect(state.joinKey).toMatch(/^[a-z2-9]{24}$/)
    expect(state.shareUrl).toBe(`https://qarid.example/#/room/${state.code}?k=${state.joinKey}`)
  })

  it("takes the host's own بيت, and refuses one the game pool does not hold", async () => {
    const host = await register("picker")
    const chosen = db.q("SELECT bait_id AS id FROM game_baits ORDER BY bait_id LIMIT 1").get() as { id: number }
    const ok = await postJson("/api/room", { baitId: chosen.id, mode: "literal", timerS: 60, strikes: 1 }, host)
    expect(ok.status).toBe(201)
    const state = RoomStateResponseSchema.parse(await ok.json()).state
    expect(state.turns[0]!.bait?.id).toBe(chosen.id)
    expect(state.mode).toBe("literal")
    expect(state.timerS).toBe(60)
    expect(state.strikes).toBe(1)

    const notPlayable = db
      .q("SELECT id FROM baits WHERE id NOT IN (SELECT bait_id FROM game_baits) ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined
    if (notPlayable) {
      const bad = await postJson("/api/room", { baitId: notPlayable.id }, host)
      expect(bad.status).toBe(400)
      expect(await bad.json()).toMatchObject({ error: "bad_bait" })
    }
  })

  it("rejects a timer that is not 30/60/90 and a strike count outside 1..3", async () => {
    const host = await register("strict")
    expect((await postJson("/api/room", { timerS: 45 }, host)).status).toBe(400)
    expect((await postJson("/api/room", { strikes: 9 }, host)).status).toBe(400)
  })
})

describe("joining", () => {
  it("flips the room to active, starts the clock, and gives the guest the first turn", async () => {
    const host = await register("layth")
    const guest = await register("amr")
    const { code, state } = await openRoom(host, guest, { timerS: 90 })

    expect(state.status).toBe("active")
    expect(state.guest?.username).toBe(guest.username)
    expect(state.turnSeat).toBe("guest")
    expect(state.you.role).toBe("guest")
    expect(state.you.canPlay).toBe(true)
    expect(state.deadlineAt).toBeGreaterThan(state.serverNow)
    expect(state.deadlineAt! - state.serverNow).toBeLessThanOrEqual(90_000)

    // …and the host sees the same room from the other side.
    const fromHost = await stateOf(code, host)
    expect(fromHost.you.role).toBe("host")
    expect(fromHost.you.canPlay).toBe(false)
    expect(fromHost.turnSeat).toBe("guest")
  })

  it("makes the third person a spectator, and a spectator cannot play", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const watcher = await register("watcher")
    const { code, key } = await openRoom(host, guest)

    const join = await postJson(`/api/room/${code}/join`, { key }, watcher)
    expect(join.status).toBe(409)
    expect(await join.json()).toMatchObject({ error: "room_full" })

    const seen = await stateOf(code, watcher, key)
    expect(seen.you.role).toBe("spectator")
    expect(seen.you.canPlay).toBe(false)
    expect(seen.turns).toHaveLength(1)

    const played = await postJson(`/api/room/${code}/turn`, { text: "قفا نبك من ذكرى حبيب ومنزل" }, watcher)
    expect(played.status).toBe(403)
    expect(await played.json()).toMatchObject({ error: "spectator" })
  })

  it("answers 404 for a code nobody opened, and 401 with no session at all", async () => {
    const someone = await register("nobody")
    expect((await req("/api/room/ZAZAZA/state", {}, someone)).status).toBe(404)
    expect((await req("/api/room/ZAZAZA/state", {})).status).toBe(401)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A whole match
// ═════════════════════════════════════════════════════════════════════════════

describe("a full مساجلة", () => {
  it("alternates six accepted أبيات, excludes cumulatively, and records the turns", async () => {
    const host = await register("mutanabbi")
    const guest = await register("buhturi")
    // بيت 1 of the fixture opens a chain the corpus can actually answer six times.
    const { code, state } = await openRoom(host, guest, { baitId: 1 })

    let live = state
    const order: string[] = []
    for (let turn = 0; turn < 6; turn++) {
      const who = live.turnSeat === "guest" ? guest : host
      order.push(live.turnSeat!)
      const before = live.turns.length
      live = await playOne(code, who, live)
      expect(live.turns.length).toBe(before + 1)
      const last = live.turns[live.turns.length - 1]!
      expect(last.verdict).toBe("ok")
      expect(last.username).toBe(who.username)
    }

    expect(order).toEqual(["guest", "host", "guest", "host", "guest", "host"])
    expect(live.status).toBe("active")
    expect(live.host?.turns).toBe(3)
    expect(live.guest?.turns).toBe(3)
    expect(live.host?.strikes).toBe(0)

    // Cumulative exclusions: every بيت, and every قصيدة, exactly once.
    const baitIds = live.turns.map((t) => t.bait!.id)
    expect(new Set(baitIds).size).toBe(baitIds.length)
    const poemIds = live.turns.map((t) => t.bait!.poem.poemId)
    expect(new Set(poemIds).size).toBe(poemIds.length)

    // …and each answer really did open on the letter the previous one demanded.
    for (let i = 1; i < live.turns.length; i++) {
      expect(live.turns[i]!.bait!.firstLetter).toBeTruthy()
    }

    // Replaying a بيت THIS ROOM has already heard is refused and costs nothing
    // — and it has to be one that opens on the letter now being demanded, or
    // the wrong-letter rung would refuse it first (and that one IS a strike).
    const demanded = live.required!.requiredLetter
    const sayable = live.turns.find((t) => t.bait?.firstLetter === demanded)
    expect(sayable).toBeTruthy()
    const repeat = await postJson(
      `/api/room/${code}/turn`,
      { text: `${sayable!.bait!.sadr} ${sayable!.bait!.ajuz}` },
      live.turnSeat === "guest" ? guest : host,
    )
    const repeatBody = RoomTurnResponseSchema.parse(await repeat.json())
    expect(repeatBody.verdict.result.ok).toBe(false)
    expect(repeatBody.verdict.strike).toBe(false)
    expect(repeatBody.state.turns.length).toBe(live.turns.length)
  })

  it("refuses a بيت out of turn without touching the transcript", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code, state } = await openRoom(host, guest)
    const res = await postJson(`/api/room/${code}/turn`, { text: "قفا نبك من ذكرى حبيب ومنزل" }, host)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "not_your_turn" })
    expect((await stateOf(code, host)).turns).toHaveLength(state.turns.length)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Strikes
// ═════════════════════════════════════════════════════════════════════════════

describe("strikes", () => {
  it("writes a row per strike, keeps the turn with the same player, and ends the room at the limit", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code, state } = await openRoom(host, guest, { strikes: 2 })

    const nonsense = "زقفونة برجلة مهملة لا وجود لها في الديوان"
    const first = await postJson(`/api/room/${code}/turn`, { text: nonsense }, guest)
    const firstBody = RoomTurnResponseSchema.parse(await first.json())
    expect(firstBody.verdict.strike).toBe(true)
    expect(firstBody.verdict.strikesLeft).toBe(1)
    // The strike is a row, and the turn did NOT pass to the other player.
    expect(firstBody.state.turns.length).toBe(state.turns.length + 1)
    expect(firstBody.state.turns.at(-1)!.bait).toBeNull()
    expect(firstBody.state.turns.at(-1)!.text).toBe(nonsense)
    expect(firstBody.state.turnSeat).toBe("guest")
    expect(firstBody.state.guest?.strikes).toBe(1)

    const second = await postJson(`/api/room/${code}/turn`, { text: nonsense }, guest)
    const secondBody = RoomTurnResponseSchema.parse(await second.json())
    expect(secondBody.verdict.strike).toBe(true)
    expect(secondBody.state.status).toBe("done")
    expect(secondBody.state.endReason).toBe("strikes")
    expect(secondBody.state.winner).toBe(host.username)
    expect(secondBody.state.turnSeat).toBeNull()
    expect(secondBody.state.deadlineAt).toBeNull()

    // A finished room takes no more أبيات.
    const after = await postJson(`/api/room/${code}/turn`, { text: nonsense }, guest)
    expect(after.status).toBe(409)
  })

  it("counts a wrong first letter as a strike and a too-short answer as nothing", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code, state } = await openRoom(host, guest, { strikes: 3 })

    const short = await postJson(`/api/room/${code}/turn`, { text: "بيت" }, guest)
    const shortBody = RoomTurnResponseSchema.parse(await short.json())
    expect(shortBody.verdict.result.ok).toBe(false)
    expect(shortBody.verdict.strike).toBe(false)
    expect(shortBody.state.turns.length).toBe(state.turns.length)

    // A real بيت on the WRONG letter: pick any letter the room did not ask for.
    const required = state.required!.requiredLetter
    const wrongLetter = ["ا", "ب", "م", "ق", "و", "ف"].find((l) => l !== required)!
    const candidate = candidatesOn(wrongLetter, new Set(), new Set())[0]
    if (candidate) {
      const res = await postJson(`/api/room/${code}/turn`, { text: candidate.text }, guest)
      const body = RoomTurnResponseSchema.parse(await res.json())
      if (!body.verdict.result.ok && body.verdict.result.reason === "wrong_letter") {
        expect(body.verdict.strike).toBe(true)
        expect(body.state.guest?.strikes).toBe(1)
        expect(body.state.turns.at(-1)!.verdict).toBe("wrong_letter")
      }
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The clock
// ═════════════════════════════════════════════════════════════════════════════

describe("the server's clock", () => {
  /**
   * The deadline is a number in the database, so a test does not have to sleep
   * for thirty seconds — it moves the deadline into the past and then asks the
   * server what it thinks, which is exactly what a real expiry looks like to
   * every code path that is not the timer itself (a restarted process has no
   * timer at all).
   */
  it("loses the turn for whoever owed a بيت when the deadline passed", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code } = await openRoom(host, guest, { timerS: 30 })

    users.raw.prepare("UPDATE rooms SET turn_deadline_at = ? WHERE code = ?").run(Date.now() - 1, code)

    const after = await stateOf(code, host)
    expect(after.status).toBe("done")
    expect(after.endReason).toBe("timeout")
    // The guest owed the first بيت, so the host wins.
    expect(after.winner).toBe(host.username)
    expect(after.deadlineAt).toBeNull()
  })

  it("does not end a room that has no timer at all", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code, state } = await openRoom(host, guest)
    expect(state.timerS).toBeNull()
    expect(state.deadlineAt).toBeNull()
    const after = await stateOf(code, host)
    expect(after.status).toBe("active")
  })

  it("re-arms the deadline after every accepted بيت", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code, state } = await openRoom(host, guest, { baitId: 1, timerS: 30 })
    const first = state.deadlineAt!
    await new Promise((r) => setTimeout(r, 15))
    const after = await playOne(code, guest, state)
    expect(after.deadlineAt).toBeGreaterThan(first)
    expect(after.turnSeat).toBe("host")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The seat, the clock, and the two things that used to get past them
// ═════════════════════════════════════════════════════════════════════════════

describe("the invite key", () => {
  it("keeps a stranger out of a seat the host meant for a friend", async () => {
    const host = await register("layth")
    const friend = await register("amr")
    const mallory = await register("mallory")
    const { code, key } = await openRoom(host, null)

    // The code alone is what a scan of 343,000 values finds, and what the
    // profile page used to publish. It is not an invitation.
    const sniped = await postJson(`/api/room/${code}/join`, {}, mallory)
    expect(sniped.status).toBe(403)
    expect(await sniped.json()).toMatchObject({ error: "needs_key" })

    const guessed = await postJson(`/api/room/${code}/join`, { key: "aaaaaaaaaaaaaaaaaaaaaaaa" }, mallory)
    expect(guessed.status).toBe(403)

    // …and the seat is still there for the person who was given the link.
    const joined = await postJson(`/api/room/${code}/join`, { key }, friend)
    expect(joined.status).toBe(200)
    expect(RoomStateResponseSchema.parse(await joined.json()).state.guest?.username).toBe(friend.username)
  })

  it("keeps the transcript from a code-holder who was never given the link", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const watcher = await register("watcher")
    const scanner = await register("scanner")
    const { code, key } = await openRoom(host, guest)

    const blind = await req(`/api/room/${code}/state`, {}, scanner)
    expect(blind.status).toBe(403)
    expect(await blind.json()).toMatchObject({ error: "needs_key" })

    // A watcher WITH the link is v2.md §5's spectator and still sees it all.
    const seen = await stateOf(code, watcher, key)
    expect(seen.you.role).toBe("spectator")
    expect(seen.turns.length).toBeGreaterThan(0)
    // …but never the key itself, so he cannot pass a seat on to anyone.
    expect(seen.joinKey).toBeNull()
    expect(seen.shareUrl).not.toContain("?k=")
    expect(seen.you.canJoin).toBe(false)

    // Both players always get in on their seat alone — a lost link is not a
    // locked door for someone already sitting at the table.
    expect((await stateOf(code, host)).you.role).toBe("host")
    expect((await stateOf(code, guest)).joinKey).toBe(key)
  })

  it("needs no key from the player a رجعة already named", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code } = await openRoom(host, guest)
    await postJson(`/api/room/${code}/resign`, {}, guest)
    const next = RoomStateResponseSchema.parse(
      await (await postJson(`/api/room/${code}/rematch`, {}, guest)).json(),
    ).state

    // His id is on the seat, which is a stronger claim than any link.
    const joined = await postJson(`/api/room/${next.code}/join`, {}, host)
    expect(joined.status).toBe(200)
    expect(RoomStateResponseSchema.parse(await joined.json()).state.status).toBe("active")
  })
})

describe("the room bucket", () => {
  it("rate-limits a scan of the code space, which used to be free", async () => {
    const scanner = await register("scanner")
    let limited = 0
    // 6,412 `/state` probes a second were measured on invented codes with no
    // 429 at all — the whole 343,000-code space in minutes.
    for (let i = 0; i < 80; i++) {
      const res = await req(`/api/room/ZAZAZ${i % 10}/state`, {}, scanner)
      if (res.status === 429) limited += 1
    }
    expect(limited).toBeGreaterThan(0)
  })
})

describe("two turns in flight at once", () => {
  it("does not lose the match on a deadline the database no longer holds", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code, state } = await openRoom(host, guest, { baitId: 1, timerS: 30 })
    const roomId = (users.raw.prepare("SELECT id FROM rooms WHERE code = ?").get(code) as { id: number }).id

    // A deadline 400 ms out, and a first request whose BODY has not arrived.
    // `POST /:code/turn` is the one async handler: it loaded the row at
    // dispatch, awaited the body, and then judged the STALE `turn_deadline_at`
    // against a transcript it read fresh — ending the match `timeout` against
    // the player who had just been handed a full clock.
    const deadline = Date.now() + 300
    users.raw.prepare("UPDATE rooms SET turn_deadline_at = ? WHERE id = ?").run(deadline, roomId)

    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ text: "بيتٌ لا وجود له في الديوان أبدًا" })))
        controller.close()
      },
    })
    const slow = app.request(
      new Request(`http://local/api/room/${code}/turn`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${guest.token}`,
          "CF-Connecting-IP": guest.ip,
        },
        body,
        // @ts-expect-error node's fetch needs `duplex` for a streamed body
        duplex: "half",
      }),
    )

    // …meanwhile the guest answers properly, in time, and the clock moves to
    // the host with a fresh thirty seconds.
    const after = await playOne(code, guest, state)
    expect(after.status).toBe("active")
    expect(after.turnSeat).toBe("host")
    expect(after.deadlineAt!).toBeGreaterThan(deadline)

    // Now let the first request's body land, well past the OLD deadline.
    while (Date.now() <= deadline + 80) await new Promise((r) => setTimeout(r, 20))
    release!()
    const late = await slow
    // It is simply out of turn now. What it must NOT be is the end of the room.
    expect(late.status).toBe(409)
    expect(await late.json()).toMatchObject({ error: "not_your_turn" })

    const final = await stateOf(code, host)
    expect(final.status).toBe("active")
    expect(final.endReason).toBeNull()
    expect(final.winner).toBeNull()
    expect(final.turnSeat).toBe("host")
  }, 20_000)
})

// ═════════════════════════════════════════════════════════════════════════════
// انسحاب, رجعة, and the profile
// ═════════════════════════════════════════════════════════════════════════════

describe("resigning", () => {
  it("hands the win to the other seat, and a spectator may not resign for them", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const watcher = await register("watcher")
    const { code } = await openRoom(host, guest)

    expect((await postJson(`/api/room/${code}/resign`, {}, watcher)).status).toBe(403)

    const res = await postJson(`/api/room/${code}/resign`, {}, guest)
    expect(res.status).toBe(200)
    const state = RoomStateResponseSchema.parse(await res.json()).state
    expect(state.status).toBe("done")
    expect(state.endReason).toBe("resign")
    expect(state.winner).toBe(host.username)
  })
})

describe("رجعة (rematch)", () => {
  it("opens ONE new room with the seats swapped and links the old one to it", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code } = await openRoom(host, guest)
    await postJson(`/api/room/${code}/resign`, {}, guest)

    const first = await postJson(`/api/room/${code}/rematch`, {}, guest)
    expect(first.status).toBe(200)
    const next = RoomStateResponseSchema.parse(await first.json()).state
    expect(next.code).not.toBe(code)
    expect(next.status).toBe("waiting")
    // Swapped: the old guest recites the opening بيت this time.
    expect(next.host?.username).toBe(guest.username)
    expect(next.guest?.username).toBe(host.username)
    expect(next.turns[0]!.verdict).toBe("opening")

    // The second press — by either player, from either transport — finds the
    // same room rather than opening a third.
    const second = await postJson(`/api/room/${code}/rematch`, {}, host)
    const again = RoomStateResponseSchema.parse(await second.json()).state
    expect(again.code).toBe(next.code)
    expect((await stateOf(code, host)).rematchCode).toBe(next.code)

    // …and the pre-assigned seat is reserved: only the old host may take it.
    const stranger = await register("stranger")
    expect((await postJson(`/api/room/${next.code}/join`, {}, stranger)).status).toBe(409)
    const joined = await postJson(`/api/room/${next.code}/join`, {}, host)
    expect(joined.status).toBe(200)
    expect(RoomStateResponseSchema.parse(await joined.json()).state.status).toBe("active")
  })

  it("refuses a rematch of a room that is still being played", async () => {
    const host = await register("host")
    const guest = await register("guest")
    const { code } = await openRoom(host, guest)
    expect((await postJson(`/api/room/${code}/rematch`, {}, host)).status).toBe(409)
  })
})

describe("what the profile page reads back", () => {
  it("counts the match, the win, the loss and the أبيات — and lists the room", async () => {
    const host = await register("winner")
    const guest = await register("loser")
    const { code, state } = await openRoom(host, guest, { baitId: 1, strikes: 1 })

    // one accepted بيت from the guest, then the host strikes out
    const afterGuest = await playOne(code, guest, state)
    expect(afterGuest.turnSeat).toBe("host")
    await postJson(`/api/room/${code}/turn`, { text: "زقفونة برجلة مهملة لا وجود لها في الديوان" }, host)

    const hostRow = users.raw.prepare("SELECT id FROM users WHERE username = ?").get(host.username) as { id: number }
    const guestRow = users.raw.prepare("SELECT id FROM users WHERE username = ?").get(guest.username) as { id: number }

    const guestStats = duelStats(users, guestRow.id)
    expect(guestStats.matches).toBe(1)
    expect(guestStats.wins).toBe(1)
    expect(guestStats.losses).toBe(0)
    // The opening بيت is the host's `opening` row and is NOT counted as a بيت
    // he answered with — only accepted أبيات are.
    expect(guestStats.turns).toBe(1)
    expect(guestStats.bestChain).toBe(1)

    const hostStats = duelStats(users, hostRow.id)
    expect(hostStats.wins).toBe(0)
    expect(hostStats.losses).toBe(1)
    expect(hostStats.turns).toBe(0)

    const recent = recentMatches(users, guestRow.id, 10)
    expect(recent[0]).toMatchObject({ code, status: "done", result: "win", opponent: host.displayName })

    // …and the same numbers through the real profile route.
    const page = await req(`/api/profile/${guest.username}`, {}, guest)
    expect(page.status).toBe(200)
    const body = (await page.json()) as { stats: { wins: number }; recent: { code: string }[] }
    expect(body.stats.wins).toBe(1)
    expect(body.recent[0]!.code).toBe(code)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Knock-to-join
// ═════════════════════════════════════════════════════════════════════════════

/** Create a WAITING room with no guest, and hand back the code and its key. */
async function openWaiting(host: Player): Promise<{ code: string; key: string }> {
  const created = RoomStateResponseSchema.parse(await (await postJson("/api/room", {}, host)).json()).state
  return { code: created.code, key: created.joinKey! }
}

describe("knock-to-join", () => {
  it("knock → host sees it → accept seats the knocker and activates the room", async () => {
    const host = await register("knhost")
    const guest = await register("knguest")
    const { code } = await openWaiting(host)

    // A guest who arrived by voice has no key: /state is the needs_key wall,
    // never the transcript.
    const walled = await req(`/api/room/${code}/state`, {}, guest)
    expect(walled.status).toBe(403)
    expect(await walled.json()).toMatchObject({ error: "needs_key" })

    // He knocks. The answer is his OWN minimal status, never the room.
    const knocked = await postJson(`/api/room/${code}/knock`, {}, guest)
    expect(knocked.status).toBe(200)
    const kv = RoomKnockResponseSchema.parse(await knocked.json()).knock
    expect(kv.status).toBe("pending")
    expect(kv.code).toBe(code)
    expect(kv).not.toHaveProperty("turns")
    expect(kv).not.toHaveProperty("host")

    // The host's snapshot now names the knocker — over the poller, so a socket
    // is not required to see the door.
    const hostState = await stateOf(code, host)
    expect(hostState.knock?.username).toBe(guest.username)
    expect(hostState.knock?.displayName).toBe(guest.displayName)

    // A knocker is NOT a player: he still cannot read the room.
    expect((await req(`/api/room/${code}/state`, {}, guest)).status).toBe(403)

    // Accept assigns the seat and activates — the SAME join path.
    const accepted = await postJson(`/api/room/${code}/knock/accept`, {}, host)
    expect(accepted.status).toBe(200)
    const active = RoomStateResponseSchema.parse(await accepted.json()).state
    expect(active.status).toBe("active")
    expect(active.guest?.username).toBe(guest.username)
    // The door prompt is gone once he is seated.
    expect(active.knock).toBeNull()

    // Now he is a player: /state succeeds with NO key, and his poll says so.
    const guestState = await stateOf(code, guest)
    expect(guestState.status).toBe("active")
    expect(guestState.you.seat).toBe("guest")
    const poll = RoomKnockResponseSchema.parse(await (await req(`/api/room/${code}/knock`, {}, guest)).json()).knock
    expect(poll.status).toBe("accepted")
  })

  it("reject clears the knock; the seat stays open and the knocker is told", async () => {
    const host = await register("rjhost")
    const guest = await register("rjguest")
    const { code } = await openWaiting(host)
    await postJson(`/api/room/${code}/knock`, {}, guest)

    const rejected = await postJson(`/api/room/${code}/knock/reject`, {}, host)
    expect(rejected.status).toBe(200)
    const st = RoomStateResponseSchema.parse(await rejected.json()).state
    expect(st.status).toBe("waiting")
    expect(st.knock).toBeNull()

    const poll = RoomKnockResponseSchema.parse(await (await req(`/api/room/${code}/knock`, {}, guest)).json()).knock
    expect(poll.status).toBe("rejected")
    // Still no transcript for the refused knocker.
    expect((await req(`/api/room/${code}/state`, {}, guest)).status).toBe(403)
  })

  it("only the host may accept or reject", async () => {
    const host = await register("hohost")
    const guest = await register("hoguest")
    const stranger = await register("hostrange")
    const { code } = await openWaiting(host)
    await postJson(`/api/room/${code}/knock`, {}, guest)

    expect((await postJson(`/api/room/${code}/knock/accept`, {}, stranger)).status).toBe(403)
    expect((await postJson(`/api/room/${code}/knock/reject`, {}, guest)).status).toBe(403)
    // The knock survived the failed attempts.
    expect((await stateOf(code, host)).knock?.username).toBe(guest.username)
  })

  it("one pending knock at a time — a second knocker is told the room is busy", async () => {
    const host = await register("bshost")
    const first = await register("bsfirst")
    const second = await register("bssecond")
    const { code } = await openWaiting(host)
    expect((await postJson(`/api/room/${code}/knock`, {}, first)).status).toBe(200)
    const busy = await postJson(`/api/room/${code}/knock`, {}, second)
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: "room_busy" })
  })

  it("the host cannot knock his own room", async () => {
    const host = await register("selfhost")
    const { code } = await openWaiting(host)
    const res = await postJson(`/api/room/${code}/knock`, {}, host)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "cannot_knock" })
  })

  it("rate-limits a knocker who keeps hammering the door", async () => {
    const host = await register("pesthost")
    const pest = await register("pest")
    const { code } = await openWaiting(host)
    let limited = false
    for (let i = 0; i < 8; i++) {
      const res = await postJson(`/api/room/${code}/knock`, {}, pest)
      if (res.status === 429) {
        limited = true
        break
      }
      expect(res.status).toBe(200)
    }
    expect(limited).toBe(true)
  })

  it("closing a WAITING room refuses the knocker at the door", async () => {
    const host = await register("clhost")
    const guest = await register("clguest")
    const { code } = await openWaiting(host)
    await postJson(`/api/room/${code}/knock`, {}, guest)

    // «أغلق الغرفة» — resign on a waiting room ends it and clears the knock.
    const closed = await postJson(`/api/room/${code}/resign`, {}, host)
    expect(closed.status).toBe(200)
    const st = RoomStateResponseSchema.parse(await closed.json()).state
    expect(st.status).toBe("done")

    const poll = RoomKnockResponseSchema.parse(await (await req(`/api/room/${code}/knock`, {}, guest)).json()).knock
    expect(poll.status).toBe("rejected")
  })
})

describe("bearerFromSubprotocol", () => {
  it("reads the token off a `qarid.bearer.<token>` offer", () => {
    expect(bearerFromSubprotocol("qarid.bearer.tok_abc-123")).toBe("tok_abc-123")
  })

  it("picks ours out of a multi-value offer and ignores the rest", () => {
    expect(bearerFromSubprotocol("something, qarid.bearer.XYZ, other")).toBe("XYZ")
  })

  it("is null for a header that carries no bearer of ours", () => {
    expect(bearerFromSubprotocol(undefined)).toBeNull()
    expect(bearerFromSubprotocol("chat, superchat")).toBeNull()
    expect(bearerFromSubprotocol("qarid.bearer.")).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Stale-room cleanup
// ═════════════════════════════════════════════════════════════════════════════

describe("purgeStaleRooms", () => {
  it("removes old waiting/done rooms, keeps active and recent ones, and cascades", () => {
    const u = openUsersDb(tempUsersPath("purge"))
    try {
      const now = Date.now()
      const owner = createUser(u, { username: "purgeowner", displayName: "purge", passHash: "x", now })!

      // insert a room with a controlled updated_at and return its id
      const insert = (code: string, status: string, updatedAt: number): number => {
        u.q(
          `INSERT INTO rooms (code, host_user_id, starting_bait_id, mode, strikes, status, created_at, updated_at, join_key)
           VALUES (?, ?, 1, 'rhyme', 3, ?, ?, ?, 'k')`,
        ).run(code, owner.id, status, updatedAt, updatedAt)
        return Number((u.q("SELECT last_insert_rowid() AS id").get() as { id: number }).id)
      }

      const staleWaiting = insert("STALEW", "waiting", now - WAITING_ROOM_TTL_MS - 1000)
      const freshWaiting = insert("FRESHW", "waiting", now - 60_000)
      const staleDone = insert("STALED", "done", now - DONE_ROOM_TTL_MS - 1000)
      const freshDone = insert("FRESHD", "done", now - 60_000)
      const oldActive = insert("ACTIVE", "active", now - DONE_ROOM_TTL_MS - 1000)

      // a knock hanging off the stale waiting room — it must cascade away
      u.q("INSERT INTO room_knocks (room_id, user_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)").run(
        staleWaiting,
        owner.id,
        now,
        now,
      )

      const removed = purgeStaleRooms(u, now)
      expect(removed).toBe(2)

      const alive = (id: number) => u.q("SELECT 1 AS ok FROM rooms WHERE id = ?").get(id) !== undefined
      expect(alive(staleWaiting)).toBe(false)
      expect(alive(staleDone)).toBe(false)
      expect(alive(freshWaiting)).toBe(true)
      expect(alive(freshDone)).toBe(true)
      // An active room is never purged, however old its last update.
      expect(alive(oldActive)).toBe(true)

      // the knock went with its room (ON DELETE CASCADE)
      const knocks = u.q("SELECT COUNT(*) AS n FROM room_knocks WHERE room_id = ?").get(staleWaiting) as { n: number }
      expect(Number(knocks.n)).toBe(0)
    } finally {
      u.close()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The WebSocket, against a real listening server
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `new WebSocket(url, { headers })` is node's own extension to the WHATWG
 * constructor (undici), and it is the only way to present a session cookie on
 * an upgrade — a browser sends it by itself, a test has to say it. The DOM lib
 * types the second parameter as a protocol list, hence the cast.
 */
function connect(code: string, token: string, key?: string | null): WebSocket {
  const url = `ws://127.0.0.1:${wsPort}/ws/room/${code}${key ? `?k=${encodeURIComponent(key)}` : ""}`
  return new WebSocket(url, {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  } as unknown as string[])
}

/** The next event of a given type, with a deadline so a hang is a failure. */
function nextEvent(ws: WebSocket, type: RoomEvent["type"] | null = null, ms = 4000): Promise<RoomEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage)
      reject(new Error(`timed out waiting for a ${type ?? "any"} event`))
    }, ms)
    function onMessage(evt: MessageEvent) {
      const parsed = RoomEventSchema.safeParse(JSON.parse(String(evt.data)))
      if (!parsed.success) return
      if (type !== null && parsed.data.type !== type) return
      clearTimeout(timer)
      ws.removeEventListener("message", onMessage)
      resolve(parsed.data)
    }
    ws.addEventListener("message", onMessage)
  })
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true })
  })
}

describe("/ws/room/:code", () => {
  let server: ServerType
  let wsDb: Db
  let wsUsers: UsersDb
  let wsApp: Hono

  beforeAll(async () => {
    await ensureFixtureDb()
    wsDb = openDb(FIXTURE_DB)
    wsUsers = openUsersDb(tempUsersPath("ws"))
    const wsConfig = loadConfig({ HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test" } as NodeJS.ProcessEnv)
    const built = createApp(wsConfig, wsDb, wsUsers)
    wsApp = built.app
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: wsApp.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s))
    })
    built.injectWebSocket(server)
    const addr = server.address()
    wsPort = typeof addr === "object" && addr !== null ? addr.port : 0
    expect(wsPort).toBeGreaterThan(0)
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    wsDb?.close()
    wsUsers?.close()
  })

  /** The HTTP surface of the SECOND app, for creating and joining rooms. */
  async function wsPost(pathname: string, body: unknown, who?: Player): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (who) {
      headers.Cookie = `${SESSION_COOKIE}=${who.token}`
      headers["CF-Connecting-IP"] = who.ip
    }
    return wsApp.request(pathname, { method: "POST", headers, body: JSON.stringify(body) })
  }

  async function wsRegister(name: string): Promise<Player> {
    return player(name, wsUsers)
  }

  it("closes an upgrade that carries no session", async () => {
    const host = await wsRegister("solo")
    const created = RoomStateResponseSchema.parse(await (await wsPost("/api/room", {}, host)).json()).state
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws/room/${created.code}`)
    await opened(ws)
    const evt = await nextEvent(ws, "error")
    expect(evt).toMatchObject({ type: "error", code: "unauthenticated" })
    ws.close()
  })

  // The native room-socket fix: a WebView cannot set a header on an upgrade, so
  // its ONLY credential is the `Sec-WebSocket-Protocol` subprotocol. The token
  // rides in `qarid.bearer.<token>` and the server authenticates the same
  // sessionUser/hashToken path off it (additive; the cookie/header still work).
  it("authenticates an upgrade whose only credential is the bearer subprotocol", async () => {
    const host = await wsRegister("subgood")
    const created = RoomStateResponseSchema.parse(await (await wsPost("/api/room", { baitId: 1 }, host)).json()).state
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws/room/${created.code}`, [`qarid.bearer.${host.token}`])
    await opened(ws)
    const hello = await nextEvent(ws, "state")
    expect(hello.type === "state" && hello.state.you.role).toBe("host")
    ws.close()
  })

  it("refuses a bad bearer subprotocol and closes the socket", async () => {
    const host = await wsRegister("subbad")
    const created = RoomStateResponseSchema.parse(await (await wsPost("/api/room", { baitId: 1 }, host)).json()).state
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws/room/${created.code}`, ["qarid.bearer.not-a-real-token"])
    await opened(ws)
    const evt = await nextEvent(ws, "error")
    expect(evt).toMatchObject({ type: "error", code: "unauthenticated" })
    ws.close()
  })

  it("still separately requires the join_key — a subprotocol authenticates, it does not admit", async () => {
    const host = await wsRegister("subhost")
    const watcher = await wsRegister("subwatch")
    const created = RoomStateResponseSchema.parse(await (await wsPost("/api/room", { baitId: 1 }, host)).json()).state
    // A valid session over the subprotocol, but a non-player with no key: the
    // room gate is untouched, so the socket is refused `needs_key`.
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws/room/${created.code}`, [`qarid.bearer.${watcher.token}`])
    await opened(ws)
    const evt = await nextEvent(ws, "error")
    expect(evt).toMatchObject({ type: "error", code: "needs_key" })
    ws.close()
  })

  it("plays a whole match over two sockets, replays state on reconnect, and ends on رجعة", async () => {
    const host = await wsRegister("hostws")
    const guest = await wsRegister("guestws")
    const watcher = await wsRegister("watchws")
    const created = RoomStateResponseSchema.parse(
      await (await wsPost("/api/room", { baitId: 1 }, host)).json(),
    ).state
    const code = created.code

    const hostWs = connect(code, host.token)
    await opened(hostWs)
    const hello = await nextEvent(hostWs, "state")
    expect(hello.type === "state" && hello.state.status).toBe("waiting")

    // The guest joins over HTTP; the host's socket learns it without asking.
    // He opens the socket with the invite, because until he has actually sat
    // down he is a visitor holding a link like any other.
    const guestWs = connect(code, guest.token, created.joinKey)
    await opened(guestWs)
    await nextEvent(guestWs, "state")
    const joinSeen = nextEvent(hostWs, "join")
    await wsPost(`/api/room/${code}/join`, { key: created.joinKey }, guest)
    const joined = await joinSeen
    expect(joined.type === "join" && joined.state.status).toBe("active")
    expect(joined.type === "join" && joined.username).toBe(guest.username)

    // A spectator sees the room read-only, and is told about every بيت.
    const watchWs = connect(code, watcher.token, created.joinKey)
    await opened(watchWs)
    const watched = await nextEvent(watchWs, "state")
    expect(watched.type === "state" && watched.state.you.role).toBe("spectator")

    // ── the guest answers over the SOCKET ────────────────────────────────
    let live = joined.type === "join" ? joined.state : created
    const letter = live.required!.requiredLetter
    const used = new Set(live.turns.map((t) => t.bait!.id))
    const usedPoems = new Set(live.turns.map((t) => t.bait!.poem.poemId))
    const candidate = (() => {
      const rows = wsDb
        .q(
          `SELECT gb.bait_id AS id, gb.poem_id AS poem_id, b.sadr AS sadr, b.ajuz AS ajuz
           FROM game_baits gb JOIN baits b ON b.id = gb.bait_id
           WHERE gb.first_letter = ? AND b.ajuz IS NOT NULL ORDER BY gb.fame DESC LIMIT 10`,
        )
        .all(letter) as Array<Record<string, unknown>>
      const row = rows.find((r) => !used.has(Number(r.id)) && !usedPoems.has(Number(r.poem_id)))
      if (!row) throw new Error("fixture has no candidate for the socket test")
      return `${String(row.sadr)} ${String(row.ajuz)}`
    })()

    const hostSees = nextEvent(hostWs, "turn")
    const watcherSees = nextEvent(watchWs, "turn")
    const verdict = nextEvent(guestWs, "verdict")
    guestWs.send(JSON.stringify({ type: "turn", text: candidate }))
    const said = await verdict
    expect(said.type === "verdict" && said.verdict.result.ok).toBe(true)
    const broadcast = await hostSees
    expect(broadcast.type === "turn" && broadcast.state.turns).toHaveLength(2)
    expect(broadcast.type === "turn" && broadcast.state.you.canPlay).toBe(true)
    const alsoWatched = await watcherSees
    expect(alsoWatched.type === "turn" && alsoWatched.state.you.canPlay).toBe(false)

    // ── reconnect mid-turn: the whole room comes back, nothing is forfeit ──
    guestWs.close()
    await new Promise((r) => setTimeout(r, 80))
    const back = connect(code, guest.token)
    await opened(back)
    const replay = await nextEvent(back, "state")
    expect(replay.type === "state" && replay.state.status).toBe("active")
    expect(replay.type === "state" && replay.state.turns).toHaveLength(2)
    expect(replay.type === "state" && replay.state.turnSeat).toBe("host")
    expect(replay.type === "state" && replay.state.you.role).toBe("guest")

    // ── the host resigns; both live sockets are told ─────────────────────
    const guestEnd = nextEvent(back, "end")
    await wsPost(`/api/room/${code}/resign`, {}, host)
    const ended = await guestEnd
    expect(ended.type === "end" && ended.state.status).toBe("done")
    expect(ended.type === "end" && ended.state.winner).toBe(guest.username)

    // ── رجعة: the news reaches the socket that is still open ─────────────
    const rematchSeen = nextEvent(back, "rematch")
    await wsPost(`/api/room/${code}/rematch`, {}, host)
    const rematch = await rematchSeen
    expect(rematch.type === "rematch" && rematch.code).toMatch(/^[A-Z]{6}$/)
    expect(rematch.type === "rematch" && rematch.state.rematchCode).toBe(rematch.type === "rematch" ? rematch.code : "")

    hostWs.close()
    watchWs.close()
    back.close()
  }, 30_000)

  it("stops answering a socket whose session was deleted under it", async () => {
    // README §Accounts makes deleting a session row the ONLY remediation this
    // system offers, and the socket used to resolve its user once, at the
    // upgrade, and close over the answer for the life of the connection: a
    // logout 401'd every HTTP route and the tab kept playing.
    const host = await wsRegister("hostrev")
    const guest = await wsRegister("guestrev")
    const created = RoomStateResponseSchema.parse(await (await wsPost("/api/room", {}, host)).json()).state
    await wsPost(`/api/room/${created.code}/join`, { key: created.joinKey }, guest)

    const ws = connect(created.code, guest.token)
    await opened(ws)
    await nextEvent(ws, "state")

    // Exactly what `POST /api/auth/logout` does.
    deleteSession(wsUsers, hashToken(guest.token))
    const denied = await wsApp.request(`/api/room/${created.code}/state`, {
      headers: { Cookie: `${SESSION_COOKIE}=${guest.token}`, "CF-Connecting-IP": guest.ip },
    })
    expect(denied.status).toBe(401)

    const refusal = nextEvent(ws, "error")
    ws.send(JSON.stringify({ type: "turn", text: "قفا نبك من ذكرى حبيب ومنزل" }))
    expect(await refusal).toMatchObject({ type: "error", code: "unauthenticated" })
    ws.close()
  }, 20_000)

  it("caps the sockets one account may hold on one room", async () => {
    // There was no cap of any kind, and `onOpen` broadcast a full snapshot to
    // everyone already attached — so attaching N sockets cost N(N+1)/2
    // snapshots (600 of them fanned out 1,312 MB on the real artefact) while
    // both players read «1 مشاهد», because spectators dedupe by user id.
    const host = await wsRegister("hostcap")
    const created = RoomStateResponseSchema.parse(await (await wsPost("/api/room", {}, host)).json()).state

    const open: WebSocket[] = []
    for (let i = 0; i < MAX_SOCKETS_PER_USER; i++) {
      const ws = connect(created.code, host.token)
      await opened(ws)
      await nextEvent(ws, "state")
      open.push(ws)
    }
    const extra = connect(created.code, host.token)
    await opened(extra)
    expect(await nextEvent(extra, "error")).toMatchObject({ type: "error", code: "too_many_sockets" })
    extra.close()
    for (const ws of open) ws.close()
  }, 30_000)

  it("charges a `state` frame to a bucket, so a socket cannot amplify itself", async () => {
    // One socket sent 5,000 `{"type":"state"}` frames (80 KB in) and got 5,000
    // full snapshots back — 36 MB out — because the 250 ms gap guarded only
    // `turn`. The bucket is keyed on the USER, not on the socket: a per-socket
    // counter is defeated by opening a second socket.
    const host = await wsRegister("hostflood")
    const created = RoomStateResponseSchema.parse(await (await wsPost("/api/room", {}, host)).json()).state
    const ws = connect(created.code, host.token)
    await opened(ws)
    await nextEvent(ws, "state")

    const seen: string[] = []
    ws.addEventListener("message", (evt: MessageEvent) => {
      const parsed = RoomEventSchema.safeParse(JSON.parse(String(evt.data)))
      if (parsed.success) seen.push(parsed.data.type === "error" ? `error:${parsed.data.code}` : parsed.data.type)
    })
    for (let i = 0; i < SOCKET_FRAME_LIMIT.tokens + 6; i++) ws.send(JSON.stringify({ type: "state" }))
    await new Promise((r) => setTimeout(r, 400))
    expect(seen).toContain("error:too_fast")
    expect(seen.filter((t) => t === "state").length).toBeLessThanOrEqual(SOCKET_FRAME_LIMIT.tokens)
    ws.close()
  }, 20_000)

  it("refuses a بيت from a spectator's socket and a second one inside the throttle", async () => {
    const host = await wsRegister("hostb")
    const guest = await wsRegister("guestb")
    const watcher = await wsRegister("watchb")
    const created = RoomStateResponseSchema.parse(await (await wsPost("/api/room", {}, host)).json()).state
    await wsPost(`/api/room/${created.code}/join`, { key: created.joinKey }, guest)

    const watchWs = connect(created.code, watcher.token, created.joinKey)
    await opened(watchWs)
    await nextEvent(watchWs, "state")
    const refused = nextEvent(watchWs, "error")
    watchWs.send(JSON.stringify({ type: "turn", text: "قفا نبك من ذكرى حبيب ومنزل" }))
    expect((await refused).type === "error" && (await refused as { code: string }).code).toBeTruthy()
    watchWs.close()

    const guestWs = connect(created.code, guest.token, created.joinKey)
    await opened(guestWs)
    await nextEvent(guestWs, "state")
    guestWs.send(JSON.stringify({ type: "turn", text: "زقفونة برجلة مهملة لا وجود لها" }))
    await nextEvent(guestWs, "verdict")
    const tooFast = nextEvent(guestWs, "error")
    guestWs.send(JSON.stringify({ type: "turn", text: "زقفونة برجلة مهملة لا وجود لها" }))
    expect((await tooFast).type).toBe("error")
    guestWs.close()
  }, 20_000)
})
