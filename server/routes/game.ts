/**
 * `/api/game/*` — the مساجلة endpoints (design-server.md §7/§8).
 *
 *   GET  /api/game/pool    amendment 2 — the setup screen's live pool counter
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
 * All five routes sit behind the token bucket design-server.md §7 specifies:
 * 12 requests per 10 seconds per IP, created per sub-app so two `createApp()`s
 * in one test file cannot bleed counts into each other.
 *
 * Every decision lives in `server/game.ts`; this file parses, rate-limits and
 * shapes. Nothing here touches SQLite at construction time — the null-db stub in
 * app.test.ts depends on that.
 */

import { Hono, type Context } from "hono"
import type { z } from "zod"

import { TIER_PREDICATES } from "../../scripts/ingest/ddl.ts"
import { GAME_RATE_LIMIT } from "../../shared/constants.ts"
import { HIJAI_LETTERS } from "../../shared/letters.ts"
import {
  GameHintRequestSchema,
  GamePoolQuerySchema,
  GameReplyRequestSchema,
  GameStartRequestSchema,
  GameVerifyRequestSchema,
  HINT_COSTS,
  toErrorBody,
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
  comboByLetter,
  effectiveTailBias,
  firstWordOf,
  gameFilter,
  hintCandidate,
  pickBait,
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

export function gameRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()
  const limiter = createRateLimiter({ tokens: GAME_RATE_LIMIT.tokens, windowMs: GAME_RATE_LIMIT.windowMs })
  app.use("*", limiter.middleware)

  // ── GET /api/game/pool (amendment 2) ─────────────────────────────────────
  //
  // The setup screen asks this on every filter change, so it must be a lookup
  // and not a scan. `combo_counts` holds the four tiers × {this era, ANY} ×
  // {this metre, ANY} already summed per letter, which covers the two filters
  // the screen actually offers. `theme`/`lang` are not in that key: they can
  // only narrow, so their counts fall back to a live GROUP BY, which is the one
  // slow path here and the one the UI never opens by default.
  app.get("/pool", (c) => {
    const parsed = parseQuery(c, GamePoolQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data
    const cond = gameFilter(db, { era: q.era, meter: q.meter, theme: q.theme, lang: q.lang })

    let counts = new Map<string, number>()
    if (!cond.impossible) {
      const fromCombo = q.theme === undefined && q.lang === undefined ? comboByLetter(db, cond, q.difficulty) : null
      counts = fromCombo ?? liveByLetter(db, cond, q.difficulty)
    }

    const byLetter = HIJAI_LETTERS.map((letter) => ({ letter, count: counts.get(letter) ?? 0 }))
    const total = byLetter.reduce((sum, row) => sum + row.count, 0)

    // The duel relaxes one tier when the chosen one is dry, and every relax
    // arrow points at a strictly larger pool — so «العدد المتاح» understates
    // what the opponent can reach (easy+جاهلي+هزج reads 2 and answers on four
    // letters). `total` still reports the tier the player chose; `effectiveTotal`
    // reports the pool the duel actually draws from.
    const relaxTier = RELAX_TIER[q.difficulty]
    let effectiveTotal = total
    if (!cond.impossible && relaxTier !== null) {
      const relaxCounts =
        (q.theme === undefined && q.lang === undefined ? comboByLetter(db, cond, relaxTier) : null) ??
        liveByLetter(db, cond, relaxTier)
      effectiveTotal = Math.max(total, [...relaxCounts.values()].reduce((sum, n) => sum + n, 0))
    }

    const body: GamePoolResponse = { total, byLetter, effectiveTotal }
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
      const row = switchLetterBait(db, req.letter, req.filters, req.seed, req.mode)
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

/**
 * The `theme`/`lang` fallback for `/api/game/pool`: one grouped scan of
 * `game_baits`, memoised per database handle.
 *
 * `combo_counts` is keyed on (letter, era, metre, tier) only, so a player who
 * narrows the duel to a غرض or to فصيح has no precomputed answer and this scan
 * is the honest one — 491 ms unfiltered on data/qarid.db, which is far too slow
 * for a control the setup screen re-asks on every keystroke. The artefact is
 * immutable, so the answer never changes: compute it once per combination and
 * hand out the same Map forever. The cache is bounded because the combinations
 * are (12 eras + any) × (30 metres + any) × (18 themes + any) × 3 langs × 4
 * tiers only in principle — a real session touches a handful.
 */
const LIVE_POOL_CACHE = new WeakMap<object, Map<string, Map<string, number>>>()
const LIVE_POOL_CACHE_MAX = 256

function liveByLetter(db: Db, cond: ReturnType<typeof gameFilter>, tier: string): Map<string, number> {
  let perDb = LIVE_POOL_CACHE.get(db as object)
  if (perDb === undefined) {
    perDb = new Map()
    LIVE_POOL_CACHE.set(db as object, perDb)
  }
  const key = `${tier}|${cond.where}|${cond.params.join("\u0000")}`
  const hit = perDb.get(key)
  if (hit !== undefined) return hit

  const join = cond.needsPoem ? "JOIN poems p ON p.id = gb.poem_id" : ""
  const rows = db
    .q(
      `SELECT gb.first_letter AS l, COUNT(*) AS n FROM game_baits gb ${join}
       WHERE ${cond.where} AND ${TIER_COUNT_SQL[tier] ?? "1 = 1"} GROUP BY 1`,
    )
    .all(...cond.params) as Array<{ l: string; n: number }>
  const out = new Map<string, number>()
  for (const r of rows) out.set(String(r.l), Number(r.n))

  if (perDb.size >= LIVE_POOL_CACHE_MAX) perDb.clear()
  perDb.set(key, out)
  return out
}

/**
 * The tier predicates as `combo_counts` spells them. Ranges are fine here: this
 * query groups the whole table anyway, so there is no index walk to preserve
 * (unlike the sampler in server/game.ts, which must have `fame = ?`).
 */
const TIER_COUNT_SQL: Readonly<Record<string, string>> = Object.fromEntries(TIER_PREDICATES)
