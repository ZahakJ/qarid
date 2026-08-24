/**
 * Named API methods — the whole client's vocabulary for talking to the server.
 * Nothing outside this file builds an `/api/...` path, and nothing outside
 * `client.ts` calls `fetch` (design-ux.md §6).
 *
 * Every method returns the OUTPUT type of the zod schema in shared/schema.ts,
 * so a server that drifts fails loudly in `client.ts` instead of quietly
 * rendering `undefined` into a بيت.
 *
 * Two encoding rules the server taught us:
 *  • poet slugs are Arabic for the 73% of the corpus with no source URL —
 *    always `encodeURIComponent` them into the path.
 *  • Arabic QUERY values (`rhyme=م`) must be percent-encoded too; `qs()` uses
 *    URLSearchParams, which does that for us.
 */
import {
  BaitDtoSchema,
  BaitsResponseSchema,
  BaitDetailResponseSchema,
  DailyResponseSchema,
  FacetsResponseSchema,
  LIMITS,
  MAX_POET_SLUGS,
  MetaResponseSchema,
  PoemBaitsResponseSchema,
  PoemDetailResponseSchema,
  PoemsResponseSchema,
  PoetPageResponseSchema,
  PoetsResponseSchema,
  GameHintResponseSchema,
  GamePoolResponseSchema,
  GameReplyResponseSchema,
  GameStartResponseSchema,
  GameVerifyResponseSchema,
  SearchResponseSchema,
  SimilarPoemsResponseSchema,
  StatsResponseSchema,
  TrainCandidatesResponseSchema,
  type BaitDetailResponse,
  type BaitDto,
  type BaitsResponse,
  type DailyResponse,
  type FacetsResponse,
  type MetaResponse,
  type PoemBaitsResponse,
  type PoemDetailResponse,
  type PoemsResponse,
  type PoetPageResponse,
  type PoetsResponse,
  type GameHintRequest,
  type GameHintResponse,
  type GamePoolResponse,
  type GameReplyRequest,
  type GameReplyResponse,
  type GameStartRequest,
  type GameStartResponse,
  type GameVerifyRequest,
  type GameVerifyResponse,
  type SearchResponse,
  type SimilarPoemsResponse,
  type StatsResponse,
  type TrainCandidatesResponse,
} from "../../shared/schema.ts"
import { post, qs, request } from "./client.ts"

/** Anything a caller may hand a query builder. */
type Params = Record<string, string | number | boolean | null | undefined>

/** Per-view AbortController; passing one also opts out of in-flight dedupe. */
type Opts = { signal?: AbortSignal }

function init(o?: Opts): RequestInit | undefined {
  return o?.signal ? { signal: o.signal } : undefined
}

function poemPath(publicId: string, suffix = ""): string {
  return `/api/poems/${encodeURIComponent(publicId)}${suffix}`
}

function poetPath(slug: string, suffix = ""): string {
  return `/api/poets/${encodeURIComponent(slug)}${suffix}`
}

// ── corpus-wide ────────────────────────────────────────────────────────────

/** Build id, counts, and the meters / eras / themes / letters lookups. */
export function getMeta(o?: Opts): Promise<MetaResponse> {
  return request("/api/meta", MetaResponseSchema, init(o))
}

export function getStats(o?: Opts): Promise<StatsResponse> {
  return request("/api/stats", StatsResponseSchema, init(o))
}

/** Counts for EVERY facet value under the current filter, zeros included. */
export function getFacets(params: Params = {}, o?: Opts): Promise<FacetsResponse> {
  return request(qs("/api/facets", params), FacetsResponseSchema, init(o))
}

// ── poems ──────────────────────────────────────────────────────────────────

export function listPoems(params: Params = {}, o?: Opts): Promise<PoemsResponse> {
  return request(qs("/api/poems", params), PoemsResponseSchema, init(o))
}

/**
 * The قصيدة with its FIRST page of أبيات (≤200). `total` is the whole poem —
 * the rest comes from `getPoemBaits`.
 */
export function getPoem(
  publicId: string,
  params: { offset?: number; limit?: number } = {},
  o?: Opts,
): Promise<PoemDetailResponse> {
  return request(qs(poemPath(publicId), params), PoemDetailResponseSchema, init(o))
}

/** One more page of أبيات — the 11,608-hemistich قصيدة is why this exists. */
export function getPoemBaits(
  publicId: string,
  params: { offset?: number; limit?: number } = {},
  o?: Opts,
): Promise<PoemBaitsResponse> {
  return request(
    qs(poemPath(publicId, "/baits"), { limit: LIMITS.maxBaitsLimit, ...params }),
    PoemBaitsResponseSchema,
    init(o),
  )
}

/** amendments.md §9 — «قصائد على الوزن والقافية». */
export function getSimilarPoems(publicId: string, limit = 8, o?: Opts): Promise<SimilarPoemsResponse> {
  return request(qs(poemPath(publicId, "/similar"), { limit }), SimilarPoemsResponseSchema, init(o))
}

// ── poets ──────────────────────────────────────────────────────────────────

export function listPoets(params: Params = {}, o?: Opts): Promise<PoetsResponse> {
  return request(qs("/api/poets", params), PoetsResponseSchema, init(o))
}

/**
 * Batch lookup: full `PoetSummary` rows for up to `MAX_POET_SLUGS` شعراء, in
 * the order asked. The duel summary's «الشعراء الذين لقيتهم» grid is the one
 * caller — an `Exchange` denormalizes only `{slug, name}`, and a PoetCard needs
 * عصر, ديوان size and a ترجمة. Slugs the artefact does not carry come back
 * absent, never as an error.
 */
export function getPoetsBySlugs(slugs: readonly string[], o?: Opts): Promise<PoetsResponse> {
  const wanted = slugs.slice(0, MAX_POET_SLUGS)
  if (wanted.length === 0) return Promise.resolve({ items: [], total: 0, page: 1, limit: MAX_POET_SLUGS })
  return request(qs("/api/poets", { slugs: wanted.join(",") }), PoetsResponseSchema, init(o))
}

export function getPoet(slug: string, o?: Opts): Promise<PoetPageResponse> {
  return request(poetPath(slug), PoetPageResponseSchema, init(o))
}

export function listPoetPoems(slug: string, params: Params = {}, o?: Opts): Promise<PoemsResponse> {
  return request(qs(poetPath(slug, "/poems"), params), PoemsResponseSchema, init(o))
}

// ── أبيات ──────────────────────────────────────────────────────────────────

/** بيت-mode browse — what #/browse switches to when روي / حرف is active. */
export function listBaits(params: Params = {}, o?: Opts): Promise<BaitsResponse> {
  return request(qs("/api/baits", params), BaitsResponseSchema, init(o))
}

export function getBait(id: number, o?: Opts): Promise<BaitDetailResponse> {
  return request(`/api/baits/${id}`, BaitDetailResponseSchema, init(o))
}

/** بيت اليوم + شاعر اليوم, seeded on the Asia/Riyadh date. */
export function getDailyBait(date?: string, o?: Opts): Promise<DailyResponse> {
  return request(qs("/api/baits/daily", { date }), DailyResponseSchema, init(o))
}

export function getRandomBait(params: Params = {}, o?: Opts): Promise<BaitDto> {
  return request(qs("/api/baits/random", params), BaitDtoSchema, init(o))
}

// ── search / training ──────────────────────────────────────────────────────

export function search(params: Params, o?: Opts): Promise<SearchResponse> {
  return request(qs("/api/search", params), SearchResponseSchema, init(o))
}

export function getTrainCandidates(params: Params = {}, o?: Opts): Promise<TrainCandidatesResponse> {
  return request(qs("/api/train/candidates", params), TrainCandidatesResponseSchema, init(o))
}

// ── المساجلة (POST /api/game/*, design-server.md §8) ────────────────────────
//
// The duel is stateless on the wire: every request carries the transcript's
// exclusions and the client holds the score. A rejected بيت comes back 200 with
// `ok:false` — a game outcome, not a protocol error — so ApiError is reserved
// for the network genuinely failing, which the machine turns into a soft
// rejection that costs no life.

/** amendment 2 — the setup screen's live «العدد المتاح» counter (a point lookup). */
export function getGamePool(params: Params = {}, o?: Opts): Promise<GamePoolResponse> {
  return request(qs("/api/game/pool", params), GamePoolResponseSchema, init(o))
}

/** The opponent opens the مساجلة. */
export function gameStart(body: Partial<GameStartRequest>, o?: Opts): Promise<GameStartResponse> {
  return post("/api/game/start", GameStartResponseSchema, body, init(o))
}

/** Is the player's بيت in the ديوان, and does it chain? The server decides. */
export function gameVerify(body: GameVerifyRequest | Record<string, unknown>, o?: Opts): Promise<GameVerifyResponse> {
  return post("/api/game/verify", GameVerifyResponseSchema, body, init(o))
}

/** The opponent answers — or `no_bait`, which is «أفحمتَ الخصم». */
export function gameReply(body: GameReplyRequest | Record<string, unknown>, o?: Opts): Promise<GameReplyResponse> {
  return post("/api/game/reply", GameReplyResponseSchema, body, init(o))
}

/** «من قائله؟» «أول كلمة» «البحر» «بدّل الحرف» (amendments.md §8). */
export function gameHint(body: GameHintRequest | Record<string, unknown>, o?: Opts): Promise<GameHintResponse> {
  return post("/api/game/hint", GameHintResponseSchema, body, init(o))
}
