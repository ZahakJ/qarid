/**
 * The room's two timers, and the slot they used to share.
 *
 * `startPolling()` refuses to start when `pollTimer` is already set — and
 * `ws.onopen` parked the 20-second HEARTBEAT in that same variable. So a socket
 * that opened and later DROPPED left the heartbeat installed, `reopen()`'s
 * `startPolling()` returned immediately, and the room refreshed every twenty
 * seconds while the header chip promised «يُحدَّث كل ثانيتين». On a 30-second
 * turn clock that is the opponent's بيت, a strike and the end of the match
 * arriving up to 20 s late. The one path where the 2-second poller really ran
 * was a socket that had NEVER opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { RoomState } from "../../shared/schema.ts"

const getRoomState = vi.fn()

vi.mock("../api/queries.ts", () => ({
  getRoomState: (...args: unknown[]) => getRoomState(...args),
  joinRoom: vi.fn(),
  playRoomTurn: vi.fn(),
  resignRoom: vi.fn(),
  rematchRoom: vi.fn(),
  createRoom: vi.fn(),
}))

const { POLL_MS, HEARTBEAT_MS, useRoom } = await import("./roomStore.ts")

/** The smallest snapshot `apply()` will accept. */
function snapshot(): RoomState {
  return { serverNow: Date.now(), deadlineAt: null, status: "active" } as unknown as RoomState
}

/** A WebSocket that does nothing until the test says so. */
class FakeSocket {
  static last: FakeSocket | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((evt: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.last = this
  }
  close(): void {
    this.closed = true
  }
}

/** Let every already-resolved promise in the store run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

beforeEach(() => {
  getRoomState.mockReset()
  getRoomState.mockResolvedValue({ state: snapshot() })
  FakeSocket.last = null
  vi.stubGlobal("WebSocket", FakeSocket)
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:5751" })
  vi.useFakeTimers()
})

afterEach(() => {
  useRoom.getState().close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the polling fallback", () => {
  it("really polls every two seconds after a live socket drops", async () => {
    useRoom.getState().open("BADIRU")
    await flush()
    expect(getRoomState).toHaveBeenCalledTimes(1)

    const ws = FakeSocket.last!
    ws.onopen!()
    expect(useRoom.getState().transport).toBe("socket")

    // The socket dies — a wifi blip, a lid, a proxy that culls idle upgrades.
    ws.onclose!()
    expect(useRoom.getState().transport).toBe("polling")

    // …and the room must now be refreshing at POLL_MS, not at HEARTBEAT_MS.
    await vi.advanceTimersByTimeAsync(POLL_MS + 100)
    await flush()
    expect(getRoomState.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("keeps the slow heartbeat while the socket is alive, and only that", async () => {
    useRoom.getState().open("BADIRU")
    await flush()
    FakeSocket.last!.onopen!()
    getRoomState.mockClear()

    // A live socket pushes everything; the heartbeat is only there to notice a
    // connection that died without ever firing `onclose`.
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    await flush()
    expect(getRoomState).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    await flush()
    expect(getRoomState).toHaveBeenCalled()
  })

  it("polls when the socket never opened at all", async () => {
    useRoom.getState().open("BADIRU")
    await flush()
    FakeSocket.last!.onclose!()
    getRoomState.mockClear()

    await vi.advanceTimersByTimeAsync(POLL_MS + 100)
    await flush()
    expect(getRoomState).toHaveBeenCalled()
  })

  it("carries the invite key into every poll and into the socket URL", async () => {
    useRoom.getState().open("BADIRU", "abc23xyzabc23xyzabc23xyz")
    await flush()
    expect(getRoomState).toHaveBeenCalledWith("BADIRU", "abc23xyzabc23xyzabc23xyz")
    expect(FakeSocket.last!.url).toContain("?k=abc23xyzabc23xyzabc23xyz")
  })
})

describe("a fatal socket close stops the reconnect loop", () => {
  /**
   * The native room-socket defect: a WebView upgrade the server cannot
   * authenticate answers one `error: unauthenticated` frame and closes — and the
   * old `onclose = reopen` reconnected regardless, ~40 times over 16 s against a
   * door that would never open. A FATAL close must fall to the HTTP poller (which
   * carries the bearer like every other call) and NOT reconnect.
   */
  it("does not reopen after an unauthenticated close, and the poller keeps the room live", async () => {
    useRoom.getState().open("BADIRU")
    await flush()
    const ws = FakeSocket.last!
    ws.onopen!()
    expect(useRoom.getState().transport).toBe("socket")

    // The server rejects the upgrade: an error frame, then the close.
    ws.onmessage!({ data: JSON.stringify({ type: "error", code: "unauthenticated", message: "ادخل بحسابك أوّلًا" }) })
    const rejected = FakeSocket.last
    ws.onclose!()
    expect(useRoom.getState().transport).toBe("polling")

    // No new socket, not now and not after the whole backoff schedule elapses.
    await vi.advanceTimersByTimeAsync(20_000)
    await flush()
    expect(FakeSocket.last).toBe(rejected)

    // …and the poller is the live channel now.
    getRoomState.mockClear()
    await vi.advanceTimersByTimeAsync(POLL_MS + 100)
    await flush()
    expect(getRoomState).toHaveBeenCalled()
  })

  it("a NON-fatal drop still reconnects — this must not stop an ordinary blip", async () => {
    useRoom.getState().open("BADIRU")
    await flush()
    const first = FakeSocket.last!
    first.onopen!()
    // A plain drop (no error frame) — a wifi blip, a culled idle upgrade.
    first.onclose!()
    // The first backoff is 400 ms; a new socket is constructed after it.
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(FakeSocket.last).not.toBe(first)
  })
})
