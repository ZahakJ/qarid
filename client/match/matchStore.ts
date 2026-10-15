/**
 * `#/match/<CODE>` — the account-less مساجلة, client side.
 *
 * The same shape as `roomStore`: the store holds the last snapshot the server
 * sent and decides nothing about the game. What I do goes over HTTP; what the
 * other side does arrives over the socket, and when the socket is down a
 * 2-second poller reads the same snapshot. Every snapshot carries `rev`, so an
 * older one arriving late never overwrites a newer one.
 *
 * Identity is the seat secret in `seats.ts`. No secret for this code means the
 * reader is not seated yet: with the invite key he can join, with the spoken
 * code alone he can knock.
 */
import { create } from "zustand"

import { ApiError } from "../api/client.ts"
import { MATCH_ERRORS, MATCH_WS_SEAT_PREFIX, MatchEventSchema, type MatchKnockView, type MatchState } from "../../shared/match.ts"
import { apiSocketLoc } from "../platform/native.ts"
import type { Rejection } from "../duel/machine.ts"
import { rejectionOf } from "../store/roomStore.ts"
import { getKnock, getMatchState, joinMatch, knockMatch, matchAction, playMatchTurn } from "./api.ts"
import { forgetSeat, rememberName, saveSeat, seatFor } from "./seats.ts"

export const POLL_MS = 2000
const HEARTBEAT_MS = 20_000
const BACKOFF = [400, 1000, 2000, 4000, 8000] as const

/** What the screen is: loading, at the door, knocking, seated, or nothing there. */
export type MatchPhase = "loading" | "door" | "knocking" | "seated" | "gone"
export type MatchTransport = "socket" | "polling" | "offline"

type MatchStore = {
  code: string | null
  /** the invite key from `?k=`, when the reader arrived by link */
  joinKey: string | null
  phase: MatchPhase
  state: MatchState | null
  knock: MatchKnockView | null
  shareUrl: string | null
  error: string | null
  notice: string | null
  busy: boolean
  transport: MatchTransport
  draft: string
  rejection: Rejection | null
  strikesLeft: number
  skew: number

  open: (code: string, key: string | null) => void
  close: () => void
  enter: (name: string) => Promise<void>
  setDraft: (v: string) => void
  submit: (text?: string) => Promise<void>
  act: (action: "admit" | "refuse" | "resign") => Promise<void>
  dismissRejection: () => void
  refresh: () => Promise<void>
}

let socket: WebSocket | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let knockTimer: ReturnType<typeof setInterval> | null = null
let attempt = 0
let socketFatal = false
let generation = 0

function clearTimers(): void {
  for (const t of [pollTimer, heartbeatTimer, knockTimer]) if (t !== null) clearInterval(t)
  if (retryTimer !== null) clearTimeout(retryTimer)
  pollTimer = heartbeatTimer = knockTimer = null
  retryTimer = null
}

function dropSocket(): void {
  if (!socket) return
  const s = socket
  socket = null
  try {
    s.onclose = s.onmessage = s.onerror = s.onopen = null
    s.close()
  } catch {
    /* already closing */
  }
}

/** `ws(s)://<host>/ws/match/<CODE>` — the API host in the native shell, same-origin on the web. */
export function matchSocketUrl(code: string, loc: { protocol: string; host: string } = location): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:"
  return `${scheme}//${loc.host}/ws/match/${encodeURIComponent(code)}`
}

/** The seat secret rides as a subprotocol: the one header a WebSocket constructor can set. */
export function seatSubprotocol(secret: string): string {
  return `${MATCH_WS_SEAT_PREFIX}${secret}`
}

function codeOf(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return (err.code ? MATCH_ERRORS[err.code] : undefined) ?? err.message
  return "تعذّر الاتصال بالخادم"
}

/** ms left on the current turn, on the server's clock. */
export function matchTimeLeft(state: MatchState | null, skew: number, now = Date.now()): number | null {
  if (!state || state.deadlineAt === null) return null
  return Math.max(0, state.deadlineAt - (now + skew))
}

export const useMatch = create<MatchStore>()((set, get) => {
  const apply = (state: MatchState) => {
    const current = get().state
    if (current && current.code === state.code && state.rev < current.rev) return
    set({ state, phase: "seated", skew: state.serverNow - Date.now(), error: null })
  }

  const secret = (): string | null => {
    const code = get().code
    const rec = code ? seatFor(code) : null
    return rec && !rec.knocking ? rec.secret : null
  }

  const startPolling = () => {
    if (pollTimer === null) pollTimer = setInterval(() => void get().refresh(), POLL_MS)
  }
  const stopPolling = () => {
    if (pollTimer !== null) clearInterval(pollTimer)
    pollTimer = null
  }

  /** The seat is gone (a stale secret, a purged match): back to the door. */
  const lose = (code: string, err: unknown) => {
    const c = codeOf(err)
    if (c === "wrong_secret") {
      forgetSeat(code)
      set({ phase: "door", state: null, error: null })
    } else if (c === "match_not_found") {
      forgetSeat(code)
      set({ phase: "gone", state: null, error: messageOf(err) })
    } else if (get().state === null) {
      set({ error: messageOf(err) })
    }
  }

  const connect = (code: string, mine: number) => {
    const s = secret()
    if (!s) return
    if (typeof WebSocket === "undefined") {
      set({ transport: "polling" })
      startPolling()
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(matchSocketUrl(code, apiSocketLoc()), [seatSubprotocol(s)])
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
      stopPolling()
      if (heartbeatTimer === null) heartbeatTimer = setInterval(() => void get().refresh(), HEARTBEAT_MS)
    }
    ws.onmessage = (evt) => {
      if (mine !== generation) return
      let parsed
      try {
        parsed = MatchEventSchema.safeParse(JSON.parse(String(evt.data)))
      } catch {
        return
      }
      if (!parsed.success) return
      const event = parsed.data
      if (event.type === "error") {
        if (event.code === "wrong_secret" || event.code === "match_not_found") socketFatal = true
        return
      }
      apply(event.state)
    }
    ws.onclose = () => {
      if (mine !== generation) return
      dropSocket()
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
      heartbeatTimer = null
      set({ transport: "polling" })
      startPolling()
      if (socketFatal) return
      const wait = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]!
      attempt += 1
      retryTimer = setTimeout(() => {
        if (mine === generation) connect(code, mine)
      }, wait)
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }

  /** Seated: read the match over HTTP once, then go live. */
  const seatIn = (code: string, mine: number) => {
    const s = secret()
    if (!s) return
    void getMatchState(code, s)
      .then((res) => {
        if (mine !== generation) return
        apply(res.state)
        connect(code, mine)
      })
      .catch((err: unknown) => {
        if (mine === generation) lose(code, err)
      })
  }

  const watchKnock = (code: string, knockSecret: string, mine: number) => {
    const check = () =>
      void getKnock(code, knockSecret)
        .then((res) => {
          if (mine !== generation) return
          set({ knock: res.knock })
          if (res.knock.status === "accepted") {
            saveSeat(code, { secret: knockSecret })
            if (knockTimer !== null) clearInterval(knockTimer)
            knockTimer = null
            set({ phase: "loading" })
            seatIn(code, mine)
          } else if (res.knock.status === "rejected") {
            forgetSeat(code)
            if (knockTimer !== null) clearInterval(knockTimer)
            knockTimer = null
          }
        })
        .catch((err: unknown) => {
          if (mine !== generation) return
          if (codeOf(err) === "wrong_secret" || codeOf(err) === "match_not_found") {
            forgetSeat(code)
            if (knockTimer !== null) clearInterval(knockTimer)
            knockTimer = null
            set({ knock: { code, status: "rejected", hostName: get().knock?.hostName ?? null } })
          }
        })
    if (knockTimer === null) knockTimer = setInterval(check, POLL_MS)
    check()
  }

  return {
    code: null,
    joinKey: null,
    phase: "loading",
    state: null,
    knock: null,
    shareUrl: null,
    error: null,
    notice: null,
    busy: false,
    transport: "offline",
    draft: "",
    rejection: null,
    strikesLeft: 0,
    skew: 0,

    open: (code, key) => {
      const mine = ++generation
      clearTimers()
      dropSocket()
      attempt = 0
      socketFatal = false
      const rec = seatFor(code)
      set({
        code,
        joinKey: key,
        phase: rec ? (rec.knocking ? "knocking" : "loading") : "door",
        state: null,
        knock: null,
        shareUrl: rec?.shareUrl ?? null,
        error: null,
        notice: null,
        busy: false,
        transport: "offline",
        draft: "",
        rejection: null,
      })
      if (!rec) return
      if (rec.knocking) watchKnock(code, rec.secret, mine)
      else seatIn(code, mine)
    },

    close: () => {
      generation += 1
      clearTimers()
      dropSocket()
      set({ code: null, state: null, knock: null, transport: "offline", draft: "", rejection: null, notice: null })
    },

    /** «ادخل» with the invite, or «اطرق الباب» with the code alone. */
    enter: async (name) => {
      const { code, joinKey, busy } = get()
      if (!code || busy) return
      const mine = generation
      const clean = name.trim() || null
      rememberName(clean)
      set({ busy: true, notice: null })
      try {
        if (joinKey) {
          const res = await joinMatch(code, joinKey, clean)
          if (mine !== generation) return
          saveSeat(code, { secret: res.secret })
          set({ busy: false })
          apply(res.state)
          connect(code, mine)
        } else {
          const res = await knockMatch(code, clean)
          if (mine !== generation || !res.secret) return
          saveSeat(code, { secret: res.secret, knocking: true })
          set({ busy: false, phase: "knocking", knock: res.knock })
          watchKnock(code, res.secret, mine)
        }
      } catch (err) {
        if (mine !== generation) return
        set({ busy: false, notice: messageOf(err) })
        if (codeOf(err) === "match_not_found") set({ phase: "gone", error: messageOf(err) })
        // A link that does not open the seat (cut short in a chat, or already
        // used) still names the match: the door turns into a knock.
        if (codeOf(err) === "needs_key") set({ joinKey: null })
      }
    },

    setDraft: (v) => set({ draft: v }),

    refresh: async () => {
      const { code } = get()
      const s = secret()
      if (!code || !s) return
      const mine = generation
      try {
        const res = await getMatchState(code, s)
        if (mine === generation) apply(res.state)
      } catch (err) {
        if (mine === generation) lose(code, err)
      }
    },

    submit: async (text) => {
      const { code, draft, busy } = get()
      const s = secret()
      const said = (text ?? draft).trim()
      if (!code || !s || !said || busy) return
      set({ busy: true, notice: null })
      try {
        const res = await playMatchTurn(code, s, said)
        set({
          busy: false,
          rejection: rejectionOf(res.verdict),
          strikesLeft: res.verdict.strikesLeft,
          draft: res.verdict.result.ok ? "" : get().draft,
        })
        apply(res.state)
      } catch (err) {
        set({ busy: false, notice: messageOf(err) })
        void get().refresh()
      }
    },

    act: async (action) => {
      const { code, busy } = get()
      const s = secret()
      if (!code || !s || busy) return
      set({ busy: true, notice: null })
      try {
        const res = await matchAction(code, s, action)
        set({ busy: false })
        apply(res.state)
      } catch (err) {
        set({ busy: false, notice: messageOf(err) })
        void get().refresh()
      }
    },

    dismissRejection: () => set({ rejection: null }),
  }
})
