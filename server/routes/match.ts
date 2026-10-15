/**
 * `/api/match/*` and `/ws/match/:code` — the account-less مساجلة.
 *
 *   POST /api/match                  create → the host's seat secret + the invite
 *   GET  /api/match/:code/state      the polling fallback — the SAME snapshot
 *   POST /api/match/:code/join       the invite key → the guest's seat; clock starts
 *   POST /api/match/:code/knock      the spoken code alone → a pending seat
 *   GET  /api/match/:code/knock      the knocker's own status (never the match)
 *   POST /api/match/:code/admit      the host seats the knocker
 *   POST /api/match/:code/refuse     the host turns him away
 *   POST /api/match/:code/turn       one بيت, judged server-side
 *   POST /api/match/:code/resign     «انسحب» / «أغلق»
 *   GET  /ws/match/:code             live feed; seat secret in the subprotocol
 *
 * The seat secret travels in `X-Match-Seat` over HTTP and as the
 * `qarid.seat.<secret>` subprotocol on the upgrade — never in a URL, so it is in
 * no access log and no Referer. Decisions live in `server/match/`; this file
 * parses, rate-limits and shapes, like `server/routes/rooms.ts` does for the
 * account rooms.
 */
import { Hono, type Context } from "hono"
import type { UpgradeWebSocket } from "hono/ws"

import { GAME_RATE_LIMIT } from "../../shared/constants.ts"
import {
  CreateMatchRequestSchema,
  JoinMatchRequestSchema,
  KnockMatchRequestSchema,
  MATCH_ERRORS,
  MATCH_SEAT_HEADER,
  MATCH_WS_SEAT_PREFIX,
  MatchCommandSchema,
  MatchTurnRequestSchema,
  type MatchEvent,
} from "../../shared/match.ts"
import { RoomCodeSchema } from "../../shared/schema.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import {
  admitFor,
  armMatch,
  broadcast,
  createFor,
  joinFor,
  knockFor,
  knockStatusFor,
  loadMatch,
  playFor,
  refuseFor,
  resignFor,
  seated,
  seatOfSecret,
  shareUrlFor,
  snapshotFor,
  type MatchConn,
  type MatchDeps,
} from "../match/service.ts"
import { parseBody } from "./auth.ts"

/** A body is a name, a key and 600 characters of بيت at most. */
export const MAX_MATCH_BODY = 8 * 1024

/** The account rooms' read bucket: far above a poller, far below a scan. */
export const MATCH_READ_LIMIT = { tokens: 60, windowMs: 10_000 } as const

/** Creating a match writes a row; ten a minute per address is plenty. */
export const MATCH_CREATE_LIMIT = { tokens: 10, windowMs: 60_000 } as const

/** Knocking is loud for the host. */
export const MATCH_KNOCK_LIMIT = { tokens: 5, windowMs: 120_000 } as const

const SOCKET_IDLE_MS = 5 * 60_000
const TURN_MIN_GAP_MS = 250

const STATUS_FOR: Record<string, 400 | 403 | 404 | 409 | 429> = {
  match_not_found: 404,
  wrong_secret: 403,
  needs_key: 403,
  match_full: 409,
  match_not_active: 409,
  not_your_turn: 409,
  not_the_host: 403,
  no_knock: 409,
  match_busy: 409,
  cannot_knock: 409,
  bad_bait: 400,
  no_bait: 409,
  too_fast: 429,
}

function errorBody(code: string): { error: string; message: string } {
  return { error: code, message: MATCH_ERRORS[code] ?? "تعذّر تنفيذ الطلب" }
}

/** The seat secret a socket offered as `qarid.seat.<secret>`, or null. */
export function seatFromSubprotocol(header: string | undefined): string | null {
  if (!header) return null
  for (const part of header.split(",")) {
    const value = part.trim()
    if (value.startsWith(MATCH_WS_SEAT_PREFIX)) return value.slice(MATCH_WS_SEAT_PREFIX.length) || null
  }
  return null
}

export function matchRoutes(deps: MatchDeps): Hono {
  const app = new Hono()
  const readLimiter = createRateLimiter({ ...MATCH_READ_LIMIT, keyOf: clientKey })
  const gameLimiter = createRateLimiter({ ...GAME_RATE_LIMIT, keyOf: clientKey })
  const createLimiter = createRateLimiter({ ...MATCH_CREATE_LIMIT, keyOf: clientKey })
  const knockLimiter = createRateLimiter({ ...MATCH_KNOCK_LIMIT, keyOf: clientKey })

  app.use("*", readLimiter.middleware)
  app.use("/:code/turn", gameLimiter.middleware)
  app.post("/", createLimiter.middleware)
  app.post("/:code/knock", knockLimiter.middleware)

  const fail = (c: Context, code: string) => c.json(errorBody(code), STATUS_FOR[code] ?? 400)
  const secretOf = (c: Context): string | null => c.req.header(MATCH_SEAT_HEADER) ?? null
  const codeOf = (c: Context): string | null => {
    const parsed = RoomCodeSchema.safeParse(c.req.param("code") ?? "")
    return parsed.success ? parsed.data : null
  }

  app.post("/", async (c) => {
    const parsed = await parseBody(c, CreateMatchRequestSchema, MAX_MATCH_BODY)
    if (!parsed.ok) return parsed.res
    const body = parsed.data
    const out = createFor(deps, {
      name: body.name,
      ...(body.baitId !== undefined ? { baitId: body.baitId } : {}),
      mode: body.mode,
      timerS: body.timerS,
      strikes: body.strikes,
    })
    if (!out.ok) return fail(c, out.code)
    return c.json(
      {
        state: snapshotFor(deps, out.match, "host"),
        secret: out.secret,
        joinKey: out.joinKey,
        shareUrl: shareUrlFor(deps.config, out.match.code, out.joinKey),
      },
      201,
    )
  })

  app.get("/:code/state", (c) => {
    const code = codeOf(c)
    if (!code) return fail(c, "match_not_found")
    const who = seated(deps, code, secretOf(c))
    if (!who.ok) return fail(c, who.code)
    return c.json({ state: snapshotFor(deps, who.match, who.seat) })
  })

  app.post("/:code/join", async (c) => {
    const code = codeOf(c)
    if (!code) return fail(c, "match_not_found")
    const parsed = await parseBody(c, JoinMatchRequestSchema, MAX_MATCH_BODY)
    if (!parsed.ok) return parsed.res
    const out = joinFor(deps, code, parsed.data.key, parsed.data.name)
    if (!out.ok) return fail(c, out.code)
    return c.json({ state: snapshotFor(deps, out.match, "guest"), secret: out.secret })
  })

  app.post("/:code/knock", async (c) => {
    const code = codeOf(c)
    if (!code) return fail(c, "match_not_found")
    const parsed = await parseBody(c, KnockMatchRequestSchema, MAX_MATCH_BODY)
    if (!parsed.ok) return parsed.res
    const out = knockFor(deps, code, parsed.data.name)
    if (!out.ok) return fail(c, out.code)
    return c.json({ knock: out.view, secret: out.secret })
  })

  app.get("/:code/knock", (c) => {
    const code = codeOf(c)
    if (!code) return fail(c, "match_not_found")
    const out = knockStatusFor(deps, code, secretOf(c))
    if (!out.ok) return fail(c, out.code)
    return c.json({ knock: out.view })
  })

  for (const [path, op] of [
    ["admit", admitFor],
    ["refuse", refuseFor],
    ["resign", resignFor],
  ] as const) {
    app.post(`/:code/${path}`, (c) => {
      const code = codeOf(c)
      if (!code) return fail(c, "match_not_found")
      const out = op(deps, code, secretOf(c))
      if (!out.ok) return fail(c, out.code)
      return c.json({ state: snapshotFor(deps, out.match, out.seat) })
    })
  }

  app.post("/:code/turn", async (c) => {
    const code = codeOf(c)
    if (!code) return fail(c, "match_not_found")
    const parsed = await parseBody(c, MatchTurnRequestSchema, MAX_MATCH_BODY)
    if (!parsed.ok) return parsed.res
    // Loaded AFTER the body arrived: nothing read before an await is trusted.
    const out = playFor(deps, code, secretOf(c), parsed.data.text)
    if (!out.ok) {
      // A refusal still hands a seated player the match — the deadline may
      // have just ended it, and the screen should say who won, not «error».
      const m = out.match ?? loadMatch(deps, code)
      const seat = m ? seatOfSecret(m, secretOf(c)) : null
      return c.json(
        { ...errorBody(out.code), ...(m && seat ? { state: snapshotFor(deps, m, seat) } : {}) },
        STATUS_FOR[out.code] ?? 400,
      )
    }
    return c.json({ verdict: out.verdict, state: snapshotFor(deps, out.match, out.seat) })
  })

  return app
}

/**
 * `/ws/match/:code`. The seat secret is the `qarid.seat.<secret>` subprotocol
 * (the `ws` server echoes the offered value, so the handshake completes); the
 * seat is re-checked against the stored digest on every frame, so a socket
 * never outlives the record it authenticated against. A socket that drops
 * forfeits nothing — only the deadline in the record can end a turn.
 */
export function mountMatchSocket(app: Hono, deps: MatchDeps, upgradeWebSocket: UpgradeWebSocket): void {
  app.get(
    "/ws/match/:code",
    upgradeWebSocket((c) => {
      const parsedCode = RoomCodeSchema.safeParse(c.req.param("code") ?? "")
      const code = parsedCode.success ? parsedCode.data : ""
      const secret = seatFromSubprotocol(c.req.header("sec-websocket-protocol"))

      let conn: MatchConn | null = null
      let lastTurnAt = 0
      let idle: ReturnType<typeof setTimeout> | null = null
      const armIdle = (ws: { close: () => void }) => {
        if (idle) clearTimeout(idle)
        idle = setTimeout(() => ws.close(), SOCKET_IDLE_MS)
        idle.unref?.()
      }

      return {
        onOpen(_evt, ws) {
          const send = (event: MatchEvent) => ws.send(JSON.stringify(event))
          const refuse = (errCode: string) => {
            send({ type: "error", code: errCode, message: MATCH_ERRORS[errCode] ?? "تعذّر" })
            ws.close()
          }
          const who = code ? seated(deps, code, secret) : ({ ok: false, code: "match_not_found" } as const)
          if (!who.ok) return refuse(who.code)
          conn = { seat: who.seat, send }
          if (!deps.hub.add(who.match.code, conn)) {
            conn = null
            return refuse("too_many_sockets")
          }
          armIdle(ws)
          armMatch(deps, who.match)
          send({ type: "state", state: snapshotFor(deps, who.match, who.seat) })
          // The other seat sees this one light up.
          broadcast(deps, who.match, (state) => ({ type: "state", state }), conn)
        },

        onMessage(evt, ws) {
          if (!conn) return
          const self = conn
          armIdle(ws)
          const raw = typeof evt.data === "string" ? evt.data : ""
          if (raw.length === 0 || raw.length > MAX_MATCH_BODY) return
          let cmd
          try {
            const parsed = MatchCommandSchema.safeParse(JSON.parse(raw))
            if (!parsed.success) return
            cmd = parsed.data
          } catch {
            return
          }
          if (!deps.socketLimiter.take(`${code}:${self.seat}`).ok) {
            self.send({ type: "error", code: "too_fast", message: MATCH_ERRORS.too_fast! })
            return
          }
          // Who is this, NOW: the record is re-read and the seat re-proved.
          const who = seated(deps, code, secret)
          if (!who.ok || who.seat !== self.seat) {
            self.send({ type: "error", code: who.ok ? "wrong_secret" : who.code, message: MATCH_ERRORS.wrong_secret! })
            ws.close()
            return
          }
          if (cmd.type === "ping" || cmd.type === "state") {
            self.send({ type: "state", state: snapshotFor(deps, who.match, who.seat) })
            return
          }
          const now = Date.now()
          if (now - lastTurnAt < TURN_MIN_GAP_MS) {
            self.send({ type: "error", code: "too_fast", message: MATCH_ERRORS.too_fast! })
            return
          }
          lastTurnAt = now
          const out = playFor(deps, code, secret, cmd.text, self)
          if (!out.ok) {
            self.send({ type: "error", code: out.code, message: MATCH_ERRORS[out.code] ?? "تعذّر" })
            const m = out.match ?? loadMatch(deps, code)
            if (m) self.send({ type: "state", state: snapshotFor(deps, m, self.seat) })
            return
          }
          self.send({ type: "verdict", state: snapshotFor(deps, out.match, out.seat), verdict: out.verdict })
        },

        onClose() {
          if (idle) clearTimeout(idle)
          if (!conn) return
          const gone = conn
          conn = null
          deps.hub.remove(code, gone)
          try {
            const m = deps.store.get(code)
            if (m) broadcast(deps, m, (state) => ({ type: "state", state }))
          } catch {
            /* closing on the way down — the store may already be shut */
          }
        },

        onError() {
          /* `onClose` follows */
        },
      }
    }),
  )
}
