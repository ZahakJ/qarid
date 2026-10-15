/**
 * `shared/match.ts` — the wire for the account-less مساجلة (`#/match/<CODE>`).
 *
 * Same game as the account rooms (`/api/room`, shared/schema.ts), different
 * door: nobody signs in. A seat is a per-match secret the server hands out at
 * create / join / knock and keeps only a hash of; the client holds it and sends
 * it back on every request (`X-Match-Seat`) and on the socket upgrade
 * (`qarid.seat.<secret>` subprotocol, because a WebView cannot set a header on
 * a WebSocket). See docs/online-match.md.
 *
 * Everything the two kinds of room share — the timers, the strike range, the
 * verdict tags, the chain state, the verifier's answer — is imported, not
 * re-spelled.
 */
import { z } from "zod"

import {
  BaitDtoSchema,
  ChainStateSchema,
  ROOM_STRIKES_DEFAULT,
  ROOM_STRIKES_MAX,
  ROOM_STRIKES_MIN,
  RoomEndReasonSchema,
  RoomModeSchema,
  RoomSeatSchema,
  RoomTimerSchema,
  RoomTurnVerdictSchema,
  RoomVerdictSchema,
} from "./schema.ts"

/** The HTTP header that carries a seat secret. */
export const MATCH_SEAT_HEADER = "X-Match-Seat"

/** The WebSocket subprotocol scheme that carries it on the upgrade. */
export const MATCH_WS_SEAT_PREFIX = "qarid.seat."

/**
 * Secret alphabet: 32 symbols, so a CSPRNG byte maps onto it with no modulo
 * bias, and no l/o/0/1 to misread. Every character is a valid HTTP token
 * character, which is what lets the secret ride in `Sec-WebSocket-Protocol`.
 */
export const MATCH_SECRET_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"

/** 26 × 5 bits = 130 bits for a seat. */
export const MATCH_SECRET_LENGTH = 26

/** 24 × 5 bits = 120 bits for the invite in the share link. */
export const MATCH_KEY_LENGTH = 24

export const MatchSecretSchema = z.string().regex(/^[a-km-np-z2-9]{26}$/)
export const MatchKeySchema = z.string().regex(/^[a-km-np-z2-9]{24}$/)

/** The display name cap, in code points. */
export const MATCH_NAME_MAX = 24

/**
 * A display name as the other player will see it, or null for none.
 *
 * NFKC first (so a full-width or compatibility form collapses to its plain
 * letter), then every control and format character goes — that includes the
 * bidi overrides and isolates that could flip the line it is printed in —
 * then whitespace runs collapse and the result is cut to `MATCH_NAME_MAX`
 * code points.
 */
export function normalizeMatchName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
  if (cleaned === "") return null
  return Array.from(cleaned).slice(0, MATCH_NAME_MAX).join("").trim() || null
}

const NameField = z
  .string()
  .max(200)
  .nullish()
  .transform((v) => normalizeMatchName(v))

// ── requests ──────────────────────────────────────────────────────────────

/** POST /api/match — the opening بيت is drawn by the server unless one is named. */
export const CreateMatchRequestSchema = z.object({
  name: NameField,
  baitId: z.number().int().positive().nullish().transform((v) => v ?? undefined),
  mode: RoomModeSchema.default("rhyme"),
  timerS: RoomTimerSchema.nullish().transform((v) => v ?? null),
  strikes: z.number().int().min(ROOM_STRIKES_MIN).max(ROOM_STRIKES_MAX).default(ROOM_STRIKES_DEFAULT),
})
export type CreateMatchRequest = z.input<typeof CreateMatchRequestSchema>

/** POST /api/match/:code/join — the invite out of `#/match/<CODE>?k=…`. */
export const JoinMatchRequestSchema = z.object({
  key: z.string().max(64),
  name: NameField,
})

/** POST /api/match/:code/knock — the code alone, spoken; the host decides. */
export const KnockMatchRequestSchema = z.object({ name: NameField })

/** POST /api/match/:code/turn */
export const MatchTurnRequestSchema = z.object({ text: z.string().min(1).max(600) })

// ── the snapshot ──────────────────────────────────────────────────────────

export const MatchStatusSchema = z.enum(["waiting", "active", "done"])
export type MatchStatus = z.infer<typeof MatchStatusSchema>

export const MatchPlayerSchema = z.object({
  seat: RoomSeatSchema,
  name: z.string().nullable(),
  /** strikes SPENT */
  strikes: z.number().int().nonnegative(),
  /** أبيات accepted from this seat */
  turns: z.number().int().nonnegative(),
  connected: z.boolean(),
})
export type MatchPlayer = z.infer<typeof MatchPlayerSchema>

export const MatchTurnSchema = z.object({
  turnNo: z.number().int().nonnegative(),
  seat: RoomSeatSchema,
  verdict: RoomTurnVerdictSchema,
  bait: BaitDtoSchema.nullable(),
  text: z.string().nullable(),
  playedAt: z.number().int().nonnegative(),
  msTaken: z.number().int().nonnegative().nullable(),
})
export type MatchTurn = z.infer<typeof MatchTurnSchema>

/**
 * THE snapshot, as one seat sees it. Every event carries one, the poller
 * returns one, every POST answers with one — a reconnect is just the next one.
 */
export const MatchStateSchema = z.object({
  code: z.string(),
  status: MatchStatusSchema,
  mode: RoomModeSchema,
  timerS: z.number().int().positive().nullable(),
  strikes: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable(),
  endedAt: z.number().int().nonnegative().nullable(),
  /** when a waiting match closes itself; null once it starts */
  expiresAt: z.number().int().nonnegative().nullable(),
  you: z.object({ seat: RoomSeatSchema, canPlay: z.boolean() }),
  host: MatchPlayerSchema,
  guest: MatchPlayerSchema.nullable(),
  turns: z.array(MatchTurnSchema),
  turnSeat: RoomSeatSchema.nullable(),
  required: ChainStateSchema.nullable(),
  deadlineAt: z.number().int().nonnegative().nullable(),
  serverNow: z.number().int().nonnegative(),
  winner: RoomSeatSchema.nullable(),
  endReason: RoomEndReasonSchema.nullable(),
  /** someone who has only the spoken code is asking in — host's view only */
  knock: z.object({ name: z.string().nullable() }).nullable(),
  /** bumped on every change; the newest snapshot wins on the client */
  rev: z.number().int().nonnegative(),
})
export type MatchState = z.infer<typeof MatchStateSchema>

export const MatchStateResponseSchema = z.object({ state: MatchStateSchema })
export type MatchStateResponse = z.infer<typeof MatchStateResponseSchema>

/** create: the host's seat, and the invite that rides in the share link */
export const MatchCreateResponseSchema = z.object({
  state: MatchStateSchema,
  secret: MatchSecretSchema,
  joinKey: MatchKeySchema,
  shareUrl: z.string(),
})
export type MatchCreateResponse = z.infer<typeof MatchCreateResponseSchema>

/** join: the guest's seat */
export const MatchJoinResponseSchema = z.object({ state: MatchStateSchema, secret: MatchSecretSchema })
export type MatchJoinResponse = z.infer<typeof MatchJoinResponseSchema>

export const MatchKnockStatusSchema = z.enum(["pending", "accepted", "rejected"])
export type MatchKnockStatus = z.infer<typeof MatchKnockStatusSchema>

/** What a knocker is told — never the match itself. */
export const MatchKnockViewSchema = z.object({
  code: z.string(),
  status: MatchKnockStatusSchema,
  hostName: z.string().nullable(),
})
export type MatchKnockView = z.infer<typeof MatchKnockViewSchema>

/** knock: the seat the host may grant, and its status */
export const MatchKnockResponseSchema = z.object({
  knock: MatchKnockViewSchema,
  secret: MatchSecretSchema.optional(),
})
export type MatchKnockResponse = z.infer<typeof MatchKnockResponseSchema>

export const MatchTurnResponseSchema = z.object({ verdict: RoomVerdictSchema, state: MatchStateSchema })
export type MatchTurnResponse = z.infer<typeof MatchTurnResponseSchema>

/** server → client over `/ws/match/:code`. Every event but `error` is a full snapshot. */
export const MatchEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: MatchStateSchema }),
  z.object({ type: z.literal("join"), state: MatchStateSchema }),
  z.object({ type: z.literal("turn"), state: MatchStateSchema, seat: RoomSeatSchema, verdict: RoomTurnVerdictSchema }),
  /** private: only the socket that submitted sees why its بيت was refused */
  z.object({ type: z.literal("verdict"), state: MatchStateSchema, verdict: RoomVerdictSchema }),
  z.object({ type: z.literal("end"), state: MatchStateSchema }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
])
export type MatchEvent = z.infer<typeof MatchEventSchema>

/** client → server */
export const MatchCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), text: z.string().min(1).max(600) }),
  z.object({ type: z.literal("state") }),
  z.object({ type: z.literal("ping") }),
])
export type MatchCommand = z.infer<typeof MatchCommandSchema>

export const MATCH_ERRORS: Record<string, string> = {
  match_not_found: "لا مساجلة بهذا الرمز",
  wrong_secret: "هذا المقعد ليس لك",
  needs_key: "الرابط لا يفتح هذه المساجلة",
  match_full: "المساجلة مكتملة",
  match_not_active: "المساجلة لم تبدأ، أو انتهت",
  not_your_turn: "ليس دورك",
  not_the_host: "لا يأذن إلا صاحب المساجلة",
  no_knock: "لا أحد على الباب",
  match_busy: "على الباب طارقٌ قبلك",
  cannot_knock: "لا يمكنك الطرق على هذه المساجلة",
  bad_bait: "هذا البيت لا يصلح مطلعًا",
  no_bait: "لم أجد بيتًا صالحًا للبدء",
  too_fast: "على رِسْلك",
  too_many_sockets: "فُتحت المساجلة في نوافذ كثيرة",
}
