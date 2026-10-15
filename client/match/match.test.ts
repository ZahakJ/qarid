import { describe, expect, it } from "vitest"

import { pageKey, parseHash, routeHash, routeTitle } from "../router.ts"
import { matchSocketUrl, matchTimeLeft, seatSubprotocol } from "./matchStore.ts"
import type { MatchState } from "../../shared/match.ts"

describe("#/match/<CODE>", () => {
  it("canonicalizes a spoken code and carries the invite", () => {
    expect(parseHash("#/match/badiru")).toEqual({ view: "match", code: "BADIRU" })
    expect(parseHash("#/match/BADIRU?k=abc23xyz")).toEqual({ view: "match", code: "BADIRU", key: "abc23xyz" })
    expect(routeHash({ view: "match", code: "BADIRU", key: "abc23xyz" })).toBe("#/match/BADIRU?k=abc23xyz")
    expect(routeHash({ view: "match", code: "BADIRU" })).toBe("#/match/BADIRU")
    expect(pageKey({ view: "match", code: "BADIRU", key: "x" })).toBe("match:BADIRU")
    expect(routeTitle({ view: "match", code: "BADIRU" })).toBe("مساجلة")
  })

  it("falls back home on a code that is not one", () => {
    for (const bad of ["#/match/", "#/match/ABC", "#/match/BAD1RU"]) expect(parseHash(bad)).toEqual({ view: "home" })
  })
})

describe("the match socket", () => {
  it("targets the API host and carries the seat as a subprotocol, never in the URL", () => {
    expect(matchSocketUrl("BADIRU", { protocol: "https:", host: "qarid.example" })).toBe("wss://qarid.example/ws/match/BADIRU")
    expect(matchSocketUrl("BADIRU", { protocol: "http:", host: "127.0.0.1:5751" })).toBe("ws://127.0.0.1:5751/ws/match/BADIRU")
    expect(seatSubprotocol("abc")).toBe("qarid.seat.abc")
  })

  it("counts the turn down on the server's clock", () => {
    const state = { deadlineAt: 10_000 } as MatchState
    expect(matchTimeLeft(state, 0, 4_000)).toBe(6_000)
    expect(matchTimeLeft(state, 1_000, 4_000)).toBe(5_000)
    expect(matchTimeLeft(state, 0, 20_000)).toBe(0)
    expect(matchTimeLeft({ deadlineAt: null } as MatchState, 0)).toBeNull()
  })
})
