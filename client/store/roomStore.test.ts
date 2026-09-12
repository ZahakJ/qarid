/**
 * The pure half of the room client (v2.md §5).
 *
 * There is deliberately not much of it, and that is the design: the store
 * renders the server's snapshot and computes nothing about the game. What IS
 * worth pinning is the three places where the client is allowed to do
 * arithmetic or translation at all — the socket URL, the server-clock offset,
 * and the mapping from a verify rejection to the card the duel already knows
 * how to draw.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { bearerSubprotocol, rejectionOf, rematchIsNew, roomTimeLeft, socketUrl } from "./roomStore.ts"
import { COSTS_LIFE, titleOf } from "../duel/RejectionCard.tsx"
import { ROOM_WS_BEARER_PREFIX, type BaitDto, type RoomState, type RoomVerdict } from "../../shared/schema.ts"

const BAIT: BaitDto = {
  id: 7,
  baytKey: "q1:3",
  position: 3,
  sadr: "قفا نبكِ من ذكرى حبيبٍ ومنزلِ",
  ajuz: "بسِقطِ اللوى بين الدَخولِ فحَومَلِ",
  rawiyy: "ل",
  lastLetter: "ل",
  firstLetter: "ق",
  isPartial: false,
  poem: { id: "q1", poemId: 1, title: "معلقة امرئ القيس" },
  poet: { slug: "imru-alqais", name: "امرؤ القيس" },
  meter: null,
  era: null,
}

function verdict(result: RoomVerdict["result"], strike = false): RoomVerdict {
  return { result, strike, strikesLeft: 2 }
}

describe("socketUrl", () => {
  const http = { protocol: "http:", host: "127.0.0.1:5751" }
  const https = { protocol: "https:", host: "qarid.example.com" }

  it("is same-origin, so the session cookie rides the upgrade", () => {
    expect(socketUrl("BADIRU", null, http)).toBe("ws://127.0.0.1:5751/ws/room/BADIRU")
  })

  it("follows the page's scheme — the tunnel is https and dev is not", () => {
    expect(socketUrl("BADIRU", null, https)).toBe("wss://qarid.example.com/ws/room/BADIRU")
  })

  it("encodes whatever it is handed rather than trusting it into a URL", () => {
    expect(socketUrl("A B", null, http)).toContain("A%20B")
  })

  it("carries the invite key a spectator needs, and nothing when there is none", () => {
    // A watcher's upgrade is checked exactly like `GET /:code/state`: the
    // socket streams the same transcript, so it needs the same proof.
    expect(socketUrl("BADIRU", "abc23xyz", https)).toBe("wss://qarid.example.com/ws/room/BADIRU?k=abc23xyz")
    expect(socketUrl("BADIRU", null, https)).not.toContain("?")
  })
})

describe("bearerSubprotocol", () => {
  it("offers the bearer as a subprotocol in the native shell — the one header a WS can set", () => {
    // A WebView cannot set `Authorization` on an upgrade, so the token rides in
    // `Sec-WebSocket-Protocol` via the constructor's protocols argument.
    expect(bearerSubprotocol(true, "tok_abc-123")).toBe(`${ROOM_WS_BEARER_PREFIX}tok_abc-123`)
  })

  it("offers NOTHING on the web — the same-origin cookie authenticates the upgrade", () => {
    // Undefined means `new WebSocket(url)` with no protocols: the web path is
    // byte-for-byte unchanged and the cookie carries the session.
    expect(bearerSubprotocol(false, "tok_abc-123")).toBeUndefined()
  })

  it("offers nothing when the native shell holds no token yet", () => {
    expect(bearerSubprotocol(true, null)).toBeUndefined()
  })
})

describe("rematchIsNew", () => {
  it("follows a رجعة that opens while you are watching", () => {
    expect(rematchIsNew(null, "BADIRU")).toBe(true)
  })

  it("does NOT follow one that was already there when the room loaded", () => {
    // `rooms.rematch_code` is permanent and rides on every later snapshot, so
    // redirecting on its presence bounced any viewer who opened an old room —
    // through every generation, 900 ms apart, out into the newest one. From the
    // profile's match list that made every older transcript unreachable.
    expect(rematchIsNew("BADIRU", "BADIRU")).toBe(false)
  })

  it("waits for the first snapshot before deciding anything", () => {
    expect(rematchIsNew(undefined, "BADIRU")).toBe(false)
  })

  it("is false when there is no رجعة at all", () => {
    expect(rematchIsNew(null, null)).toBe(false)
    expect(rematchIsNew("BADIRU", null)).toBe(false)
  })
})

describe("roomTimeLeft", () => {
  const state = (deadlineAt: number | null): RoomState =>
    ({ deadlineAt, serverNow: 0 }) as unknown as RoomState

  it("is null when the room has no clock at all", () => {
    expect(roomTimeLeft(state(null), 0, 1000)).toBeNull()
    expect(roomTimeLeft(null, 0, 1000)).toBeNull()
  })

  it("counts down on the SERVER's clock, not the browser's", () => {
    // The browser is four minutes ahead; the server's deadline is 30 s away.
    const skew = -240_000
    const now = 1_000_000
    const deadline = now + skew + 30_000
    expect(roomTimeLeft(state(deadline), skew, now)).toBe(30_000)
  })

  it("never goes below zero — a passed deadline is 0, not a negative clock", () => {
    expect(roomTimeLeft(state(500), 0, 5000)).toBe(0)
  })
})

describe("rejectionOf", () => {
  it("is null for an accepted بيت", () => {
    const ok = { ok: true } as unknown as RoomVerdict["result"]
    expect(rejectionOf(verdict(ok))).toBeNull()
  })

  it("carries every rejection tag through to the duel's own card", () => {
    expect(
      rejectionOf(
        verdict({ ok: false, reason: "wrong_letter", expected: "م", alsoAccepted: ["ه"], got: "ق", normalized: "x" }),
      ),
    ).toEqual({ kind: "wrong_letter", expected: "م", alsoAccepted: ["ه"], got: "ق", normalized: "x" })

    expect(rejectionOf(verdict({ ok: false, reason: "already_used", bait: BAIT }))).toEqual({
      kind: "already_used",
      bait: BAIT,
    })

    expect(rejectionOf(verdict({ ok: false, reason: "not_found", normalized: "x", suggestions: [BAIT] }))).toEqual({
      kind: "not_found",
      normalized: "x",
      suggestions: [BAIT],
    })

    expect(
      rejectionOf(verdict({ ok: false, reason: "near_miss", normalized: "x", suggestion: BAIT, score: 0.5, acceptCost: 25 })),
    ).toMatchObject({ kind: "near_miss", score: 0.5, acceptCost: 25 })

    expect(rejectionOf(verdict({ ok: false, reason: "ambiguous", normalized: "x", candidates: [BAIT, BAIT] }))).toMatchObject({
      kind: "ambiguous",
    })

    expect(rejectionOf(verdict({ ok: false, reason: "incomplete_bait", bait: BAIT }))).toMatchObject({
      kind: "incomplete_bait",
    })

    expect(rejectionOf(verdict({ ok: false, reason: "too_short", words: 1 }))).toEqual({ kind: "too_short", words: 1 })

    expect(rejectionOf(verdict({ ok: false, reason: "no_bait", letter: "ظ" }))).toEqual({ kind: "no_bait", letter: "ظ" })
  })

  /**
   * The ديوان room's own refusal, on both halves of the wire it crosses: the
   * store must carry it into the card's shape, and the card must NOT charge for
   * it. It is a real بيت on the required letter that is simply not on the shelf
   * — `wrong_letter`'s shape, not `not_found`'s — so it is a strike nowhere:
   * not on the server (server/rooms.ts writes no row), and not in the wording
   * here.
   */
  it("carries «ليس من هذا الديوان», names the shelf, and costs nothing", () => {
    const r = rejectionOf(verdict({ ok: false, reason: "not_in_album", bait: BAIT, albumTitle: "ما أحفظ" }))
    expect(r).toEqual({ kind: "not_in_album", bait: BAIT, albumTitle: "ما أحفظ" })
    expect(titleOf(r!)).toBe("ليس من هذا الديوان")
    expect(COSTS_LIFE.has("not_in_album")).toBe(false)
  })

  it("copies the arrays it is handed — the card must not alias the store", () => {
    const source = { ok: false as const, reason: "not_found" as const, normalized: "x", suggestions: [BAIT] }
    const rejection = rejectionOf(verdict(source))
    expect(rejection).toMatchObject({ kind: "not_found" })
    if (rejection?.kind === "not_found") expect(rejection.suggestions).not.toBe(source.suggestions)
  })
})


describe("the dev proxy carries the upgrade", () => {
  /**
   * `ws: true` is the whole of it, and losing it is the worst-shaped bug this
   * feature can have: vite owns `upgrade` for its own HMR socket, so without
   * the flag it answers `/ws/room/<code>` itself, the room silently falls back
   * to the two-second poller in DEV, and production — where the socket goes
   * straight to the node server — keeps working perfectly.
   */
  it("proxies /ws to the API server with ws: true", () => {
    const config = readFileSync(path.join(import.meta.dirname, "..", "..", "vite.config.ts"), "utf8")
    const entry = config.slice(config.indexOf('"/ws"'), config.indexOf('"/ws"') + 120)
    expect(entry).toContain("ws: true")
    expect(entry).toContain("target: API")
  })
})
