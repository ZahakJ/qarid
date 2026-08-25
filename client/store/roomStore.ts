/**
 * `client/store/roomStore.ts` — the 1v1 مساجلة room (v2.md §5), client side.
 *
 * The store holds ONE thing: the last `RoomState` the server sent. It computes
 * nothing about the game — not whose turn it is, not the required letter, not
 * the strike count, not the deadline — because the server already decided all
 * of that and sends the whole answer with every message. A client-side copy of
 * any of it is a second opinion, and a second opinion in a two-player game is a
 * desync.
 *
 * TWO CHANNELS, ONE DIRECTION EACH:
 *
 *  • What I DO goes over HTTP (`POST /api/room/:code/turn` and friends). The
 *    response carries both the verdict — which only I may see, it is the
 *    «هل تقصد؟» list of what I nearly remembered — and the new state. One
 *    request, one answer, no correlation to get wrong.
 *  • What THEY do arrives over the WebSocket, which pushes the same snapshot.
 *    The socket is therefore pure notification: lose it and the poller below
 *    keeps the room correct, two seconds later. That is the whole of the
 *    fallback v2.md §5 asks for — not a second implementation of the game.
 *
 * RECONNECTION is not a feature here, it is the absence of one: the socket
 * carries no session of its own, every event is a full snapshot, and the
 * server forfeits nobody for a dropped connection (only the deadline can end a
 * turn). So a reconnect is a fresh `state` event and nothing else happens.
 *
 * THE CLOCK is the server's. `serverNow` rides on every snapshot and the offset
 * against `Date.now()` is kept here, so a browser whose clock is four minutes
 * fast renders the same countdown as everyone else.
 */
import { create } from "zustand"
import { ApiError } from "../api/client.ts"
import {
  acceptKnock as acceptKnockRequest,
  createRoom as createRoomRequest,
  getRoomKnock,
  getRoomState,
  joinRoom as joinRoomRequest,
  knockRoom as knockRequest,
  playRoomTurn,
  rejectKnock as rejectKnockRequest,
  rematchRoom as rematchRequest,
  resignRoom as resignRequest,
} from "../api/queries.ts"
import {
  RoomEventSchema,
  ROOM_ERRORS,
  ROOM_WS_BEARER_PREFIX,
  type CreateRoomRequest,
  type RoomKnockView,
  type RoomState,
  type RoomVerdict,
} from "../../shared/schema.ts"
import { apiSocketLoc, currentToken, isNative } from "../platform/native.ts"
import type { Rejection } from "../duel/machine.ts"

/** How often the poller asks when there is no live socket. */
export const POLL_MS = 2000

/** …and the slow heartbeat that runs even WITH one, as a safety net. */
export const HEARTBEAT_MS = 20_000

/** Socket reconnection backoff, in ms; the last value repeats. */
const BACKOFF = [400, 1000, 2000, 4000, 8000] as const

export type RoomTransport = "socket" | "polling" | "offline"

type RoomStore = {
  code: string | null
  state: RoomState | null
  /** null until the first answer; an ApiError message when the room is gone */
  error: string | null
  /** the server's machine code for `error`, so the view can say WHICH wall */
  errorCode: string | null
  /** a passing message — «على رِسْلك», a failed انسحاب — not a page state */
  notice: string | null
  loading: boolean
  busy: boolean
  transport: RoomTransport
  draft: string
  /** the last refusal of MY بيت, in the shape `RejectionCard` renders */
  rejection: Rejection | null
  strikesLeft: number
  /** `serverNow - Date.now()` at the last snapshot */
  skew: number
  /**
   * The KNOCKER's own status when this reader reached a room by code with no
   * key — `pending`/`accepted`/`rejected`. Null when he is a player, a keyed
   * spectator, or simply has not knocked. It never carries the room.
   */
  knock: RoomKnockView | null
  /** the knock button is in flight */
  knocking: boolean

  open: (code: string, key?: string | null) => void
  close: () => void
  setDraft: (v: string) => void
  submit: (text?: string) => Promise<void>
  join: () => Promise<void>
  resign: () => Promise<void>
  rematch: () => Promise<string | null>
  dismissRejection: () => void
  refresh: () => Promise<void>
  /** «اطرق الباب» — a guest with no key asks to be let in, then polls. */
  sendKnock: () => Promise<void>
  /** «اقبل» — the host seats the pending knocker (activates the room). */
  acceptKnock: () => Promise<void>
  /** «ارفض» — the host refuses the pending knocker. */
  rejectKnock: () => Promise<void>
}

/**
 * The live connection, kept OUTSIDE the store: a WebSocket is not state, it is
 * a resource, and putting it in the store means every render subscribes to a
 * thing that changes on every frame of the connection's life.
 */
let socket: WebSocket | null = null
/**
 * The 2-second fallback poller — and NOTHING else.
 *
 * The slow heartbeat used to be parked in this same variable, which made
 * `startPolling()`'s «already running?» guard read a heartbeat as a poller: a
 * socket that opened and later DROPPED left the 20 s interval installed,
 * `reopen()`'s `startPolling()` returned immediately, and the room kept
 * refreshing every twenty seconds while the header chip promised «يُحدَّث كل
 * ثانيتين». On a 30-second turn clock that is a strike, a بيت and the end of
 * the match arriving up to 20 s late. Two intervals, two slots.
 */
let pollTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let knockTimer: ReturnType<typeof setInterval> | null = null
let attempt = 0
/**
 * A FATAL socket close — `unauthenticated` (the native room-socket defect) or
 * `room_not_found` — must NOT be reconnected. The old loop reopened ~40 times in
 * 16 s against a door that would never open, while the HTTP poller (which
 * carries the bearer like every other call) was the answer all along. Set here,
 * checked in `reopen`, cleared on every fresh `open`.
 */
let socketFatal = false
/** the invite key this room was opened with (`#/room/<code>?k=…`) */
let joinKey: string | null = null
/** bumped on every `open`/`close`, so a late callback from a previous room dies */
let generation = 0

function clearTimers(): void {
  if (pollTimer !== null) clearInterval(pollTimer)
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  if (retryTimer !== null) clearTimeout(retryTimer)
  if (knockTimer !== null) clearInterval(knockTimer)
  pollTimer = null
  heartbeatTimer = null
  retryTimer = null
  knockTimer = null
}

function dropSocket(): void {
  if (!socket) return
  const s = socket
  socket = null
  try {
    s.onclose = null
    s.onmessage = null
    s.onerror = null
    s.onopen = null
    s.close()
  } catch {
    /* already closing */
  }
}

/**
 * `ws(s)://<host>/ws/room/<code>` — SAME ORIGIN, always.
 *
 * That is what makes the upgrade cookie-authenticated (v2.md §5): a WebSocket
 * cannot carry a header a page sets, but the browser sends `qarid_sess` with a
 * same-origin upgrade exactly as it does with any other request. `wss` follows
 * the page's own scheme, so the tunnel's https and a dev http://127.0.0.1 both
 * work with no configuration.
 *
 * `loc` is a parameter so this is testable without a DOM; nothing passes it.
 */
export function socketUrl(
  code: string,
  key: string | null = null,
  loc: { protocol: string; host: string } = location,
): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:"
  const base = `${scheme}//${loc.host}/ws/room/${encodeURIComponent(code)}`
  return key === null ? base : `${base}?k=${encodeURIComponent(key)}`
}

/**
 * The WebSocket subprotocol the NATIVE shell authenticates its upgrade with.
 *
 * A WebView cannot set `Authorization` on a WS handshake, so the bearer rides in
 * the one header the constructor CAN set — `Sec-WebSocket-Protocol`, via the
 * `protocols` argument — as `qarid.bearer.<token>` (server/routes/rooms.ts reads
 * it, the `ws` server echoes it back). On the WEB this is `undefined`: the
 * same-origin cookie authenticates the upgrade and no subprotocol is offered, so
 * the web path is byte-for-byte unchanged.
 */
export function bearerSubprotocol(native: boolean, token: string | null): string | undefined {
  return native && token ? `${ROOM_WS_BEARER_PREFIX}${token}` : undefined
}

/** The verifier's refusal, in the shape the duel's own card already renders. */
export function rejectionOf(verdict: RoomVerdict): Rejection | null {
  const r = verdict.result
  if (r.ok) return null
  switch (r.reason) {
    case "wrong_letter":
      return { kind: "wrong_letter", expected: r.expected, alsoAccepted: [...r.alsoAccepted], got: r.got, normalized: r.normalized }
    case "already_used":
      return { kind: "already_used", bait: r.bait }
    case "not_found":
      return { kind: "not_found", normalized: r.normalized, suggestions: [...r.suggestions] }
    case "near_miss":
      return { kind: "near_miss", normalized: r.normalized, suggestion: r.suggestion, score: r.score, acceptCost: r.acceptCost }
    case "ambiguous":
      return { kind: "ambiguous", normalized: r.normalized, candidates: [...r.candidates] }
    case "incomplete_bait":
      return { kind: "incomplete_bait", bait: r.bait }
    case "too_short":
      return { kind: "too_short", words: r.words }
    case "no_bait":
      return { kind: "no_bait", letter: r.letter }
  }
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const byCode = err.code ? ROOM_ERRORS[err.code] : undefined
    return byCode ?? err.message
  }
  return "تعذّر الاتصال بالخادم"
}

export const useRoom = create<RoomStore>()((set, get) => {
  /** Take a snapshot from any source. The newest one always wins. */
  const apply = (state: RoomState) => {
    set({ state, skew: state.serverNow - Date.now(), error: null, errorCode: null, loading: false })
  }

  const startPolling = () => {
    if (pollTimer !== null) return
    pollTimer = setInterval(() => void get().refresh(), POLL_MS)
  }

  const stopPolling = () => {
    if (pollTimer === null) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  const startHeartbeat = () => {
    if (heartbeatTimer !== null) return
    heartbeatTimer = setInterval(() => void get().refresh(), HEARTBEAT_MS)
  }

  const stopHeartbeat = () => {
    if (heartbeatTimer === null) return
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  const stopKnockPoll = () => {
    if (knockTimer === null) return
    clearInterval(knockTimer)
    knockTimer = null
  }

  /**
   * The knocker's wait, polled — the ONE room read that is NOT `getRoomState`,
   * because an unaccepted knocker is behind the join_key gate and `/state` would
   * 403 him. On `accepted` he re-opens the room the ordinary way (his id is on
   * the seat now); on `rejected` the poll stops and the view says so.
   */
  const startKnockPoll = (code: string, mine: number) => {
    if (knockTimer !== null) return
    knockTimer = setInterval(() => {
      if (mine !== generation) return
      void getRoomKnock(code)
        .then((res) => {
          if (mine !== generation) return
          set({ knock: res.knock })
          if (res.knock.status === "accepted") {
            // `open` resets everything (knock poll included) and loads the room
            // the normal way — which now succeeds, because we are seated.
            get().open(code, null)
          } else if (res.knock.status !== "pending") {
            stopKnockPoll()
          }
        })
        .catch(() => {
          /* a knock poll that blips is simply retried on the next tick */
        })
    }, POLL_MS)
  }

  const connect = (code: string, mine: number) => {
    if (typeof WebSocket === "undefined") {
      set({ transport: "polling" })
      startPolling()
      return
    }
    let ws: WebSocket
    try {
      // Same-origin on the web; the deployment host in the native shell, whose
      // page origin (https://localhost) has no server behind it. A WebView
      // cannot set the Authorization header a cross-origin upgrade would need —
      // so the native shell carries the bearer in the WebSocket SUBPROTOCOL
      // instead (`qarid.bearer.<token>`), the one thing a WebView WS CAN set.
      // On the web `proto` is undefined and the same-origin cookie authenticates
      // the upgrade, exactly as before.
      const url = socketUrl(code, joinKey, apiSocketLoc())
      const proto = bearerSubprotocol(isNative, currentToken())
      ws = proto ? new WebSocket(url, proto) : new WebSocket(url)
    } catch {
      set({ transport: "polling" })
      startPolling()
      return
    }
    socket = ws

    ws.onopen = () => {
      if (mine !== generation) return
      attempt = 0
      set({ transport: "socket" })
      // The slow heartbeat is the only thing the socket polls for: a dead
      // connection that never fires `onclose` (a laptop lid, a captive portal)
      // is otherwise invisible until someone tries to play. It lives in its
      // OWN slot — see `pollTimer`.
      stopPolling()
      startHeartbeat()
    }

    ws.onmessage = (evt) => {
      if (mine !== generation) return
      let parsed
      try {
        parsed = RoomEventSchema.safeParse(JSON.parse(String(evt.data)))
      } catch {
        return
      }
      if (!parsed.success) return
      const event = parsed.data
      if (event.type === "error") {
        // A socket-level error is about the CONNECTION, not about a بيت: the
        // room stays on screen and the poller takes over. `unauthenticated` and
        // `room_not_found` are FATAL — the door will not open on a retry — so we
        // mark the close so `reopen` STOPS the loop instead of hammering it ~40
        // times in 16 s. The message is shown only when the poller has nothing
        // either; a room already in hand is never hidden by a transport error.
        if (event.code === "unauthenticated" || event.code === "room_not_found") {
          socketFatal = true
          set({ transport: "polling", ...(get().state === null ? { error: ROOM_ERRORS[event.code] ?? event.message } : {}) })
        }
        return
      }
      apply(event.state)
    }

    const reopen = () => {
      if (mine !== generation) return
      dropSocket()
      set({ transport: "polling" })
      // The socket is gone, so the heartbeat it installed is no longer a safety
      // net over anything — the 2-second poller is now the only news there is.
      stopHeartbeat()
      startPolling()
      // A FATAL close (unauthenticated / room_not_found) does not reconnect: the
      // poller carries the bearer like every other call and keeps the room live,
      // so the socket loop stays down until the next `open`.
      if (socketFatal) return
      const wait = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]!
      attempt += 1
      retryTimer = setTimeout(() => {
        if (mine !== generation) return
        connect(code, mine)
      }, wait)
    }

    ws.onclose = reopen
    ws.onerror = () => {
      /* `onclose` always follows an error; reconnecting is handled there */
    }
  }

  return {
    code: null,
    state: null,
    error: null,
    errorCode: null,
    notice: null,
    loading: false,
    busy: false,
    transport: "offline",
    draft: "",
    rejection: null,
    strikesLeft: 0,
    skew: 0,
    knock: null,
    knocking: false,

    open: (code, key = null) => {
      const mine = ++generation
      clearTimers()
      dropSocket()
      attempt = 0
      socketFatal = false
      joinKey = key
      set({
        code,
        state: null,
        error: null,
        errorCode: null,
        notice: null,
        loading: true,
        busy: false,
        draft: "",
        rejection: null,
        transport: "offline",
        knock: null,
        knocking: false,
      })
      // The FIRST read is HTTP, always: it is the one that can say 401 or 404
      // in a way the reader understands, and the socket cannot.
      void getRoomState(code, key)
        .then((res) => {
          if (mine !== generation) return
          apply(res.state)
          connect(code, mine)
        })
        .catch((err: unknown) => {
          if (mine !== generation) return
          set({
            error: messageOf(err),
            errorCode: err instanceof ApiError ? err.code : null,
            loading: false,
            transport: "offline",
          })
        })
    },

    close: () => {
      generation += 1
      clearTimers()
      dropSocket()
      socketFatal = false
      set({ code: null, state: null, transport: "offline", draft: "", rejection: null, notice: null, knock: null, knocking: false })
    },

    setDraft: (v) => set({ draft: v }),

    refresh: async () => {
      const code = get().code
      if (!code) return
      const mine = generation
      try {
        const res = await getRoomState(code, joinKey)
        if (mine !== generation) return
        apply(res.state)
      } catch (err) {
        if (mine !== generation) return
        // A poll that fails is a network blip, not a dead room — the message
        // is kept off screen unless the room was never loaded at all.
        if (get().state === null) set({ error: messageOf(err) })
      }
    },

    submit: async (text) => {
      const { code, draft, busy } = get()
      const said = (text ?? draft).trim()
      if (!code || !said || busy) return
      set({ busy: true, notice: null })
      try {
        const res = await playRoomTurn(code, said)
        const rejection = rejectionOf(res.verdict)
        set({
          busy: false,
          rejection,
          strikesLeft: res.verdict.strikesLeft,
          // An accepted بيت empties the field; a refused one leaves it, so the
          // player can fix a word instead of typing the بيت again.
          draft: res.verdict.result.ok ? "" : get().draft,
        })
        apply(res.state)
      } catch (err) {
        set({ busy: false, notice: messageOf(err) })
        // A refusal at the ROUTE level (out of turn, room over, the deadline
        // caught us) means the client's picture is stale — go and get it.
        void get().refresh()
      }
    },

    join: async () => {
      const code = get().code
      if (!code || get().busy) return
      set({ busy: true, notice: null })
      try {
        const res = await joinRoomRequest(code, joinKey)
        apply(res.state)
        set({ busy: false })
      } catch (err) {
        set({ busy: false, notice: messageOf(err) })
        void get().refresh()
      }
    },

    resign: async () => {
      const code = get().code
      if (!code || get().busy) return
      set({ busy: true, notice: null })
      try {
        const res = await resignRequest(code)
        apply(res.state)
        set({ busy: false })
      } catch (err) {
        set({ busy: false, notice: messageOf(err) })
      }
    },

    rematch: async () => {
      const code = get().code
      if (!code || get().busy) return null
      set({ busy: true, notice: null })
      try {
        const res = await rematchRequest(code)
        set({ busy: false })
        return res.state.code
      } catch (err) {
        set({ busy: false, notice: messageOf(err) })
        return null
      }
    },

    dismissRejection: () => set({ rejection: null }),

    sendKnock: async () => {
      const code = get().code
      if (!code || get().knocking) return
      const mine = generation
      set({ knocking: true, notice: null })
      try {
        const res = await knockRequest(code)
        if (mine !== generation) return
        set({ knocking: false, knock: res.knock })
        // Wait for the host: poll the minimal knock status, NOT the room.
        startKnockPoll(code, mine)
      } catch (err) {
        if (mine !== generation) return
        set({ knocking: false, notice: messageOf(err) })
      }
    },

    acceptKnock: async () => {
      const code = get().code
      if (!code || get().busy) return
      set({ busy: true, notice: null })
      try {
        const res = await acceptKnockRequest(code)
        apply(res.state)
        set({ busy: false })
      } catch (err) {
        set({ busy: false, notice: messageOf(err) })
        void get().refresh()
      }
    },

    rejectKnock: async () => {
      const code = get().code
      if (!code || get().busy) return
      set({ busy: true, notice: null })
      try {
        const res = await rejectKnockRequest(code)
        apply(res.state)
        set({ busy: false })
      } catch (err) {
        set({ busy: false, notice: messageOf(err) })
        void get().refresh()
      }
    },
  }
})

/** «ضد صديق» on the setup screen — create the room, then go and stand in it. */
export async function createRoom(body: Partial<CreateRoomRequest>): Promise<RoomState> {
  const res = await createRoomRequest(body)
  return res.state
}

/**
 * Is this رجعة somewhere to GO, or just something that happened?
 *
 * `rooms.rematch_code` is permanent once written and rides on every later
 * snapshot of the old room, so «redirect when the snapshot has one» sent every
 * viewer — a spectator included — out of any old room they opened, chaining
 * through every generation to the newest one. Only a code that appears WHILE
 * you are in the room is news: `seenAtMount` is `undefined` before the first
 * snapshot lands, and null when that snapshot had no رجعة yet.
 */
export function rematchIsNew(seenAtMount: string | null | undefined, current: string | null): boolean {
  return current !== null && seenAtMount !== undefined && seenAtMount !== current
}

/** ms left on the current turn, on the SERVER's clock. null when there is none. */
export function roomTimeLeft(state: RoomState | null, skew: number, now = Date.now()): number | null {
  if (!state || state.deadlineAt === null) return null
  return Math.max(0, state.deadlineAt - (now + skew))
}
