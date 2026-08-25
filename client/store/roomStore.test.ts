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
import { describe, expect, it } from "vitest"

import { rejectionOf, roomTimeLeft, socketUrl } from "./roomStore.ts"
import type { BaitDto, RoomState, RoomVerdict } from "../../shared/schema.ts"

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
  const https = { protocol: "https:", host: "qarid.avicenna.space" }

  it("is same-origin, so the session cookie rides the upgrade", () => {
    expect(socketUrl("BADIRU", http)).toBe("ws://127.0.0.1:5751/ws/room/BADIRU")
  })

  it("follows the page's scheme — the tunnel is https and dev is not", () => {
    expect(socketUrl("BADIRU", https)).toBe("wss://qarid.avicenna.space/ws/room/BADIRU")
  })

  it("encodes whatever it is handed rather than trusting it into a URL", () => {
    expect(socketUrl("A B", http)).toContain("A%20B")
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

  it("copies the arrays it is handed — the card must not alias the store", () => {
    const source = { ok: false as const, reason: "not_found" as const, normalized: "x", suggestions: [BAIT] }
    const rejection = rejectionOf(verdict(source))
    expect(rejection).toMatchObject({ kind: "not_found" })
    if (rejection?.kind === "not_found") expect(rejection.suggestions).not.toBe(source.suggestions)
  })
})
