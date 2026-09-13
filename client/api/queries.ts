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
  AccountDeleteResponseSchema,
  AlbumAddEntriesResponseSchema,
  AlbumDeleteResponseSchema,
  AlbumMutationResponseSchema,
  AlbumPoolResponseSchema,
  AlbumResponseSchema,
  AlbumSaveResponseSchema,
  AlbumsResponseSchema,
  AnthologiesResponseSchema,
  AnthologyResponseSchema,
  BuhurResponseSchema,
  ArsenalSyncResponseSchema,
  AuthLogoutResponseSchema,
  AuthMeResponseSchema,
  AuthSessionResponseSchema,
  AvatarMutationResponseSchema,
  BlockMutationResponseSchema,
  BlocksResponseSchema,
  RecoveryRegenerateResponseSchema,
  ReportResponseSchema,
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
  ProfileResponseSchema,
  RoomKnockResponseSchema,
  RoomOpeningResponseSchema,
  RoomPlayableResponseSchema,
  RoomStateResponseSchema,
  RoomTurnResponseSchema,
  GameHintResponseSchema,
  GameAssistResponseSchema,
  GamePoolResponseSchema,
  GameReplyResponseSchema,
  GameStartResponseSchema,
  GameVerifyResponseSchema,
  SearchResponseSchema,
  SimilarPoemsResponseSchema,
  StatsResponseSchema,
  TrainCandidatesResponseSchema,
  type AccountDeleteResponse,
  type Arsenal,
  type ArsenalSyncResponse,
  type AuthLogoutResponse,
  type AuthMeResponse,
  type AuthSessionResponse,
  type AvatarMutationResponse,
  type BlockMutationResponse,
  type BlocksResponse,
  type ReportReason,
  type ReportResponse,
  type BaitDetailResponse,
  type BaitDto,
  type BaitsResponse,
  type DailyResponse,
  type FacetsResponse,
  type AlbumAddEntriesResponse,
  type AlbumAddItem,
  type AlbumCreateInput,
  type AlbumDeleteResponse,
  type AlbumMutationResponse,
  type AlbumPatchInput,
  type AlbumPoolResponse,
  type AlbumResponse,
  type AlbumSaveResponse,
  type AlbumsResponse,
  type AnthologiesResponse,
  type BuhurResponse,
  type AnthologyResponse,
  type MetaResponse,
  type PoemBaitsResponse,
  type PoemDetailResponse,
  type PoemsResponse,
  type PoetPageResponse,
  type PoetsResponse,
  type ProfileResponse,
  type PasswordResetRequest,
  type RecoveryRegenerateResponse,
  type CreateRoomRequest,
  type RoomKnockResponse,
  type RoomOpeningResponse,
  type RoomPlayableResponse,
  type RoomStateResponse,
  type RoomTurnResponse,
  type RegisterRequest,
  type LoginRequest,
  type GameHintRequest,
  type GameHintResponse,
  type GameAssistResponse,
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

/** المختارات المنظومة — the shelves, with what the corpus answered. */
export function getAnthologies(o?: Opts): Promise<AnthologiesResponse> {
  return request("/api/anthologies", AnthologiesResponseSchema, init(o))
}

/** One shelf, every curated entry in order — unresolved ones included. */
export function getAnthology(slug: string, o?: Opts): Promise<AnthologyResponse> {
  return request(`/api/anthologies/${encodeURIComponent(slug)}`, AnthologyResponseSchema, init(o))
}

/**
 * صفحة البحور's sixteen example أبيات — one per بحر, fame-first, memoised and
 * pre-warmed on the server (server/routes/buhur.ts). Everything ELSE the page
 * prints is already here: the تفعيلات, الدائرة and المفتاح ship in the bundle
 * (`client/data/buhur.ts`) and the count of قصائد is `/api/meta`'s
 * `meters[].poemCount`, so this is the page's only new request.
 */
export function getBuhur(o?: Opts): Promise<BuhurResponse> {
  return request("/api/buhur", BuhurResponseSchema, init(o))
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

/**
 * The global palette's one round trip (v2.md §3).
 *
 * `scope=all` already answers all three lists, and its شعراء half is ranked
 * name-hit → fame → bm25 (`rankedPoetRefs` in server/search.ts), which is
 * exactly the "fame-first" order the palette promises — so the palette needs no
 * combined mode of its own. `limit` is the BIGGEST group it renders; the other
 * two are trimmed client-side by `paletteGroups`, because `/api/search` pages
 * the three lists with one limit and three requests to save four rows would be
 * three ranked scans.
 *
 * `mode` is deliberately unset: that is what arms the server's AND-then-OR
 * fallback, so a half-remembered بيت still answers something.
 */
export function searchPalette(q: string, limit: number, o?: Opts): Promise<SearchResponse> {
  return request(qs("/api/search", { q, scope: "all", limit }), SearchResponseSchema, init(o))
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

/**
 * وضع التدريب's suggestion rail (v2.md §2) — real أبيات that open on `letter`
 * and carry what the player has typed. GET, so it is the one duel call a
 * browser may cache; the client debounces and remembers its own answers
 * (client/duel/assist.ts) rather than leaning on that.
 */
export function getGameAssist(params: Params, o?: Opts): Promise<GameAssistResponse> {
  return request(qs("/api/game/assist", params), GameAssistResponseSchema, init(o))
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

// ── الحسابات (v2.md §4) ─────────────────────────────────────────────────────
//
// The session lives in an HttpOnly cookie, which `fetch` sends on its own for a
// same-origin request (credentials default to "same-origin"): there is no token
// for this file to carry and nothing for the client to store. `getMe` is the
// one call the shell makes on boot, and it answers 200 with `user: null` when
// nobody is signed in — never a 401 the console would log.

export function getMe(o?: Opts): Promise<AuthMeResponse> {
  return request("/api/auth/me", AuthMeResponseSchema, init(o))
}

export function register(body: RegisterRequest, o?: Opts): Promise<AuthSessionResponse> {
  return post("/api/auth/register", AuthSessionResponseSchema, body, init(o))
}

export function login(body: LoginRequest, o?: Opts): Promise<AuthSessionResponse> {
  return post("/api/auth/login", AuthSessionResponseSchema, body, init(o))
}

export function logout(o?: Opts): Promise<AuthLogoutResponse> {
  return post("/api/auth/logout", AuthLogoutResponseSchema, {}, init(o))
}

/**
 * Reset a forgotten password with the recovery code — unauthenticated. On
 * success the account is re-keyed, every session revoked, and a NEW recovery
 * code returned once (the used one is rotated). The reader lands signed in.
 */
export function resetPassword(body: PasswordResetRequest, o?: Opts): Promise<AuthSessionResponse> {
  return post("/api/auth/reset", AuthSessionResponseSchema, body, init(o))
}

/**
 * Regenerate the recovery code for the signed-in account (the signup one may be
 * lost). Invalidates the old and returns the new once — the server keeps only
 * its hash.
 */
export function regenerateRecovery(o?: Opts): Promise<RecoveryRegenerateResponse> {
  return post("/api/auth/recovery", RecoveryRegenerateResponseSchema, {}, init(o))
}

/** `#/u/<username>` — the public page. Usernames may be Arabic; encode them. */
export function getProfile(username: string, o?: Opts): Promise<ProfileResponse> {
  return request(`/api/profile/${encodeURIComponent(username)}`, ProfileResponseSchema, init(o))
}

// ── moderation (Track 3) ────────────────────────────────────────────────────
//
// Report and block are logged-in, per-cookie writes behind the same CSRF
// originGuard and `application/json` body reader as auth/profile. Blocking is
// PRIVATE — the blocked account is never told — so nothing here surfaces the
// action to anyone but the reader who took it.

/** Report another account to the owner. `note`/`context` are optional breadcrumbs. */
export function reportUser(
  body: {
    targetUsername?: string
    /** the ديوان being reported — the server derives the account from it */
    albumCode?: string
    reason: ReportReason
    note?: string
    context?: string
  },
  o?: Opts,
): Promise<ReportResponse> {
  return post("/api/report", ReportResponseSchema, body, init(o))
}

/** The reader's own block list — the settings «المحظورون» section reads it. */
export function getBlocks(o?: Opts): Promise<BlocksResponse> {
  return request("/api/block", BlocksResponseSchema, init(o))
}

/** Block one account; answers with the block list as it now stands. */
export function blockUser(username: string, o?: Opts): Promise<BlockMutationResponse> {
  return post("/api/block", BlockMutationResponseSchema, { username }, init(o))
}

/** Unblock one account. DELETE carries the name in a JSON body, like every write here. */
export function unblockUser(username: string, o?: Opts): Promise<BlockMutationResponse> {
  return request("/api/block", BlockMutationResponseSchema, {
    ...init(o),
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  })
}

export function updateProfile(displayName: string, o?: Opts): Promise<ProfileResponse> {
  return post("/api/profile/update", ProfileResponseSchema, { displayName }, init(o))
}

/** Opt-in ترسانة sync — the snapshot the profile page shows a visitor. */
export function syncArsenal(arsenal: Arsenal, o?: Opts): Promise<ArsenalSyncResponse> {
  return post("/api/profile/arsenal", ArsenalSyncResponseSchema, { arsenal }, init(o))
}

/**
 * IRREVERSIBLY delete the signed-in account (a Google Play requirement). The
 * password is re-entered as confirmation and verified server-side; on success
 * every trace of the account is gone and the caller clears its local auth state.
 */
export function deleteAccount(password: string, o?: Opts): Promise<AccountDeleteResponse> {
  return post("/api/profile/delete", AccountDeleteResponseSchema, { password }, init(o))
}

/**
 * Upload YOUR OWN avatar (owner's request). The `blob` is the already-cropped,
 * already-resized image the ProfileView produced with a canvas — the server
 * validates it by magic bytes, caps its size, and answers with the new
 * versioned URL. `Content-Type` is the blob's real type (an image type, not a
 * CORS-simple one), which is a second lock beside the CSRF originGuard.
 */
export function uploadAvatar(blob: Blob, o?: Opts): Promise<AvatarMutationResponse> {
  return request("/api/profile/avatar", AvatarMutationResponseSchema, {
    ...init(o),
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  })
}

/** Remove YOUR OWN avatar — back to the نِيب disc. */
export function removeAvatar(o?: Opts): Promise<AvatarMutationResponse> {
  return request("/api/profile/avatar", AvatarMutationResponseSchema, { ...init(o), method: "DELETE" })
}

// ── مساجلة rooms (v2.md §5) ────────────────────────────────────────────────
//
// Every one of these answers with the WHOLE room state, which is the same
// payload `/ws/room/<code>` pushes — so a client that has no socket (a proxy
// that strips upgrades, a tab that lost the connection) plays the same game
// through `getRoomState` on a timer. There is one shape to render, not two.

/** «عشوائي» — one بيت the game pool guarantees is answerable (v2.md §5). */
export function getRoomOpening(o?: Opts): Promise<RoomOpeningResponse> {
  return request("/api/room/opening", RoomOpeningResponseSchema, init(o))
}

/**
 * Which of these أبيات may open a مساجلة — the picker's filter.
 *
 * `/api/search` searches the whole ديوان; `game_baits` is the half of it that
 * can be answered (it has a عجز and a روي to chain on). The dialog asks before
 * it offers, so the host is never handed a بيت the create route will refuse.
 */
export function getRoomPlayable(ids: readonly number[], o?: Opts): Promise<RoomPlayableResponse> {
  return request(qs("/api/room/playable", { ids: ids.join(",") }), RoomPlayableResponseSchema, init(o))
}

export function createRoom(body: Partial<CreateRoomRequest>, o?: Opts): Promise<RoomStateResponse> {
  return post("/api/room", RoomStateResponseSchema, body, init(o))
}

/**
 * The polling fallback, and the first read `#/room/<code>` makes.
 *
 * `key` is the invite out of the share link. A player never needs it — his
 * seat is a better claim — but a spectator does, because the snapshot carries
 * both usernames and the whole transcript.
 */
export function getRoomState(code: string, key?: string | null, o?: Opts): Promise<RoomStateResponse> {
  return request(qs(`/api/room/${encodeURIComponent(code)}/state`, { k: key }), RoomStateResponseSchema, init(o))
}

export function joinRoom(code: string, key?: string | null, o?: Opts): Promise<RoomStateResponse> {
  return post(`/api/room/${encodeURIComponent(code)}/join`, RoomStateResponseSchema, { key: key ?? null }, init(o))
}

/** One بيت. The verdict is the SAME `GameVerifyResponse` the solo duel gets. */
export function playRoomTurn(code: string, text: string, o?: Opts): Promise<RoomTurnResponse> {
  return post(`/api/room/${encodeURIComponent(code)}/turn`, RoomTurnResponseSchema, { text }, init(o))
}

export function resignRoom(code: string, o?: Opts): Promise<RoomStateResponse> {
  return post(`/api/room/${encodeURIComponent(code)}/resign`, RoomStateResponseSchema, {}, init(o))
}

/** «رجعة» — a second room with the seats swapped; answers with the NEW one. */
export function rematchRoom(code: string, o?: Opts): Promise<RoomStateResponse> {
  return post(`/api/room/${encodeURIComponent(code)}/rematch`, RoomStateResponseSchema, {}, init(o))
}

// ── knock-to-join ─────────────────────────────────────────────────────────
//
// The knock endpoints answer with the KNOCKER's minimal status, never the room:
// an unaccepted knocker is behind the same join_key gate a key-less spectator
// is, so he learns only `pending`/`accepted`/`rejected` (server/rooms.ts). The
// two HOST actions answer with the whole room, like every other room POST.

/** «اطرق الباب» — ask the host to be let in (a guest with no key). */
export function knockRoom(code: string, o?: Opts): Promise<RoomKnockResponse> {
  return post(`/api/room/${encodeURIComponent(code)}/knock`, RoomKnockResponseSchema, {}, init(o))
}

/** The knocker's poll while he waits: `pending` → `accepted` | `rejected`. */
export function getRoomKnock(code: string, o?: Opts): Promise<RoomKnockResponse> {
  return request(`/api/room/${encodeURIComponent(code)}/knock`, RoomKnockResponseSchema, init(o))
}

/** «اقبل» — the host seats the knocker and the room goes active. */
export function acceptKnock(code: string, o?: Opts): Promise<RoomStateResponse> {
  return post(`/api/room/${encodeURIComponent(code)}/knock/accept`, RoomStateResponseSchema, {}, init(o))
}

/** «ارفض» — the host refuses; the seat stays open. */
export function rejectKnock(code: string, o?: Opts): Promise<RoomStateResponse> {
  return post(`/api/room/${encodeURIComponent(code)}/knock/reject`, RoomStateResponseSchema, {}, init(o))
}

// ── الدواوين ───────────────────────────────────────────────────────────────
//
// A ديوان travels as ANCHORS: the client computes `baitAnchor(sadr, ajuz)` off
// the بيت it is looking at and sends the hash, and the server resolves it
// against the artefact and writes the snapshot. Nothing here ever sends a
// `baitId` or a `publicId`, because those move on every re-ingest — the whole
// point of the feature is a shelf that survives the rebuild.

/** «ديوانٌ جديد» — answers with the shelf, code and all. */
export function createAlbum(fields: AlbumCreateInput, o?: Opts): Promise<AlbumMutationResponse> {
  return post("/api/albums", AlbumMutationResponseSchema, fields, init(o))
}

/** «دواويني». There is no route to anyone ELSE's list, by design. */
export function getMyAlbums(o?: Opts): Promise<AlbumsResponse> {
  return request("/api/albums/mine", AlbumsResponseSchema, init(o))
}

/** One shelf, resolved. The code is the capability for an unlisted ديوان. */
export function getAlbum(code: string, o?: Opts): Promise<AlbumResponse> {
  return request(`/api/albums/${encodeURIComponent(code)}`, AlbumResponseSchema, init(o))
}

/** Rename, describe, publish, reorder — the owner's one door. */
export function patchAlbum(code: string, patch: AlbumPatchInput, o?: Opts): Promise<AlbumMutationResponse> {
  return request(`/api/albums/${encodeURIComponent(code)}`, AlbumMutationResponseSchema, {
    ...init(o),
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
}

export function deleteAlbum(code: string, o?: Opts): Promise<AlbumDeleteResponse> {
  return request(`/api/albums/${encodeURIComponent(code)}`, AlbumDeleteResponseSchema, {
    ...init(o),
    method: "DELETE",
  })
}

/**
 * Add entries — a قصيدة by its public id, a بيت by its anchor. The response
 * says how many actually landed.
 */
export function addAlbumEntries(
  code: string,
  items: readonly AlbumAddItem[],
  o?: Opts,
): Promise<AlbumAddEntriesResponse> {
  return post(`/api/albums/${encodeURIComponent(code)}/entries`, AlbumAddEntriesResponseSchema, { items }, init(o))
}

export function removeAlbumEntry(code: string, anchor: string, o?: Opts): Promise<AlbumMutationResponse> {
  return request(
    `/api/albums/${encodeURIComponent(code)}/entries/${encodeURIComponent(anchor)}`,
    AlbumMutationResponseSchema,
    { ...init(o), method: "DELETE" },
  )
}

/**
 * The ديوان as a مساجلة can play it — «ساجِل في هذا الديوان».
 *
 * Asked ONCE, at the door: the answer's `baitIds` become `DuelConfig.album`
 * and ride on every start and reply after that (shared/schema.ts
 * `poolBaitIds`), so a duel inside a shelf survives a reload without asking
 * the server what the shelf was.
 */
export function getAlbumPool(code: string, o?: Opts): Promise<AlbumPoolResponse> {
  return request(`/api/albums/${encodeURIComponent(code)}/pool`, AlbumPoolResponseSchema, init(o))
}

/** «أضِف إلى مكتبتك» — keep somebody else's shelf. Idempotent on the server. */
export function saveAlbum(code: string, o?: Opts): Promise<AlbumSaveResponse> {
  return post(`/api/albums/${encodeURIComponent(code)}/save`, AlbumSaveResponseSchema, {}, init(o))
}

/** …and let it go. It works on a shelf that has since gone private, on purpose. */
export function unsaveAlbum(code: string, o?: Opts): Promise<AlbumSaveResponse> {
  return request(`/api/albums/${encodeURIComponent(code)}/save`, AlbumSaveResponseSchema, {
    ...init(o),
    method: "DELETE",
  })
}
