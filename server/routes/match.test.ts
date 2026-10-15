/**
 * `/api/match/*`, in process: the real app, the real fixture corpus, the real
 * verifier. Each test speaks from its own address so the per-IP buckets of
 * one test never spend another's.
 */
import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import type { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  MATCH_SEAT_HEADER,
  MatchCreateResponseSchema,
  MatchJoinResponseSchema,
  MatchKnockResponseSchema,
  MatchStateResponseSchema,
  MatchTurnResponseSchema,
  type MatchState,
} from "../../shared/match.ts"
import { FIXTURE_DB, REPO_ROOT, ensureFixtureDb } from "../../test/fixtureDb.ts"
import { candidatesOn, selfRhymingOpening, unknownOn, wrongLetterFor } from "../../test/matchKit.ts"
import { createApp } from "../app.ts"
import { loadConfig, type Config } from "../config.ts"
import { openDb, type Db } from "../db.ts"
import { DONE_TTL_MS, WAITING_TTL_MS } from "../match/machine.ts"
import { armMatch, matchDeps, sweepMatches, type MatchDeps } from "../match/service.ts"
import type { MatchEvent } from "../../shared/match.ts"
import { memoryMatchStore, sqliteMatchStore } from "../match/store.ts"
import { matchRoutes } from "./match.ts"

let db: Db
let config: Config
let app: Hono
const TEMP: string[] = []

beforeAll(async () => {
  await ensureFixtureDb()
  db = openDb(FIXTURE_DB)
  config = loadConfig({ HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test", PUBLIC_ORIGIN: "https://qarid.example" } as NodeJS.ProcessEnv)
  app = createApp(config, db).app
}, 120_000)

afterAll(() => {
  db?.close()
  for (const p of TEMP) for (const s of ["", "-wal", "-shm"]) fs.rmSync(p + s, { force: true })
})

let ipSeq = 0
/** A client: one address, optionally one seat. */
function client(target: { request: Hono["request"] } = app) {
  const ip = `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`
  const call = (method: string, pathname: string, body?: unknown, secret?: string, extra: Record<string, string> = {}) =>
    target.request(pathname, {
      method,
      headers: {
        "CF-Connecting-IP": ip,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(secret ? { [MATCH_SEAT_HEADER]: secret } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    get: (p: string, secret?: string) => call("GET", p, undefined, secret),
    post: (p: string, body: unknown = {}, secret?: string, extra?: Record<string, string>) => call("POST", p, body, secret, extra),
  }
}

async function created(c = client(), body: Record<string, unknown> = {}) {
  const res = await c.post("/api/match", { name: "لبيد", baitId: selfRhymingOpening(db).id, ...body })
  expect(res.status).toBe(201)
  return MatchCreateResponseSchema.parse(await res.json())
}

async function startedMatch(body: Record<string, unknown> = {}) {
  const host = client()
  const guest = client()
  const made = await created(host, body)
  const res = await guest.post(`/api/match/${made.state.code}/join`, { key: made.joinKey, name: "عنترة" })
  expect(res.status).toBe(200)
  const joined = MatchJoinResponseSchema.parse(await res.json())
  return { host, guest, code: made.state.code, hostSecret: made.secret, guestSecret: joined.secret, state: joined.state }
}

async function playValid(c: ReturnType<typeof client>, code: string, secret: string, state: MatchState): Promise<MatchState> {
  for (const text of candidatesOn(db, state.required!.requiredLetter, state)) {
    const res = await c.post(`/api/match/${code}/turn`, { text }, secret)
    expect(res.status).toBe(200)
    const out = MatchTurnResponseSchema.parse(await res.json())
    if (out.verdict.result.ok) return out.state
    expect(out.verdict.strike).toBe(false)
  }
  throw new Error("no legal بيت in the fixture")
}

describe("create", () => {
  it("hands the host a seat secret and an invite, and stores neither", async () => {
    const made = await created()
    expect(made.secret).toMatch(/^[a-km-np-z2-9]{26}$/)
    expect(made.joinKey).toMatch(/^[a-km-np-z2-9]{24}$/)
    expect(made.secret).not.toBe(made.joinKey)
    expect(made.shareUrl).toBe(`https://qarid.example/#/match/${made.state.code}?k=${made.joinKey}`)
    expect(made.state).toMatchObject({ status: "waiting", you: { seat: "host", canPlay: false }, guest: null })
    expect(made.state.host.name).toBe("لبيد")
    expect(made.state.turns[0]?.verdict).toBe("opening")
    expect(made.state.code).toMatch(/^[A-Z]{6}$/)
  })

  it("draws an opening when none is named, and refuses one that cannot open", async () => {
    const res = await client().post("/api/match", { mode: "literal", timerS: 30, strikes: 1 })
    expect(res.status).toBe(201)
    const made = MatchCreateResponseSchema.parse(await res.json())
    expect(made.state).toMatchObject({ mode: "literal", timerS: 30, strikes: 1 })
    expect((await client().post("/api/match", { baitId: 999_999_999 })).status).toBe(400)
    expect((await client().post("/api/match", { timerS: 45 })).status).toBe(400)
    expect((await client().post("/api/match", { strikes: 9 })).status).toBe(400)
  })

  it("caps the name, and normalizes it", async () => {
    const made = await created(client(), { name: "  ‮أبو   تمّام" + "ـ".repeat(60) })
    expect(Array.from(made.state.host.name!).length).toBeLessThanOrEqual(24)
    expect(made.state.host.name!.startsWith("أبو تمّام")).toBe(true)
  })
})

describe("seats", () => {
  it("reads the match only with a seat secret", async () => {
    const made = await created()
    const c = client()
    const url = `/api/match/${made.state.code}/state`
    expect((await c.get(url)).status).toBe(403)
    expect((await c.get(url, "a".repeat(26))).status).toBe(403)
    expect((await c.get(url, made.joinKey)).status).toBe(403)
    const ok = await c.get(url, made.secret)
    expect(ok.status).toBe(200)
    expect(ok.headers.get("cache-control")).toBe("private, no-store")
    expect(MatchStateResponseSchema.parse(await ok.json()).state.you.seat).toBe("host")
    expect((await c.get(`/api/match/ZZZZZZ/state`, made.secret)).status).toBe(404)
    expect((await c.get(`/api/match/nope1/state`, made.secret)).status).toBe(404)
  })

  it("seats the guest with the invite, once", async () => {
    const made = await created()
    const code = made.state.code
    const bad = await client().post(`/api/match/${code}/join`, { key: "b".repeat(24) })
    expect(bad.status).toBe(403)
    expect((await bad.json()).error).toBe("needs_key")
    const { state, secret } = MatchJoinResponseSchema.parse(
      await (await client().post(`/api/match/${code}/join`, { key: made.joinKey, name: "عنترة" })).json(),
    )
    expect(state).toMatchObject({ status: "active", you: { seat: "guest", canPlay: true }, turnSeat: "guest" })
    expect(state.deadlineAt).toBe(null)
    expect(secret).not.toBe(made.secret)
    const again = await client().post(`/api/match/${code}/join`, { key: made.joinKey })
    expect(again.status).toBe(409)
    expect((await again.json()).error).toBe("match_full")
  })

  it("lets a voice-only guest knock, and the host admit him", async () => {
    const made = await created()
    const code = made.state.code
    const knocker = client()
    const k = MatchKnockResponseSchema.parse(await (await knocker.post(`/api/match/${code}/knock`, { name: "طرفة" })).json())
    expect(k.knock).toMatchObject({ status: "pending", hostName: "لبيد" })
    const secret = k.secret!
    // He is not a player yet: the match itself stays closed to him.
    expect((await knocker.get(`/api/match/${code}/state`, secret)).status).toBe(403)
    expect((await client().post(`/api/match/${code}/knock`, {})).status).toBe(409)

    const hostView = MatchStateResponseSchema.parse(await (await client().get(`/api/match/${code}/state`, made.secret)).json())
    expect(hostView.state.knock).toEqual({ name: "طرفة" })
    expect((await knocker.post(`/api/match/${code}/admit`, {}, secret)).status).toBe(403)

    const admitted = await client().post(`/api/match/${code}/admit`, {}, made.secret)
    expect(admitted.status).toBe(200)
    expect(MatchStateResponseSchema.parse(await admitted.json()).state.status).toBe("active")
    const status = MatchKnockResponseSchema.parse(await (await knocker.get(`/api/match/${code}/knock`, secret)).json())
    expect(status.knock.status).toBe("accepted")
    const mine = MatchStateResponseSchema.parse(await (await knocker.get(`/api/match/${code}/state`, secret)).json())
    expect(mine.state.you).toEqual({ seat: "guest", canPlay: true })
    expect(mine.state.guest?.name).toBe("طرفة")
  })

  it("tells a refused knocker so", async () => {
    const made = await created()
    const code = made.state.code
    const k = MatchKnockResponseSchema.parse(await (await client().post(`/api/match/${code}/knock`, {})).json())
    expect((await client().post(`/api/match/${code}/refuse`, {}, made.secret)).status).toBe(200)
    const status = MatchKnockResponseSchema.parse(await (await client().get(`/api/match/${code}/knock`, k.secret)).json())
    expect(status.knock.status).toBe("rejected")
  })
})

describe("rules", () => {
  it("refuses out of turn and a wrong secret", async () => {
    const m = await startedMatch()
    const text = candidatesOn(db, m.state.required!.requiredLetter, m.state)[0]!
    const early = await m.host.post(`/api/match/${m.code}/turn`, { text }, m.hostSecret)
    expect(early.status).toBe(409)
    const body = await early.json()
    expect(body.error).toBe("not_your_turn")
    expect(body.state.you.seat).toBe("host")
    expect((await m.guest.post(`/api/match/${m.code}/turn`, { text }, "z".repeat(26))).status).toBe(403)
    expect((await m.guest.post(`/api/match/${m.code}/turn`, { text })).status).toBe(403)
  })

  it("a repeat is refused softly; a wrong letter and an unknown بيت are strikes", async () => {
    const m = await startedMatch({ strikes: 3 })
    const letter = m.state.required!.requiredLetter
    const turn = (text: string) => m.guest.post(`/api/match/${m.code}/turn`, { text }, m.guestSecret)

    const repeat = MatchTurnResponseSchema.parse(await (await turn(selfRhymingOpening(db).text)).json())
    expect(repeat.verdict).toMatchObject({ strike: false, strikesLeft: 3, result: { ok: false, reason: "already_used" } })
    expect(repeat.state.turns).toHaveLength(1)

    const wrong = MatchTurnResponseSchema.parse(await (await turn(wrongLetterFor(letter))).json())
    expect(wrong.verdict).toMatchObject({ strike: true, strikesLeft: 2, result: { ok: false, reason: "wrong_letter" } })
    expect(wrong.state.turnSeat).toBe("guest")

    const unknown = MatchTurnResponseSchema.parse(await (await turn(unknownOn(letter))).json())
    expect(unknown.verdict).toMatchObject({ strike: true, strikesLeft: 1, result: { ok: false, reason: "not_found" } })
    expect(unknown.state.guest?.strikes).toBe(2)

    // The host sees the misses in the transcript, never the verdict detail.
    const hostView = MatchStateResponseSchema.parse(await (await m.host.get(`/api/match/${m.code}/state`, m.hostSecret)).json())
    expect(hostView.state.turns.map((t) => t.verdict)).toEqual(["opening", "wrong_letter", "not_found"])
  })

  it("passes the turn on a legal بيت and ends on the last strike", async () => {
    const m = await startedMatch({ strikes: 1 })
    const after = await playValid(m.guest, m.code, m.guestSecret, m.state)
    expect(after).toMatchObject({ turnSeat: "host", you: { canPlay: false } })
    expect(after.guest?.turns).toBe(1)
    const res = await m.host.post(`/api/match/${m.code}/turn`, { text: wrongLetterFor(after.required!.requiredLetter) }, m.hostSecret)
    const out = MatchTurnResponseSchema.parse(await res.json())
    expect(out.state).toMatchObject({ status: "done", winner: "guest", endReason: "strikes" })
    const late = await m.guest.post(`/api/match/${m.code}/turn`, { text: "أي شيء هنا" }, m.guestSecret)
    expect(late.status).toBe(409)
  })

  it("resign hands the match over; closing a waiting match is the host's", async () => {
    const m = await startedMatch()
    const res = await m.guest.post(`/api/match/${m.code}/resign`, {}, m.guestSecret)
    expect(MatchStateResponseSchema.parse(await res.json()).state).toMatchObject({ status: "done", winner: "host", endReason: "resign" })
    const made = await created()
    const closed = await client().post(`/api/match/${made.state.code}/resign`, {}, made.secret)
    expect(MatchStateResponseSchema.parse(await closed.json()).state).toMatchObject({ status: "done", winner: null })
  })
})

describe("the door", () => {
  it("refuses a cross-site write and an oversized body", async () => {
    const forged = await client().post("/api/match", {}, undefined, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })
    expect(forged.status).toBe(403)
    const big = await client().post("/api/match", { name: "x".repeat(20_000) })
    expect(big.status).toBe(413)
  })

  it("limits creation per address", async () => {
    const c = client()
    const codes: number[] = []
    for (let i = 0; i < 11; i++) codes.push((await c.post("/api/match", {})).status)
    expect(codes.slice(0, 10).every((s) => s === 201)).toBe(true)
    expect(codes[10]).toBe(429)
  })
})

describe("time and restarts", () => {
  function clocked(store = memoryMatchStore()) {
    let now = 5_000_000
    const deps: MatchDeps = matchDeps(db, config, store, { now: () => now, sweep: false })
    const routes = matchRoutes(deps)
    return { deps, routes, tick: (ms: number) => (now += ms), stop: () => deps.stop() }
  }

  it("a turn past its deadline is lost on the next read", async () => {
    const t = clocked()
    const host = client(t.routes)
    const made = MatchCreateResponseSchema.parse(await (await host.post("/", { timerS: 30, baitId: selfRhymingOpening(db).id })).json())
    const code = made.state.code
    const joined = MatchJoinResponseSchema.parse(await (await client(t.routes).post(`/${code}/join`, { key: made.joinKey })).json())
    expect(joined.state.deadlineAt).toBe(joined.state.serverNow + 30_000)
    t.tick(29_999)
    expect(MatchStateResponseSchema.parse(await (await host.get(`/${code}/state`, made.secret)).json()).state.status).toBe("active")
    t.tick(1)
    const after = MatchStateResponseSchema.parse(await (await host.get(`/${code}/state`, made.secret)).json()).state
    expect(after).toMatchObject({ status: "done", winner: "host", endReason: "timeout" })
    t.stop()
  })

  it("the timer ends an expired turn with nobody asking, and tells the sockets", async () => {
    const store = memoryMatchStore()
    const t = clocked(store)
    const made = MatchCreateResponseSchema.parse(await (await client(t.routes).post("/", { timerS: 30 })).json())
    const code = made.state.code
    await client(t.routes).post(`/${code}/join`, { key: made.joinKey })
    const heard: MatchEvent[] = []
    t.deps.hub.add(code, { seat: "host", send: (e) => heard.push(e) })
    t.tick(30_000)
    armMatch(t.deps, store.get(code)!)
    await new Promise((r) => setTimeout(r, 120))
    expect(store.get(code)).toMatchObject({ status: "done", endReason: "timeout", winner: "host" })
    expect(heard.some((e) => e.type === "end")).toBe(true)
    t.stop()
  })

  it("a waiting match expires, and a finished one is purged by the sweep", async () => {
    const store = memoryMatchStore()
    const t = clocked(store)
    const host = client(t.routes)
    const made = MatchCreateResponseSchema.parse(await (await host.post("/", {})).json())
    const code = made.state.code
    t.tick(WAITING_TTL_MS)
    sweepMatches(t.deps)
    expect(store.get(code)?.status).toBe("done")
    const late = await client(t.routes).post(`/${code}/join`, { key: made.joinKey })
    expect((await late.json()).error).toBe("match_not_active")
    t.tick(DONE_TTL_MS)
    sweepMatches(t.deps)
    expect(store.get(code)).toBeNull()
    expect((await host.get(`/${code}/state`, made.secret)).status).toBe(404)
    t.stop()
  })

  it("a live match survives a restart on the SQLite store", async () => {
    const file = path.join(REPO_ROOT, "data", `matches-test-${process.pid}-${randomBytes(4).toString("hex")}.db`)
    TEMP.push(file)
    const first = createApp(config, db, null, { matchStore: sqliteMatchStore(file) }).app
    const made = await created(client(first))
    const joined = MatchJoinResponseSchema.parse(
      await (await client(first).post(`/api/match/${made.state.code}/join`, { key: made.joinKey })).json(),
    )
    const played = await playValid(client(first), made.state.code, joined.secret, joined.state)

    const second = createApp(config, db, null, { matchStore: sqliteMatchStore(file) }).app
    const res = await client(second).get(`/api/match/${made.state.code}/state`, made.secret)
    expect(res.status).toBe(200)
    const state = MatchStateResponseSchema.parse(await res.json()).state
    expect(state.turns).toEqual(played.turns)
    expect(state).toMatchObject({ status: "active", turnSeat: "host", you: { seat: "host", canPlay: true } })
    // Only digests are written: neither file of the store holds a secret.
    for (const f of [file, `${file}-wal`]) {
      if (fs.existsSync(f)) expect(fs.readFileSync(f).includes(Buffer.from(made.secret))).toBe(false)
    }
  })
})
