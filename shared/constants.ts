/**
 * The identity, environment and ingest-time numbers both halves of the product
 * have to agree on.
 *
 * Data only — no zod, no logic, and deliberately no overlap with `schema.ts`.
 * That file already owns every number that appears in a request or a response
 * (`LIMITS`, `MAX_EXCLUDES`, `HINT_COSTS`, `PERSIST_VERSION`, `TIER_DIFFICULTY`)
 * and every enum that has to round-trip through zod (`Difficulty`, `ChainMode`,
 * `TailBias`, the sort orders, the search scopes). Restating any of them here
 * would create a second source of truth that drifts the first time one of them
 * changes — so what is left below is what schema.ts has no opinion about.
 */

import { HIJAI_LETTERS, RARE_RAWIYY, RARE_RAWIYY_WIDE } from "./letters.ts"

export const APP_ID = "qarid"
export const APP_NAME = "قريض"
export const APP_TAGLINE = "ديوان العرب ومساجلته"

/** Fixed by the suite; see CLAUDE.md. Never invent another one. */
export const PORTS = { devApi: 5750, devVite: 5751, preview: 6750, prod: 8010 } as const

/** localStorage namespace. Every key is `qarid:v1:<slice>`. */
export const LS_PREFIX = "qarid:v1:"
/** Where a corrupt payload is parked before the slice resets (daedalus's persist.ts). */
export const LS_CORRUPT_PREFIX = "qarid:corrupt-backup:"

/** `meta.schema_version` in the built artefact. */
export const SCHEMA_VERSION = 1

/** بيت اليوم turns over on the Gulf calendar day, not the UTC one. */
export const DAILY_TIMEZONE = "Asia/Riyadh"

// ── The alphabet ────────────────────────────────────────────────────────────

/** design-ux.md §6 calls it CHAIN_LETTERS; letters.ts owns the array itself. */
export const CHAIN_LETTERS = HIJAI_LETTERS
export { RARE_RAWIYY, RARE_RAWIYY_WIDE }

// ── Server-internal budgets (never appear in a DTO) ─────────────────────────

/**
 * design-server.md §7: the FTS scan is bounded BEFORE the join, ranked by
 * bm25. A filtered search over 3.86M أبيات degenerates into a full scan
 * without this, and 400 is deep enough that page 10 of any real query is still
 * populated.
 */
export const SEARCH_INNER_LIMIT = 400

/** In-memory token bucket on /api/game/*: 12 requests per 10 seconds per IP. */
export const GAME_RATE_LIMIT = { tokens: 12, windowMs: 10_000 } as const

/**
 * `bucket = fnv1a32(...) % BUCKETS`, and sampling walks the bucket column with
 * a wrap-around window. `ORDER BY RANDOM()` over 2M+ rows sorts 2M+ rows.
 */
export const BUCKETS = 1000

// ── Scoring and verification (design-ux.md §4, design-server.md §8) ─────────

/** `award = base + streak + time + obscurity − hints`. */
export const SCORING = {
  base: 100,
  perStreak: 10,
  maxStreakBonus: 10,
  perSecondRemaining: 2,
  obscurityBonus: 50,
  /** «أفحمتَ الخصم» — the opponent ran out of replies. */
  stumpBonus: 500,
} as const

/** The fuzzy-match gates the duel's verifier applies after the exact lookups. */
export const VERIFY = {
  andJaccard: 0.6,
  orJaccard: 0.75,
  minLenRatio: 0.6,
  maxLenRatio: 1.6,
  candidates: 5,
  /** amendment 7: this score band answers `near_miss`, not `not_found`. */
  nearMissBand: [0.35, 0.6] as const,
} as const

/** amendment 3's playability predicate for `game_baits`, stricter than §5's. */
export const PLAYABLE = {
  minHemistichChars: 12,
  maxHemistichChars: 80,
  minLenRatio: 0.5,
  maxLenRatio: 2.0,
} as const

/** «المبارزة» is best of ten on points; «الوصال» is endless. */
export const MUBARAZA_EXCHANGES = 10

// ── Client thresholds ───────────────────────────────────────────────────────

/** amendment 12: past this, poem rows get `content-visibility:auto`, not virtualization. */
export const CONTENT_VISIBILITY_THRESHOLD = 300

/** design-ux.md §4: warn — never block — when a filter combination gets thin. */
export const THIN_POOL_WARNING = 2000

// ── Ingest ──────────────────────────────────────────────────────────────────

/** A poem counts as vocalised when ≥3% of its Arabic characters are marks. */
export const TASHKEEL_THRESHOLD = 0.03

/** design-server.md §6: one transaction per this many poems. */
export const INGEST_TX_SIZE = 5000

export const SOURCE_DATASET = "arbml/ashaar"
export const SOURCE_REVISION = "9b5e723df1c5b13b9e4428caff758fe2f3c737f6"

/** Measured by scripts/ingest/profile.ts, not estimated. */
export const CORPUS = { poems: 254_630, baits: 3_857_429, poets: 7_167 } as const
