/**
 * `/api/match/*` — the account-less مساجلة. Every call that acts as a seat
 * carries the seat secret in `X-Match-Seat`; nothing else identifies a player.
 */
import { post, request } from "../api/client.ts"
import {
  MATCH_SEAT_HEADER,
  MatchCreateResponseSchema,
  MatchJoinResponseSchema,
  MatchKnockResponseSchema,
  MatchStateResponseSchema,
  MatchTurnResponseSchema,
  type CreateMatchRequest,
  type MatchCreateResponse,
  type MatchJoinResponse,
  type MatchKnockResponse,
  type MatchStateResponse,
  type MatchTurnResponse,
} from "../../shared/match.ts"

const at = (code: string, suffix: string) => `/api/match/${encodeURIComponent(code)}/${suffix}`

/** A fresh AbortController per call keeps two seats' identical GETs from being shared. */
function seatInit(secret: string): RequestInit {
  return { headers: { [MATCH_SEAT_HEADER]: secret }, signal: new AbortController().signal }
}

export function createMatch(body: CreateMatchRequest): Promise<MatchCreateResponse> {
  return post("/api/match", MatchCreateResponseSchema, body)
}

export function getMatchState(code: string, secret: string): Promise<MatchStateResponse> {
  return request(at(code, "state"), MatchStateResponseSchema, seatInit(secret))
}

export function joinMatch(code: string, key: string, name: string | null): Promise<MatchJoinResponse> {
  return post(at(code, "join"), MatchJoinResponseSchema, { key, name })
}

export function knockMatch(code: string, name: string | null): Promise<MatchKnockResponse> {
  return post(at(code, "knock"), MatchKnockResponseSchema, { name })
}

export function getKnock(code: string, secret: string): Promise<MatchKnockResponse> {
  return request(at(code, "knock"), MatchKnockResponseSchema, seatInit(secret))
}

export function playMatchTurn(code: string, secret: string, text: string): Promise<MatchTurnResponse> {
  return post(at(code, "turn"), MatchTurnResponseSchema, { text }, seatInit(secret))
}

export function matchAction(code: string, secret: string, action: "admit" | "refuse" | "resign"): Promise<MatchStateResponse> {
  return post(at(code, action), MatchStateResponseSchema, {}, seatInit(secret))
}
