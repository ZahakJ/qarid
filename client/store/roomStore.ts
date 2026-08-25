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
  createRoom as createRoomRequest,
  getRoomState,
  joinRoom as joinRoomRequest,
  playRoomTurn,
  rematchRoom as rematchRequest,
  resignRoom as resignRequest,
} from "../api/queries.ts"
import { RoomEventSchema, ROOM_ERRORS, type CreateRoomRequest, type RoomState, type RoomVerdict } from "../../shared/schema.ts"
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

  open: (code: string) => void
  close: () => void
  setDraft: (v: string) => void
  submit: (text?: string) => Promise<void>
  join: () => Promise<void>
  resign: () => Promise<void>
  rematch: () => Promise<string | null>
  dismissRejection: () => void
  refresh: () => Promise<void>
}

/**
 * The live connection, kept OUTSIDE the store: a WebSocket is not state, it is
 * a resource, and putting it in the store means every render subscribes to a
 * thing that changes on every frame of the connection's life.
 */
let socket: WebSocket | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let attempt = 0
/** bumped on every `open`/`close`, so a late callback from a previous room dies */
let generation = 0

function clearTimers(): void {
  if (pollTimer !== null) clearInterval(pollTimer)
  if (retryTimer !== null) clearTimeout(retryTimer)
  pollTimer = null
  retryTimer = null
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
export function socketUrl(code: string, loc: { protocol: string; host: string } = location): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:"
  return `${scheme}//${loc.host}/ws/room/${encodeURIComponent(code)}`
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
    set({ state, skew: state.serverNow - Date.now(), error: null, loading: false })
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

  const connect = (code: string, mine: number) => {
    if (typeof WebSocket === "undefined") {
      set({ transport: "polling" })
      startPolling()
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(socketUrl(code))
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
      // is otherwise invisible until someone tries to play.
      stopPolling()
      pollTimer = setInterval(() => void get().refresh(), HEARTBEAT_MS)
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
        // room stays on screen and the poller takes over.
        if (event.code === "unauthenticated" || event.code === "room_not_found") {
          set({ error: ROOM_ERRORS[event.code] ?? event.message, transport: "polling" })
        }
        return
      }
      apply(event.state)
    }

    const reopen = () => {
      if (mine !== generation) return
      dropSocket()
      set({ transport: "polling" })
      startPolling()
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
    notice: null,
    loading: false,
    busy: false,
    transport: "offline",
    draft: "",
    rejection: null,
    strikesLeft: 0,
    skew: 0,

    open: (code) => {
      const mine = ++generation
      clearTimers()
      dropSocket()
      attempt = 0
      set({
        code,
        state: null,
        error: null,
        notice: null,
        loading: true,
        busy: false,
        draft: "",
        rejection: null,
        transport: "offline",
      })
      // The FIRST read is HTTP, always: it is the one that can say 401 or 404
      // in a way the reader understands, and the socket cannot.
      void getRoomState(code)
        .then((res) => {
          if (mine !== generation) return
          apply(res.state)
          connect(code, mine)
        })
        .catch((err: unknown) => {
          if (mine !== generation) return
          set({ error: messageOf(err), loading: false, transport: "offline" })
        })
    },

    close: () => {
      generation += 1
      clearTimers()
      dropSocket()
      set({ code: null, state: null, transport: "offline", draft: "", rejection: null, notice: null })
    },

    setDraft: (v) => set({ draft: v }),

    refresh: async () => {
      const code = get().code
      if (!code) return
      const mine = generation
      try {
        const res = await getRoomState(code)
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
        const res = await joinRoomRequest(code)
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
  }
})

/** «ضد صديق» on the setup screen — create the room, then go and stand in it. */
export async function createRoom(body: Partial<CreateRoomRequest>): Promise<RoomState> {
  const res = await createRoomRequest(body)
  return res.state
}

/** ms left on the current turn, on the SERVER's clock. null when there is none. */
export function roomTimeLeft(state: RoomState | null, skew: number, now = Date.now()): number | null {
  if (!state || state.deadlineAt === null) return null
  return Math.max(0, state.deadlineAt - (now + skew))
}
