/**
 * `/api/room/*` and `/ws/room/:code` — the wire for v2.md §5's مساجلة rooms.
 *
 *   POST /api/room                 create (host picks the opening بيت)
 *   GET  /api/room/:code/state     the polling fallback — the SAME snapshot
 *   POST /api/room/:code/join      the guest sits down; the room goes active
 *   POST /api/room/:code/turn      one بيت, judged server-side
 *   POST /api/room/:code/resign    «انسحب»
 *   POST /api/room/:code/rematch   «رجعة» — a new room with the seats swapped
 *   GET  /ws/room/:code            the live feed (cookie-authenticated upgrade)
 *
 * Everything that decides anything is in `server/rooms.ts`; this file parses,
 * authenticates, rate-limits and shapes — the same division `server/routes/
 * game.ts` keeps with `server/game.ts`.
 *
 * LOGGED-IN ONLY, all of it (v2.md §5: «Both players MUST be logged in»), and
 * that includes the spectator: a room link is not public, it is a link you were
 * given. A request with no session gets 401 `unauthenticated` and the client
 * opens the auth dialog over the room.
 *
 * THE SOCKET IS AN OPTIMISATION. Every event it carries is the full snapshot,
 * which is what `GET /state` returns, which is what every POST returns. Turn
 * the WebSocket off — a proxy that strips upgrades, a browser tab that lost the
 * connection, the tunnel blinking — and the room still plays through the poller
 * at 2-second granularity. There is exactly one server-side path, and the
 * transport chooses only how fast the news travels.
 */

import { Hono, type Context } from "hono"
import { getCookie } from "hono/cookie"
import type { UpgradeWebSocket } from "hono/ws"

import { GAME_RATE_LIMIT } from "../../shared/constants.ts"
import {
  CreateRoomRequestSchema,
  ROOM_ERRORS,
  RoomCommandSchema,
  RoomPlayableQuerySchema,
  RoomTurnRequestSchema,
  type RoomEvent,
  type RoomState,
  type RoomTurnVerdict,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { baitDto, num } from "../dto.ts"
import { parseQuery } from "../query.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import {
  RoomHub,
  createRoom,
  findRoomByCode,
  isPlayableBait,
  joinRoom,
  playTurn,
  randomStartingBait,
  baitRow,
  rematchRoom,
  resignRoom,
  resolveExpiry,
  seatOf,
  snapshot,
  turnSeatOf,
  chainTurns,
  roomTurns,
  userIdForSeat,
  type RoomConn,
  type RoomDeps,
  type RoomRow,
} from "../rooms.ts"
import { SESSION_COOKIE, findUserById, hashToken, sessionUser, type UserRow, type UsersDb } from "../users.ts"
import { currentUser, parseBody } from "./auth.ts"

/** A room body is a code and 600 characters of بيت — 8 KB is generous. */
export const MAX_ROOM_BODY = 8 * 1024

/** How long a socket may go silent before the server hangs up (ms). */
const SOCKET_IDLE_MS = 5 * 60_000

/** The smallest gap between two submitted أبيات on one socket. */
const TURN_MIN_GAP_MS = 250

function errorBody(code: string): { error: string; message: string } {
  return { error: code, message: ROOM_ERRORS[code] ?? "تعذّر تنفيذ الطلب" }
}

const STATUS_FOR: Record<string, 400 | 401 | 403 | 404 | 409 | 429> = {
  room_not_found: 404,
  unauthenticated: 401,
  room_full: 409,
  room_not_active: 409,
  not_your_turn: 409,
  spectator: 403,
  not_a_player: 403,
  bad_bait: 400,
  no_bait: 409,
  rooms_unavailable: 400,
  too_fast: 429,
}

/**
 * The `deps` a room needs, assembled once per app. The hub is per-app on
 * purpose: two `createApp()`s in one test file must not share sockets or
 * timers, exactly as they must not share a rate-limit bucket.
 */
export function roomDeps(db: Db, users: UsersDb, config: Config): RoomDeps {
  const hub = new RoomHub()
  const deps: RoomDeps = { db, users, config, hub }
  // The clock's own callback: when a deadline passes with nobody watching, the
  // room still ends, and everyone still connected is told.
  hub.onDeadline((code) => {
    const room = findRoomByCode(users, code)
    if (!room) return
    const now = Date.now()
    const { room: after, expired } = resolveExpiry(deps, room, now)
    if (!expired) {
      hub.arm(code, after.turnDeadlineAt, now)
      return
    }
    // Whoever's turn it was is the one the clock caught; the snapshot already
    // names the winner, and «انقضى وقت فلان» needs the other name.
    const loserId = after.winnerUserId === null ? null : (after.winnerUserId === after.hostUserId ? after.guestUserId : after.hostUserId)
    const loser = loserId === null ? null : (findUserById(users, loserId)?.username ?? null)
    broadcastRoom(deps, after, (state) => ({ type: "timeout", state, username: loser }))
    broadcastRoom(deps, after, (state) => ({ type: "end", state }))
  })
  return deps
}

/**
 * Broadcast, once per socket, with each viewer's OWN snapshot.
 *
 * A snapshot is not viewer-independent — `you.role`, `you.canPlay` and
 * `you.canJoin` are the whole of what a client renders its controls from — so
 * one serialized payload for everyone would tell the guest it was the host's
 * turn to type. The cost is one snapshot per connected socket, which is two.
 */
export function broadcastRoom(
  deps: RoomDeps,
  room: RoomRow,
  make: (state: RoomState) => RoomEvent,
  except?: RoomConn,
): void {
  const now = Date.now()
  for (const conn of deps.hub.connections(room.code)) {
    if (conn === except) continue
    try {
      conn.send(make(snapshot(deps, room, { id: conn.userId, username: conn.username }, now)))
    } catch {
      /* a socket that throws on send is already gone */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

export function roomRoutes(deps: RoomDeps): Hono {
  const app = new Hono()
  const limiter = createRateLimiter({ ...GAME_RATE_LIMIT, keyOf: clientKey })

  // `Cache-Control: private, no-store` for these paths is set by the OUTERMOST
  // middleware in server/app.ts (`cachePolicy`), not here — an inner middleware
  // that writes a response header loses it to `compress()` on the way out
  // (CLAUDE.md's first invariant). A room state cached for a minute would be
  // one player looking at the other player's screen.

  // The verify pipeline is the expensive thing here, exactly as it is under
  // /api/game — same bucket size, its own instance.
  app.use("/:code/turn", limiter.middleware)
  app.use("/", limiter.middleware)

  const requireUser = (c: Context): UserRow | Response => {
    const user = currentUser(c, deps.users, deps.config)
    return user ?? c.json(errorBody("unauthenticated"), 401)
  }

  const load = (c: Context, code: string): RoomRow | Response => {
    const room = findRoomByCode(deps.users, code)
    return room ?? c.json(errorBody("room_not_found"), 404)
  }

  const fail = (c: Context, code: string) => c.json(errorBody(code), STATUS_FOR[code] ?? 400)

  // ── POST /api/room ───────────────────────────────────────────────────────
  //
  // The host's opening بيت: `baitId` when he picked one out of the palette,
  // nothing at all for «عشوائي», which draws from the شاعر tier (fame ≥ 2).
  // A بيت that is not in `game_baits` — no عجز, a قصيدة the pool excludes — is
  // refused here rather than becoming a مساجلة nobody can answer.
  app.post("/", async (c) => {
    const user = requireUser(c)
    if (user instanceof Response) return user
    const parsed = await parseBody(c, CreateRoomRequestSchema, MAX_ROOM_BODY)
    if (!parsed.ok) return parsed.res
    const body = parsed.data

    let row = null
    if (body.baitId !== undefined) {
      if (!isPlayableBait(deps.db, body.baitId)) return fail(c, "bad_bait")
      row = baitRow(deps.db, body.baitId)
      if (row === null) return fail(c, "bad_bait")
    } else {
      row = randomStartingBait(deps.db)
      if (row === null) return fail(c, "no_bait")
    }

    const now = Date.now()
    const room = createRoom(deps.users, {
      hostUserId: user.id,
      startingBaitId: num(row.b_id),
      startingPoemId: num(row.p_id),
      mode: body.mode,
      timerS: body.timerS ?? null,
      strikes: body.strikes,
      now,
    })
    return c.json({ state: snapshot(deps, room, { id: user.id, username: user.username }, now) }, 201)
  })

  // ── GET /api/room/opening ────────────────────────────────────────────────
  //
  // «عشوائي» in the create dialog, so the host SEES the بيت he is about to
  // recite before the room exists. It is the same `randomStartingBait` the
  // create route would have called for him, which is the point: what he sees
  // is what he would have got.
  app.get("/opening", (c) => {
    const user = requireUser(c)
    if (user instanceof Response) return user
    const row = randomStartingBait(deps.db)
    if (row === null) return fail(c, "no_bait")
    return c.json({ bait: baitDto(row) })
  })

  // ── GET /api/room/playable ───────────────────────────────────────────────
  //
  // The picker's filter. One primary-key probe per id against `game_baits`,
  // capped at twenty by the schema — the search rail shows five.
  app.get("/playable", (c) => {
    const user = requireUser(c)
    if (user instanceof Response) return user
    const parsed = parseQuery(c, RoomPlayableQuerySchema)
    if (!parsed.ok) return parsed.res
    return c.json({ ids: parsed.data.ids.filter((id) => isPlayableBait(deps.db, id)) })
  })

  // ── GET /api/room/:code/state ────────────────────────────────────────────
  //
  // The polling fallback, and the read every other route's answer is made of.
  // It resolves an expired deadline on the way past (the timer that should have
  // done it belongs to a process that may have restarted) but joins nobody and
  // starts nothing: a GET does not change whose room this is.
  app.get("/:code/state", (c) => {
    const user = requireUser(c)
    if (user instanceof Response) return user
    const room = load(c, c.req.param("code") ?? "")
    if (room instanceof Response) return room
    const now = Date.now()
    const { room: live, expired } = resolveExpiry(deps, room, now)
    if (expired) broadcastRoom(deps, live, (state) => ({ type: "end", state }))
    return c.json({ state: snapshot(deps, live, { id: user.id, username: user.username }, now) })
  })

  // ── POST /api/room/:code/join ────────────────────────────────────────────
  app.post("/:code/join", (c) => {
    const user = requireUser(c)
    if (user instanceof Response) return user
    const room = load(c, c.req.param("code") ?? "")
    if (room instanceof Response) return room
    const out = joinRoom(deps, room, user)
    if (!out.ok) return fail(c, out.code)
    if (out.joined) {
      broadcastRoom(deps, out.room, (state) => ({ type: "join", state, username: user.username }))
    }
    return c.json({ state: snapshot(deps, out.room, { id: user.id, username: user.username }) })
  })

  // ── POST /api/room/:code/turn ────────────────────────────────────────────
  app.post("/:code/turn", async (c) => {
    const user = requireUser(c)
    if (user instanceof Response) return user
    const room = load(c, c.req.param("code") ?? "")
    if (room instanceof Response) return room
    const parsed = await parseBody(c, RoomTurnRequestSchema, MAX_ROOM_BODY)
    if (!parsed.ok) return parsed.res

    const out = playTurn(deps, room, user, parsed.data.text)
    if (!out.ok) {
      // The room may have ENDED on the way in (an expired deadline resolved by
      // this very request), so the client is handed the room as well as the
      // refusal — otherwise a player who typed one second late sees an error
      // where the screen should be saying who won.
      const after = findRoomByCode(deps.users, room.code)
      if (after) broadcastRoom(deps, after, (state) => ({ type: "end", state }))
      return c.json(
        {
          ...errorBody(out.code),
          state: after ? snapshot(deps, after, { id: user.id, username: user.username }) : undefined,
        },
        STATUS_FOR[out.code] ?? 400,
      )
    }
    announceTurn(deps, out.room, user, out.persisted, out.accepted, out.verdict.result.ok ? "ok" : (out.verdict.result.reason as RoomTurnVerdict))
    return c.json({
      verdict: out.verdict,
      state: snapshot(deps, out.room, { id: user.id, username: user.username }),
    })
  })

  // ── POST /api/room/:code/resign ──────────────────────────────────────────
  app.post("/:code/resign", (c) => {
    const user = requireUser(c)
    if (user instanceof Response) return user
    const room = load(c, c.req.param("code") ?? "")
    if (room instanceof Response) return room
    const out = resignRoom(deps, room, user)
    if (!out.ok) return fail(c, out.code)
    broadcastRoom(deps, out.room, (state) => ({ type: "end", state }))
    return c.json({ state: snapshot(deps, out.room, { id: user.id, username: user.username }) })
  })

  // ── POST /api/room/:code/rematch ─────────────────────────────────────────
  app.post("/:code/rematch", (c) => {
    const user = requireUser(c)
    if (user instanceof Response) return user
    const room = load(c, c.req.param("code") ?? "")
    if (room instanceof Response) return room
    const out = rematchRoom(deps, room, user)
    if (!out.ok) return fail(c, out.code)
    // The OLD room is where both players still are, so that is where the news
    // goes; the new code rides on it and on every later snapshot of it.
    const old = findRoomByCode(deps.users, room.code)
    if (old) broadcastRoom(deps, old, (state) => ({ type: "rematch", state, code: out.room.code }))
    return c.json({ state: snapshot(deps, out.room, { id: user.id, username: user.username }) })
  })

  return app
}

/** One accepted بيت (or one strike) → the room's own sockets, then the end. */
function announceTurn(
  deps: RoomDeps,
  room: RoomRow,
  user: UserRow,
  persisted: boolean,
  _accepted: boolean,
  verdict: RoomTurnVerdict,
): void {
  if (!persisted) return
  broadcastRoom(deps, room, (state) => ({ type: "turn", state, username: user.username, verdict }))
  if (room.status === "done") broadcastRoom(deps, room, (state) => ({ type: "end", state }))
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `/ws/room/:code`, cookie-authenticated on upgrade (v2.md §5).
 *
 * There is no token in the URL and no auth message after connect: the browser
 * sends `qarid_sess` with the upgrade request like it does with any other GET,
 * and the handshake either finds a live session or the socket closes with one
 * `error` frame. That is the same door `/api/auth/me` uses, read by hand here
 * because a WebSocket upgrade never reaches the route middleware.
 *
 * A socket carries no state of its own beyond who is on the other end. It is
 * added to the hub, it receives the full snapshot immediately (which IS the
 * reconnect story), and on close it is removed — no forfeit, no timer touched.
 * Only the deadline in the database can end a turn.
 */
export function mountRoomSocket(app: Hono, deps: RoomDeps, upgradeWebSocket: UpgradeWebSocket): void {
  app.get(
    "/ws/room/:code",
    upgradeWebSocket((c) => {
      const code = c.req.param("code") ?? ""
      const token = getCookie(c, SESSION_COOKIE)
      const found = token ? sessionUser(deps.users, hashToken(token), Date.now()) : null

      let conn: RoomConn | null = null
      let lastTurnAt = 0
      let idle: ReturnType<typeof setTimeout> | null = null

      const armIdle = (ws: { close: () => void }) => {
        if (idle) clearTimeout(idle)
        idle = setTimeout(() => ws.close(), SOCKET_IDLE_MS)
        idle.unref?.()
      }

      return {
        onOpen(_evt, ws) {
          const send = (event: RoomEvent) => ws.send(JSON.stringify(event))
          if (!found) {
            send({ type: "error", code: "unauthenticated", message: ROOM_ERRORS.unauthenticated! })
            ws.close()
            return
          }
          const room = findRoomByCode(deps.users, code)
          if (!room) {
            send({ type: "error", code: "room_not_found", message: ROOM_ERRORS.room_not_found! })
            ws.close()
            return
          }
          conn = { userId: found.user.id, username: found.user.username, send }
          deps.hub.add(room.code, conn)
          armIdle(ws)

          const now = Date.now()
          // A room whose deadline passed while nobody was connected ends HERE,
          // on the first socket back — the process that armed the timer may not
          // even be the process serving this connection.
          const { room: live, expired } = resolveExpiry(deps, room, now)
          if (!expired && live.status === "active") deps.hub.arm(live.code, live.turnDeadlineAt, now)
          send({ type: "state", state: snapshot(deps, live, { id: found.user.id, username: found.user.username }, now) })
          // Everyone else learns that a seat lit up (`connected` on the snapshot).
          broadcastRoom(deps, live, (state) => ({ type: "state", state }), conn)
        },

        onMessage(evt, ws) {
          if (!conn || !found) return
          const send = conn.send
          armIdle(ws)
          const raw = typeof evt.data === "string" ? evt.data : ""
          if (raw.length === 0 || raw.length > MAX_ROOM_BODY) return
          let parsed
          try {
            parsed = RoomCommandSchema.safeParse(JSON.parse(raw))
          } catch {
            return
          }
          if (!parsed.success) return
          const cmd = parsed.data

          const room = findRoomByCode(deps.users, code)
          if (!room) {
            send({ type: "error", code: "room_not_found", message: ROOM_ERRORS.room_not_found! })
            return
          }
          const me = { id: found.user.id, username: found.user.username }

          if (cmd.type === "ping" || cmd.type === "state") {
            const now = Date.now()
            const { room: live, expired } = resolveExpiry(deps, room, now)
            send({ type: "state", state: snapshot(deps, live, me, now) })
            if (expired) broadcastRoom(deps, live, (state) => ({ type: "end", state }), conn)
            return
          }

          // cmd.type === "turn"
          const now = Date.now()
          if (now - lastTurnAt < TURN_MIN_GAP_MS) {
            send({ type: "error", code: "too_fast", message: ROOM_ERRORS.too_fast! })
            return
          }
          lastTurnAt = now
          const out = playTurn(deps, room, found.user, cmd.text, now)
          if (!out.ok) {
            const after = findRoomByCode(deps.users, room.code) ?? room
            send({ type: "error", code: out.code, message: ROOM_ERRORS[out.code] ?? "تعذّر" })
            send({ type: "state", state: snapshot(deps, after, me) })
            if (after.status === "done") broadcastRoom(deps, after, (state) => ({ type: "end", state }), conn)
            return
          }
          // The player who typed gets the verdict — the near-miss card, the
          // «هل تقصد؟» list, the strike count. Nobody else does.
          send({ type: "verdict", state: snapshot(deps, out.room, me), verdict: out.verdict })
          if (out.persisted) {
            broadcastRoom(
              deps,
              out.room,
              (state) => ({
                type: "turn",
                state,
                username: found.user.username,
                verdict: out.verdict.result.ok ? "ok" : (out.verdict.result.reason as RoomTurnVerdict),
              }),
              conn,
            )
            if (out.room.status === "done") broadcastRoom(deps, out.room, (state) => ({ type: "end", state }))
          }
        },

        onClose() {
          if (idle) clearTimeout(idle)
          if (!conn) return
          const gone = conn
          conn = null
          // A socket also closes on the way DOWN — a `server.close()`, a
          // restart, the end of a test file — and by then the handle may be
          // gone. Losing a connection must never be the thing that throws.
          try {
            const room = findRoomByCode(deps.users, code)
            if (!room) return
            deps.hub.remove(room.code, gone)
            // A dropped socket forfeits NOTHING (v2.md §5). The only thing the
            // others are told is that a seat went dark.
            broadcastRoom(deps, room, (state) => ({ type: "state", state }))
          } catch {
            deps.hub.remove(code, gone)
          }
        },

        onError() {
          /* `onClose` follows; there is nothing else to unwind */
        },
      }
    }),
  )
}

/** Exported for the tests: the seat that owes a بيت in a loaded room. */
export function whoseTurn(deps: RoomDeps, room: RoomRow): { seat: "host" | "guest"; userId: number | null } {
  const seat = turnSeatOf(chainTurns(roomTurns(deps.users, room.id)))
  return { seat, userId: userIdForSeat(room, seat) }
}

export { seatOf }
