/**
 * The account-less مساجلة over a real socket: a real HTTP server on an
 * ephemeral port, the fixture corpus, and two Node clients (global `fetch` and
 * `WebSocket`, no browser) that create, join and play a match to its end —
 * one of them dropping its socket mid-match and coming back.
 */
import { serve, type ServerType } from "@hono/node-server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  MATCH_SEAT_HEADER,
  MATCH_WS_SEAT_PREFIX,
  MatchCreateResponseSchema,
  MatchEventSchema,
  MatchJoinResponseSchema,
  MatchStateResponseSchema,
  type MatchEvent,
  type MatchState,
} from "../shared/match.ts"
import { createApp } from "../server/app.ts"
import { loadConfig } from "../server/config.ts"
import { openDb, type Db } from "../server/db.ts"
import { FIXTURE_DB, ensureFixtureDb } from "./fixtureDb.ts"
import { candidatesOn, selfRhymingOpening, wrongLetterFor } from "./matchKit.ts"

let server: ServerType
let db: Db
let base = ""
let wsBase = ""

beforeAll(async () => {
  await ensureFixtureDb()
  db = openDb(FIXTURE_DB)
  const config = loadConfig({ HOST: "127.0.0.1", PORT: "0", NODE_ENV: "test" } as NodeJS.ProcessEnv)
  const built = createApp(config, db)
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: built.app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s))
  })
  built.injectWebSocket(server)
  const addr = server.address()
  const port = typeof addr === "object" && addr !== null ? addr.port : 0
  expect(port).toBeGreaterThan(0)
  base = `http://127.0.0.1:${port}`
  wsBase = `ws://127.0.0.1:${port}`
}, 120_000)

afterAll(async () => {
  ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db?.close()
})

/** Every frame a socket receives, kept in order so no event slips between awaits. */
class Inbox {
  private seen: MatchEvent[] = []
  private waiters: Array<{ pred: (e: MatchEvent) => boolean; resolve: (e: MatchEvent) => void }> = []
  readonly ws: WebSocket

  constructor(code: string, secret: string) {
    this.ws = new WebSocket(`${wsBase}/ws/match/${code}`, [`${MATCH_WS_SEAT_PREFIX}${secret}`])
    this.ws.addEventListener("message", (evt) => {
      const parsed = MatchEventSchema.safeParse(JSON.parse(String(evt.data)))
      if (!parsed.success) return
      const w = this.waiters.find((x) => x.pred(parsed.data))
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        w.resolve(parsed.data)
      } else this.seen.push(parsed.data)
    })
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve()
      this.ws.addEventListener("open", () => resolve(), { once: true })
      this.ws.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true })
    })
  }

  closed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve()
      this.ws.addEventListener("close", () => resolve(), { once: true })
    })
  }

  /** The first event (already received or still to come) that satisfies `pred`. */
  next(pred: (e: MatchEvent) => boolean, ms = 5000): Promise<MatchEvent> {
    const i = this.seen.findIndex(pred)
    if (i >= 0) return Promise.resolve(this.seen.splice(i, 1)[0]!)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for an event")), ms)
      this.waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(timer)
          resolve(e)
        },
      })
    })
  }

  /** The snapshot with this rev or later. */
  async stateAt(rev: number): Promise<MatchState> {
    const e = await this.next((x) => x.type !== "error" && x.state.rev >= rev)
    if (e.type === "error") throw new Error(e.code)
    return e.state
  }

  send(cmd: unknown): void {
    this.ws.send(JSON.stringify(cmd))
  }
}

async function post(pathname: string, body: unknown, secret?: string): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { [MATCH_SEAT_HEADER]: secret } : {}) },
    body: JSON.stringify(body),
  })
}

/** A socket's turns are at least 250 ms apart; a person is slower than that anyway. */
const pause = () => new Promise((r) => setTimeout(r, 260))

/** A legal بيت for whoever owes one, sent over that seat's socket. */
async function playOverSocket(inbox: Inbox, state: MatchState): Promise<MatchState> {
  for (const text of candidatesOn(db, state.required!.requiredLetter, state)) {
    await pause()
    inbox.send({ type: "turn", text })
    const e = await inbox.next((x) => x.type === "verdict" || x.type === "error")
    if (e.type === "error") throw new Error(e.code)
    if (e.type === "verdict" && e.verdict.result.ok) return e.state
    expect(e.type === "verdict" && e.verdict.strike).toBe(false)
  }
  throw new Error("no legal بيت in the fixture")
}

describe("an account-less match between two Node clients", () => {
  it("creates, joins, survives a dropped socket, refuses a wrong secret, and ends", async () => {
    // ── create ──
    const made = MatchCreateResponseSchema.parse(
      await (await post("/api/match", { name: "لبيد", baitId: selfRhymingOpening(db).id, strikes: 2, timerS: 90 })).json(),
    )
    const code = made.state.code
    const host = new Inbox(code, made.secret)
    await host.opened()
    expect((await host.next((e) => e.type === "state")).type).toBe("state")

    // ── a wrong secret is refused on both doors ──
    const intruder = new Inbox(code, "q".repeat(26))
    await intruder.opened()
    expect(await intruder.next((e) => e.type === "error")).toMatchObject({ type: "error", code: "wrong_secret" })
    await intruder.closed()
    const bad = await fetch(`${base}/api/match/${code}/state`, { headers: { [MATCH_SEAT_HEADER]: made.joinKey } })
    expect(bad.status).toBe(403)

    // ── join ──
    const joined = MatchJoinResponseSchema.parse(await (await post(`/api/match/${code}/join`, { key: made.joinKey, name: "عنترة" })).json())
    const hostSeesJoin = await host.next((e) => e.type === "join")
    expect(hostSeesJoin.type === "join" && hostSeesJoin.state).toMatchObject({ status: "active", turnSeat: "guest" })
    expect(hostSeesJoin.type === "join" && hostSeesJoin.state.guest?.name).toBe("عنترة")

    let guest = new Inbox(code, joined.secret)
    await guest.opened()
    let state = await guest.stateAt(joined.state.rev)
    expect(state.you).toEqual({ seat: "guest", canPlay: true })

    // ── two legal exchanges over the sockets ──
    state = await playOverSocket(guest, state)
    let hostState = await host.stateAt(state.rev)
    expect(hostState).toMatchObject({ turnSeat: "host", you: { canPlay: true } })
    state = await playOverSocket(host, hostState)
    state = await guest.stateAt(state.rev)
    expect(state.turns.filter((t) => t.verdict === "ok")).toHaveLength(2)

    // ── the guest's socket drops; the match does not notice beyond the dot ──
    const guestRev = state.rev
    state = await playOverSocket(guest, state)
    guest.ws.close()
    await guest.closed()
    const dropRev = state.rev
    hostState = await host.next((e) => e.type !== "error" && e.state.rev >= dropRev && e.state.guest?.connected === false).then((e) =>
      e.type === "error" ? Promise.reject(new Error(e.code)) : e.state,
    )
    expect(hostState.status).toBe("active")
    expect(hostState.rev).toBeGreaterThan(guestRev)
    // The host answers while the guest is away — over HTTP this time.
    let hostAnswer: MatchState | null = null
    for (const text of candidatesOn(db, hostState.required!.requiredLetter, hostState)) {
      const res = await post(`/api/match/${code}/turn`, { text }, made.secret)
      const body = (await res.json()) as { verdict: { result: { ok: boolean } }; state: MatchState }
      if (body.verdict.result.ok) {
        hostAnswer = body.state
        break
      }
    }
    expect(hostAnswer).not.toBeNull()

    // ── the poller and the reconnecting socket see the same match ──
    const polled = MatchStateResponseSchema.parse(
      await (await fetch(`${base}/api/match/${code}/state`, { headers: { [MATCH_SEAT_HEADER]: joined.secret } })).json(),
    ).state
    expect(polled.rev).toBe(hostAnswer!.rev)
    expect(polled.turns).toEqual(hostAnswer!.turns)
    expect(polled.you.canPlay).toBe(true)

    guest = new Inbox(code, joined.secret)
    await guest.opened()
    state = await guest.stateAt(hostAnswer!.rev)
    expect(state.turns).toEqual(hostAnswer!.turns)
    expect(state).toMatchObject({ status: "active", turnSeat: "guest", you: { seat: "guest", canPlay: true } })
    expect(state.guest?.connected).toBe(true)

    // ── the guest runs out of strikes; both sides are told how it ended ──
    guest.send({ type: "turn", text: wrongLetterFor(state.required!.requiredLetter) })
    const first = await guest.next((e) => e.type === "verdict")
    expect(first.type === "verdict" && first.verdict).toMatchObject({ strike: true, strikesLeft: 1 })
    await pause()
    guest.send({ type: "turn", text: wrongLetterFor(state.required!.requiredLetter) })
    const last = await guest.next((e) => e.type === "verdict")
    expect(last.type === "verdict" && last.state).toMatchObject({ status: "done", winner: "host", endReason: "strikes" })
    const hostEnd = await host.next((e) => e.type === "end")
    expect(hostEnd.type === "end" && hostEnd.state).toMatchObject({ status: "done", winner: "host", you: { seat: "host" } })

    // ── over is over ──
    await pause()
    guest.send({ type: "turn", text: "أي بيت بعد النهاية" })
    expect(await guest.next((e) => e.type === "error")).toMatchObject({ code: "match_not_active" })

    host.ws.close()
    guest.ws.close()
    await Promise.all([host.closed(), guest.closed()])
  }, 30_000)
})
