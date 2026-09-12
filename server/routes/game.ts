/**
 * `/api/game/*` — the مساجلة endpoints (design-server.md §7/§8).
 *
 *   GET  /api/game/pool    amendment 2 — the setup screen's live pool counter
 *   GET  /api/game/assist  v2.md §2 — وضع التدريب's suggestion rail
 *   POST /api/game/start   the opponent opens
 *   POST /api/game/verify  is the player's بيت in the ديوان, and does it chain?
 *   POST /api/game/reply   the opponent answers
 *   POST /api/game/hint    «من قائله؟» «أول كلمة» «البحر» «بدّل الحرف»
 *
 * The duel is STATELESS on purpose (design-server.md §8): the client holds the
 * transcript, the used ids, the score and the streak, and every request carries
 * what the server needs to judge one move. There is no session table, no
 * cookie, and nothing to expire — a player can reload mid-duel and the state is
 * still in their browser. The cost is that `usedBaitIds` grows, which is why the
 * schema clamps every exclude list to `MAX_EXCLUDES` (500) before it is read.
 *
 * Five of the six routes sit behind the token bucket design-server.md §7
 * specifies: 12 requests per 10 seconds per IP, created per sub-app so two
 * `createApp()`s in one test file cannot bleed counts into each other. The
 * sixth, `/assist`, fires while the player is TYPING and gets its own bucket
 * for it (`ASSIST_RATE_LIMIT`) — see the note on the middleware below.
 *
 * Every decision lives in `server/game.ts`; this file parses, rate-limits and
 * shapes. Nothing here touches SQLite at construction time — the null-db stub in
 * app.test.ts depends on that.
 */

import { Hono, type Context } from "hono"
import type { z } from "zod"

import { ASSIST_RATE_LIMIT, GAME_RATE_LIMIT } from "../../shared/constants.ts"
import { HIJAI_LETTERS } from "../../shared/letters.ts"
import {
  GameAssistQuerySchema,
  GameHintRequestSchema,
  GamePoolQuerySchema,
  GameReplyRequestSchema,
  GameStartRequestSchema,
  GameVerifyRequestSchema,
  HINT_COSTS,
  toErrorBody,
  type GameAssistResponse,
  type GameHintResponse,
  type GamePoolResponse,
  type GameReplyResponse,
  type ChainMode,
  type GameStartResponse,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { letterOrNull, meterRef, poetRef } from "../dto.ts"
import {
  RELAX_TIER,
  assistSuggest,
  effectiveTailBias,
  firstWordOf,
  gameFilter,
  hintCandidate,
  pickBait,
  poolByLetter,
  requiredLetterOf,
  servedBait,
  switchLetterBait,
  verifyAnswer,
} from "../game.ts"
import { parseQuery } from "../query.ts"
import { createRateLimiter } from "../ratelimit.ts"

/**
 * Parse a JSON body through a schema, or answer `400 {error, issues}` — the
 * POST twin of `parseQuery`. A malformed/absent body is treated as `{}` so the
 * schema's own defaults decide, which keeps «ابدأ» working from a client that
 * sends no body at all.
 */
async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const body = await readBody(c)
  if (!body.ok) return body
  const result = schema.safeParse(body.raw)
  if (!result.success) return { ok: false, res: c.json(toErrorBody(result.error, "bad_body"), 400) }
  return { ok: true, data: result.data as z.infer<S> }
}

/**
 * The largest body any `/api/game/*` request can legitimately carry.
 *
 * The maximum is `usedBaitIds` + `usedPoemIds` at `MAX_EXCLUDES` (500 integers
 * each, ≈ 8 KB of JSON) plus 600 characters of typed بيت. 64 KB is eight times
 * that, and it is the difference between a bounded parse and an open door: a
 * schema cannot reject what has already been read, decoded to a JS string and
 * handed to `JSON.parse`, and the peak allocation of that is roughly five times
 * the wire bytes. Measured on the real corpus server before this guard: ONE
 * 67 MB body took RSS from 185 MB to 520 MB, and six concurrent ones added
 * 577 MB — every one of them answered 400.
 */
export const MAX_GAME_BODY = 64 * 1024

/**
 * Read the JSON body without ever holding more than `MAX_GAME_BODY` of it.
 *
 * `Content-Length` is checked first because it is free, but it is a claim, not
 * a fact — a chunked request carries none — so the stream is also counted as it
 * arrives and abandoned the moment it crosses the cap. A malformed or absent
 * body is `{}` (the schema's own defaults then decide), which is what keeps
 * «ابدأ» working from a client that sends no body at all.
 */
async function readBody(c: Context): Promise<{ ok: true; raw: unknown } | { ok: false; res: Response }> {
  const tooLarge = { ok: false as const, res: c.json({ error: "payload_too_large", limit: MAX_GAME_BODY }, 413) }

  const declared = Number(c.req.header("content-length") ?? "")
  if (Number.isFinite(declared) && declared > MAX_GAME_BODY) return tooLarge

  const stream = c.req.raw.body
  if (stream === null) return { ok: true, raw: {} }

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_GAME_BODY) {
        await reader.cancel()
        return tooLarge
      }
      chunks.push(value)
    }
  } catch {
    return { ok: true, raw: {} }
  } finally {
    reader.releaseLock()
  }

  if (size === 0) return { ok: true, raw: {} }
  try {
    return { ok: true, raw: JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  } catch {
    return { ok: true, raw: {} }
  }
}

/**
 * `[]` is «no ديوان», a non-empty list is one — the one place that reading is
 * made, so no route repeats it.
 *
 * The distinction matters at the other end: `gameFilter` treats an EMPTY pool
 * as provably no rows (a ديوان that resolved to nothing is «no بيت», never «no
 * constraint»), and the wire's default for an ordinary duel is `[]`.
 */
function poolOf(ids: readonly number[]): { poolBaitIds?: readonly number[] } {
  return ids.length > 0 ? { poolBaitIds: ids } : {}
}

export function gameRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()
  const limiter = createRateLimiter({ tokens: GAME_RATE_LIMIT.tokens, windowMs: GAME_RATE_LIMIT.windowMs })
  const assistLimiter = createRateLimiter({ tokens: ASSIST_RATE_LIMIT.tokens, windowMs: ASSIST_RATE_LIMIT.windowMs })
  // Two buckets, one middleware. `/assist` fires while the player TYPES, and
  // spending the duel's twelve tokens on suggestions would 429 the very next
  // `/verify` — the request the game's outcome depends on. So the rail is
  // limited (v2.md §2), just not out of the same purse; see ASSIST_RATE_LIMIT.
  app.use("*", (c, next) =>
    c.req.path.endsWith("/assist") ? assistLimiter.middleware(c, next) : limiter.middleware(c, next),
  )

  // ── GET /api/game/pool (amendment 2) ─────────────────────────────────────
  //
  // The setup screen asks this on every filter change, so it must be a lookup
  // and not a scan. `combo_counts` holds the four tiers × {this era, ANY} ×
  // {this metre, ANY} already summed per letter, which covers two of the three
  // filters the screen offers. `poet` (and `theme`/`lang`, which no control
  // reaches yet) are not in that key, so they fall back to one grouped scan —
  // `poolByLetter` in server/game.ts decides which, and memoises either answer.
  //
  // A شاعر is the cheap half of that fallback, not the expensive one: the scan
  // rides `poems_poet` → `gb_poem` and is 6.2 ms on the fattest ديوان in the
  // corpus, once per (شاعر, رتبة) for the life of the process.
  app.get("/pool", (c) => {
    const parsed = parseQuery(c, GamePoolQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data
    const cond = gameFilter(db, { era: q.era, meter: q.meter, theme: q.theme, poet: q.poet, lang: q.lang })

    const counts = poolByLetter(db, cond, q.difficulty)
    const byLetter = HIJAI_LETTERS.map((letter) => ({ letter, count: counts.get(letter) ?? 0 }))
    const total = byLetter.reduce((sum, row) => sum + row.count, 0)

    // The duel relaxes one tier when the chosen one is dry, and every relax
    // arrow points at a strictly larger pool — so «العدد المتاح» understates
    // what the opponent can reach (easy+جاهلي+هزج reads 2 and answers on four
    // letters). `total` still reports the tier the player chose; `effectiveTotal`
    // reports the pool the duel actually draws from.
    //
    // A شاعر makes that gap the NORMAL case rather than a corner: «فحل» is
    // `fame <= 2` and fame is a property of the شاعر, so every famous ديوان is
    // exactly zero at that رتبة and 5,131 أبيات at the one it relaxes to. The
    // setup screen says so in words rather than printing a bare 0.
    const relaxTier = RELAX_TIER[q.difficulty]
    let effectiveTotal = total
    if (!cond.impossible && relaxTier !== null) {
      const relaxCounts = poolByLetter(db, cond, relaxTier)
      effectiveTotal = Math.max(total, [...relaxCounts.values()].reduce((sum, n) => sum + n, 0))
    }

    const body: GamePoolResponse = { total, byLetter, effectiveTotal }
    return c.json(body)
  })

  // ── GET /api/game/assist (v2.md §2) ──────────────────────────────────────
  //
  // وضع التدريب's suggestion rail: real أبيات that open on the required letter
  // and carry what the player has typed. Everything that decides anything is in
  // `assistSuggest`; the shape of the answer is the house list envelope, and
  // `page` is always 1 because the rail is a top-N, not a pager.
  //
  // The typed text NEVER reaches SQL: `assistSuggest` folds it with
  // `shared/arabic.ts` and compares it in JavaScript against a pool it loaded by
  // letter, and the only values bound to a statement here are the letter (a zod
  // enum) and up to eight integer primary keys. There is no MATCH expression to
  // escape and no LIKE pattern to poison.
  app.get("/assist", (c) => {
    const parsed = parseQuery(c, GameAssistQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data
    const found = assistSuggest(db, { letter: q.letter, also: q.also, q: q.q, limit: q.limit })
    const body: GameAssistResponse = { items: found.items, total: found.total, page: 1, limit: q.limit }
    return c.json(body)
  })

  // ── POST /api/game/start ─────────────────────────────────────────────────
  app.post("/start", async (c) => {
    const parsed = await parseBody(c, GameStartRequestSchema)
    if (!parsed.ok) return parsed.res
    const req = parsed.data

    const picked = pickBait(db, {
      difficulty: req.difficulty,
      tailBias: effectiveTailBias(req.difficulty, "none"),
      filters: req.filters,
      // «ساجِل في هذا الديوان» — the opponent opens from the shelf. The field
      // defaults to `[]`, which is the ordinary duel and no pool at all; a
      // non-empty list is the whole set it may draw from here and in every
      // reply after it (server/game.ts `poolBaitIds`).
      ...poolOf(req.poolBaitIds),
      seed: req.seed,
    })
    if (picked === null) {
      const body: GameStartResponse = { ok: false, reason: "no_bait", letter: null }
      return c.json(body)
    }
    const body: GameStartResponse = { ok: true, seed: req.seed ?? null, ...servedBait(picked.row, req.mode) }
    return c.json(body)
  })

  // ── POST /api/game/verify ────────────────────────────────────────────────
  app.post("/verify", async (c) => {
    const parsed = await parseBody(c, GameVerifyRequestSchema)
    if (!parsed.ok) return parsed.res
    // Always 200: a rejection is a game outcome, not a protocol error, and the
    // client's state machine discriminates on `reason` (design-ux.md §4).
    return c.json(verifyAnswer(db, parsed.data))
  })

  // ── POST /api/game/reply ─────────────────────────────────────────────────
  app.post("/reply", async (c) => {
    const parsed = await parseBody(c, GameReplyRequestSchema)
    if (!parsed.ok) return parsed.res
    const req = parsed.data

    const picked = pickBait(db, {
      letter: req.letter,
      difficulty: req.difficulty,
      tailBias: effectiveTailBias(req.difficulty, req.tailBias),
      filters: req.filters,
      excludeBaitIds: req.excludeBaitIds,
      excludePoemIds: req.excludePoemIds,
      ...poolOf(req.poolBaitIds),
      seed: req.seed,
      // The one route that may leave the «القيود» rather than concede: a
      // conceded reply is worth +500 and a thin عصر×بحر pair would otherwise
      // hand it over in one move (server/game.ts `relaxFilters`).
      relaxFilters: true,
    })
    if (picked === null) {
      // «أفحمتَ الخصم» — the ديوان has nothing left on this letter (+500).
      const body: GameReplyResponse = { ok: false, reason: "no_bait", letter: req.letter }
      return c.json(body)
    }
    const body: GameReplyResponse = {
      ok: true,
      seed: req.seed ?? null,
      ...(picked.relaxed ? { relaxed: true } : {}),
      ...servedBait(picked.row, req.mode),
    }
    return c.json(body)
  })

  // ── POST /api/game/hint ──────────────────────────────────────────────────
  app.post("/hint", async (c) => {
    const parsed = await parseBody(c, GameHintRequestSchema)
    if (!parsed.ok) return parsed.res
    const req = parsed.data

    if (req.kind === "switch_letter") {
      const row = switchLetterBait(
        db,
        req.letter,
        req.filters,
        req.seed,
        req.mode,
        req.poolBaitIds.length > 0 ? req.poolBaitIds : undefined,
      )
      if (row === null) return c.json({ ok: false, reason: "no_bait" } satisfies GameHintResponse)
      const body: GameHintResponse = {
        ok: true,
        kind: "switch_letter",
        cost: HINT_COSTS.switch_letter,
        // `req.mode`, never a literal: this payload IS the new chain state, the
        // play screen renders `requiredLetter` as the wall, and `verifyAnswer`
        // re-derives the same letter in the same mode. A hardcoded "rhyme" here
        // showed the روي to a duel the server was judging on الحرف الأخير.
        ...servedBait(row, req.mode),
      }
      return c.json(body)
    }

    // The three cheap hints describe a بيت that WOULD answer — see
    // `hintCandidate` in server/game.ts for why that, and not the بيت on screen.
    const letter = requiredLetterFor(db, req.baitId, req.letter, req.mode)
    if (letter === null) return c.json({ ok: false, reason: "not_found" } satisfies GameHintResponse)

    const row = hintCandidate(db, letter, req.difficulty, req.filters, req.seed)
    if (row === null) return c.json({ ok: false, reason: "no_bait" } satisfies GameHintResponse)

    if (req.kind === "poet") {
      return c.json({ ok: true, kind: "poet", cost: HINT_COSTS.poet, poet: poetRef(row) } satisfies GameHintResponse)
    }
    if (req.kind === "first_word") {
      return c.json({
        ok: true,
        kind: "first_word",
        cost: HINT_COSTS.first_word,
        firstWord: firstWordOf(row),
      } satisfies GameHintResponse)
    }
    return c.json({ ok: true, kind: "meter", cost: HINT_COSTS.meter, meter: meterRef(row) } satisfies GameHintResponse)
  })

  return app
}

/**
 * The letter a hint is being bought against: read off the opponent's بيت when
 * the client sent its id, else the letter the client believes is required
 * («بدّل الحرف» leaves no previous بيت to read).
 */
function requiredLetterFor(
  db: Db,
  baitId: number | undefined,
  letter: string | undefined,
  mode: ChainMode,
): string | null {
  if (baitId !== undefined) {
    const row = db.q("SELECT rawiyy, last_letter FROM baits WHERE id = ?").get(baitId) as
      | { rawiyy: string | null; last_letter: string | null }
      | undefined
    if (row !== undefined) {
      // The SAME derivation `chainState` runs, through the same helper — in
      // `literal` mode the duel chains on the final letter as it is written
      // («جَزَتني» ends on ي though its روي is ج), and a hint that describes a
      // بيت opening on the روي is a hint about a بيت the server will refuse.
      return requiredLetterOf(letterOrNull(row.rawiyy), letterOrNull(row.last_letter), mode)
    }
    // An id that names nothing is a client bug, not a fallback.
    if (letter === undefined) return null
  }
  return letter ?? null
}
