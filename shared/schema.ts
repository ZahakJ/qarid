/**
 * قريض — the API contract.
 *
 * ONE file, shared verbatim by `server/` (validates request input, shapes every
 * response) and `client/` (parses every response through the same schema in
 * `client/api/client.ts`) and by `client/persist.ts` (the localStorage slices).
 *
 * Authorities: docs/design-server.md §7 §8, docs/design-ux.md §5 §6 §10, and
 * docs/amendments.md (items 1, 5, 6, 7, 8, 9, 10 override the other two).
 *
 * House conventions encoded here — read before writing a route:
 *
 *  • QUERY PARAMS are total functions: numbers are coerced and **clamped**
 *    (never rejected), booleans accept `1/0/true/false/yes/no/on/off`, and
 *    absent/empty strings fall back to the documented default. So a route can
 *    do `const q = PoemsQuery.parse(c.req.query())` and never 400 on a number.
 *  • ENUM query params ARE strict: `sort=bogus` fails to parse → the route
 *    answers `400 {error:'bad_query', issues}` (see `toErrorBody`). The client
 *    only ever emits legal values, and a silent fallback would hide a bug.
 *  • REQUEST BODIES are strict on type but forgiving on size: exclude lists are
 *    truncated to `MAX_EXCLUDES` (500, design-server.md §8) by the schema
 *    itself, so a route never has to remember to clamp.
 *  • RESPONSES are plain objects (unknown keys are stripped, not rejected), so
 *    a server that adds a field cannot break an older client.
 *  • `total` is present on every list response; `limit`/`page`/`offset` are
 *    echoed back so the client can trust the clamp that actually happened.
 *
 * Everything is exported twice: `XSchema` (the zod value) and `X` (the inferred
 * type). Types are the *output* types — i.e. post-coercion, post-clamp.
 */

import { z } from "zod"
import { ASSIST, MUBARAZA_EXCHANGES } from "./constants.ts"
import { HIJAI_LETTERS } from "./letters.ts"

// ═══════════════════════════════════════════════════════════════════════════
// 1. Primitives, constants, param helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The letter alphabet is owned by `shared/letters.ts` — `HIJAI_LETTERS` is the
 * single list, and `RARE_RAWIYY` / `RARE_RAWIYY_WIDE` (the tailBias sets) live
 * there too. Every `firstLetter` / `rawiyy` / `lastLetter` on the wire is one
 * of those 28: `foldLetter` in shared/arabic.ts collapses آأإٱء→ا · ى→ي · ة→ه ·
 * ؤ→و · ئ→ي, so nothing outside the set can reach the API.
 */
export const ArabicLetterSchema = z.enum(HIJAI_LETTERS)
export type ArabicLetter = z.infer<typeof ArabicLetterSchema>

/** ASCII slug for era / meter / theme (server-supplied, design-ux.md §1). */
export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "slug must be lowercase ascii")
export type Slug = z.infer<typeof SlugSchema>

/**
 * Poet slug. NOT ascii-constrained: 91,936 rows carry no `poet url` at all
 * (CLAUDE.md spike finding 2) so the fallback slug is derived from the Arabic
 * `name_key`. Only path-hostile characters are excluded.
 */
export const PoetSlugSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^/\\?#\s]+$/, "poet slug must not contain path separators or whitespace")

/**
 * Public poem id: `String(aldiwan_id)` when derivable (27% of rows), else
 * `q<rowid>` (design-server.md §5, CLAUDE.md spike finding 1).
 */
export const PublicPoemIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^q?\d+$/, "public poem id must be <digits> or q<digits>")

/** `baytKey(poemId, position)` = `${publicPoemId}:${position}` (design-ux.md §1). */
export const BaytKeySchema = z
  .string()
  .min(3)
  .max(48)
  .regex(/^q?\d+:\d+$/, "baytKey must be <publicPoemId>:<position>")
export type BaytKey = z.infer<typeof BaytKeySchema>

/** Local calendar day, `YYYY-MM-DD` (Asia/Riyadh for the daily bayt). */
export const DayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")

/** Free-text seed for `shared/rng.ts` `rngFrom(seed)`. */
export const SeedSchema = z.string().min(1).max(120)

const TRUTHY = new Set(["1", "true", "yes", "on", "y", "t"])
const FALSY = new Set(["0", "false", "no", "off", "n", "f", ""])

/** Query-param boolean: `famous=1`, `timer=false`, absent → `fallback`. */
function boolParam(fallback: boolean) {
  return z
    .union([z.string(), z.boolean(), z.undefined()])
    .transform((v) => {
      if (v === undefined) return fallback
      if (typeof v === "boolean") return v
      const s = v.trim().toLowerCase()
      if (TRUTHY.has(s)) return true
      if (FALSY.has(s)) return false
      return fallback
    })
    .default(fallback)
}

/**
 * Query-param integer: coerced, truncated and CLAMPED into `[min,max]`.
 * Garbage (`limit=abc`, `page=-3`, `limit=1e9`) never 400s — it lands on the
 * nearest legal value, which is what design-server.md §7 means by "limit
 * clamped".
 */
function intParam(min: number, max: number, fallback: number) {
  return z
    .union([z.string(), z.number(), z.undefined()])
    .transform((v) => {
      if (v === undefined || v === "") return fallback
      const n = typeof v === "number" ? v : Number(String(v).trim())
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.trunc(n)))
    })
    .default(fallback)
}

/** Same clamp, but `undefined` stays `undefined` (an *absent* filter bound). */
function optionalIntParam(min: number, max: number) {
  return z
    .union([z.string(), z.number(), z.undefined()])
    .transform((v) => {
      if (v === undefined || v === "") return undefined
      const n = typeof v === "number" ? v : Number(String(v).trim())
      if (!Number.isFinite(n)) return undefined
      return Math.min(max, Math.max(min, Math.trunc(n)))
    })
    .optional()
}

/**
 * Optional string param where an absent value, `null` or the empty string all
 * mean "filter not set". The value is trimmed before `inner` sees it.
 */
function optionalStr<T extends z.ZodType>(inner: T) {
  return z.preprocess((v) => {
    if (v === null || v === undefined) return undefined
    if (typeof v !== "string") return v
    const t = v.trim()
    return t === "" ? undefined : t
  }, inner.optional()).optional()
}

/** Pagination limits (design-server.md §7). */
export const LIMITS = {
  /** default list limit */
  defaultLimit: 20,
  /** every list route except the two below */
  maxLimit: 100,
  /** GET /api/poems/:publicId/baits */
  maxBaitsLimit: 300,
  /** GET /api/search */
  maxSearchLimit: 40,
  /** baits returned inline with a poem detail */
  poemDetailBaits: 200,
  /** GET /api/poems/:publicId/similar */
  maxSimilarLimit: 50,
} as const

/** Server clamps game exclude lists to this (design-server.md §8). */
export const MAX_EXCLUDES = 500

/** Hint prices, negative points (design-ux.md §4 + amendments.md §7 §8). */
export const HINT_COSTS = {
  poet: 40,
  first_word: 60,
  meter: 20,
  switch_letter: 150,
  /** «اقبل هذا البيت» on a near_miss (amendments.md §7) */
  accept_near_miss: 25,
} as const

// ═══════════════════════════════════════════════════════════════════════════
// 2. Shared vocabulary enums
// ═══════════════════════════════════════════════════════════════════════════

/** meters.kind (design-server.md §5). Only `bahr` enters the game pool. */
export const MeterKindSchema = z.enum(["bahr", "free", "prose", "muwashah", "folk", "unknown"])
export type MeterKind = z.infer<typeof MeterKindSchema>

/** amendments.md §11 — الأندلس والمغرب is a region, not a period. */
export const EraKindSchema = z.enum(["period", "region"])
export type EraKind = z.infer<typeof EraKindSchema>

/** amendments.md §11 — قصيرة/عامة are buckets, hidden from the filter chips. */
export const ThemeKindSchema = z.enum(["theme", "bucket"])
export type ThemeKind = z.infer<typeof ThemeKindSchema>

/** Collapsed language type (design-server.md §6): فصحى|فصيح→فصيح, عامي|شعبي→عامي. */
export const LangTypeSchema = z.enum(["فصيح", "عامي"])
export type LangType = z.infer<typeof LangTypeSchema>

/** poets.fame 0..3 (design-server.md §6 Pass 2). */
export const FameSchema = z.number().int().min(0).max(3)

/** Chain mode (amendments.md §1): 'rhyme' accepts rawiyy OR last_letter. */
export const ChainModeSchema = z.enum(["rhyme", "literal"])
export type ChainMode = z.infer<typeof ChainModeSchema>

/**
 * Which letter the player must answer on.
 *  • 'rawiyy' — the peeled الروي equals the literal final letter, nothing was dropped
 *  • 'peeled' — a وصل tail (ه/ة/ا/ى/و/ي) was peeled off, so the two differ and
 *    `alsoAccepted` carries the literal one (design-server.md §8).
 */
export const RequiredLetterSourceSchema = z.enum(["rawiyy", "peeled"])
export type RequiredLetterSource = z.infer<typeof RequiredLetterSourceSchema>

/** design-server.md §8; UX tiers مبتدئ→easy شاعر→normal فحل→hard سيف→brutal. */
export const DifficultySchema = z.enum(["easy", "normal", "hard", "brutal"])
export type Difficulty = z.infer<typeof DifficultySchema>

/** amendments.md §5 — the real difficulty lever on /api/game/reply. */
export const TailBiasSchema = z.enum(["easy", "none", "hard"])
export type TailBias = z.infer<typeof TailBiasSchema>

export const SearchScopeSchema = z.enum(["all", "baits", "poems", "poets"])
export type SearchScope = z.infer<typeof SearchScopeSchema>

/** AND is tried first; OR is the reported fallback (design-server.md §7). */
export const SearchModeSchema = z.enum(["and", "or"])
export type SearchMode = z.infer<typeof SearchModeSchema>

export const PoetsSortSchema = z.enum(["name", "poems", "baits"])
export const PoemsSortSchema = z.enum(["title", "length", "poet", "fame", "random"])
export type PoetsSort = z.infer<typeof PoetsSortSchema>
export type PoemsSort = z.infer<typeof PoemsSortSchema>

export const MatchKindSchema = z.enum(["exact", "sadr", "fuzzy"])
export type MatchKind = z.infer<typeof MatchKindSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 3. Lookup rows (served by /api/meta, embedded in DTOs)
// ═══════════════════════════════════════════════════════════════════════════

export const MeterRefSchema = z.object({
  slug: SlugSchema,
  name: z.string(),
  /** the modifier peeled off the raw value: مجزوء / مشطور / مخلع … */
  variant: z.string().nullable().default(null),
})
export type MeterRef = z.infer<typeof MeterRefSchema>

export const EraRefSchema = z.object({ slug: SlugSchema, name: z.string() })
export type EraRef = z.infer<typeof EraRefSchema>

export const ThemeRefSchema = z.object({ slug: SlugSchema, name: z.string(), display: z.string() })
export type ThemeRef = z.infer<typeof ThemeRefSchema>

export const PoetRefSchema = z.object({ slug: PoetSlugSchema, name: z.string() })
export type PoetRef = z.infer<typeof PoetRefSchema>

/**
 * The poem a بيت belongs to, under BOTH of its names.
 *
 *  • `id` is the PUBLIC id — `q<rowid>` for the 73% with no aldiwan page, the
 *    bare aldiwan number for the rest. It is what `#/poem/<id>` routes on and
 *    what `baytKey` is built from, and it is NOT a `poems.id`.
 *  • `poemId` is the INTERNAL `poems.id`, the only thing the duel's
 *    `excludePoemIds` / `usedPoemIds` speak. Parsing `id` back into a number
 *    works for `q…` and silently produces an unrelated poem's id for an
 *    aldiwan one, which is exactly the bug this field exists to end.
 */
export const PoemRefSchema = z.object({
  id: PublicPoemIdSchema,
  poemId: z.number().int().positive(),
  title: z.string(),
})
export type PoemRef = z.infer<typeof PoemRefSchema>

export const MeterInfoSchema = z.object({
  slug: SlugSchema,
  name: z.string(),
  tafila: z.string().nullable(),
  kind: MeterKindSchema,
  sort: z.number().int(),
  poemCount: z.number().int().nonnegative(),
})
export type MeterInfo = z.infer<typeof MeterInfoSchema>

export const EraInfoSchema = z.object({
  slug: SlugSchema,
  name: z.string(),
  sort: z.number().int(),
  kind: EraKindSchema,
  poemCount: z.number().int().nonnegative(),
  poetCount: z.number().int().nonnegative(),
})
export type EraInfo = z.infer<typeof EraInfoSchema>

export const ThemeInfoSchema = z.object({
  slug: SlugSchema,
  name: z.string(),
  display: z.string(),
  sort: z.number().int(),
  kind: ThemeKindSchema,
  poemCount: z.number().int().nonnegative(),
})
export type ThemeInfo = z.infer<typeof ThemeInfoSchema>

/**
 * amendments.md §10 — per-letter corpus counts, so the arsenal can compute
 * "weakness = endsWith-demand × (1 − supply/8)" and the browse letter grids can
 * render counts without a /api/facets round trip.
 */
export const LetterInfoSchema = z.object({
  letter: ArabicLetterSchema,
  /** how many game-eligible أبيات START on this letter (supply) */
  startsWith: z.number().int().nonnegative(),
  /** how many END on it, i.e. how often it is demanded of you (demand) */
  endsWith: z.number().int().nonnegative(),
})
export type LetterInfo = z.infer<typeof LetterInfoSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 4. Core DTOs
// ═══════════════════════════════════════════════════════════════════════════

export const PoetSummarySchema = z.object({
  slug: PoetSlugSchema,
  name: z.string(),
  /** folded shuhra letter used for the poets-index grouping (design-ux.md §3) */
  letter: ArabicLetterSchema,
  era: EraRefSchema.nullable(),
  location: z.string().nullable(),
  /** short bio; null for the ~89% with none (CLAUDE.md: only 791 poets carry one) */
  description: z.string().nullable(),
  fame: FameSchema,
  poemCount: z.number().int().nonnegative(),
  baitCount: z.number().int().nonnegative(),
})
export type PoetSummary = z.infer<typeof PoetSummarySchema>

export const PoetDetailSchema = PoetSummarySchema.extend({
  /** the source index entry (aldiwan / dctabudhabi / …); null for 91,936 rows */
  sourceUrl: z.string().nullable(),
})
export type PoetDetail = z.infer<typeof PoetDetailSchema>

/**
 * PoemSummary is served from `poems` JOIN `poets` only — NEVER from `baits`
 * (design-server.md §7). `previewSadr`/`previewAjuz` are the denormalized
 * position-1 hemistichs, which is what makes an untitled poem renderable as
 * its مطلع in a list row.
 */
export const PoemSummarySchema = z.object({
  id: PublicPoemIdSchema,
  title: z.string(),
  poet: PoetRefSchema,
  meter: MeterRefSchema.nullable(),
  theme: ThemeRefSchema.nullable(),
  era: EraRefSchema.nullable(),
  langType: LangTypeSchema.nullable(),
  /** modal rawiyy of the poem (tie → bait 1) */
  rhyme: ArabicLetterSchema.nullable(),
  /**
   * `poems.rhyme_share` — the share of أبيات whose روي is `rhyme`. A مقطوعة
   * with a mixed tail scores low; below 0.6 the client hides the قافية chip
   * instead of claiming a قافية the قصيدة does not have.
   */
  rhymeShare: z.number().min(0).max(1).nullable().default(null),
  firstLetter: ArabicLetterSchema.nullable(),
  baitCount: z.number().int().nonnegative(),
  hasTashkeel: z.boolean(),
  previewSadr: z.string().nullable(),
  previewAjuz: z.string().nullable(),
})
export type PoemSummary = z.infer<typeof PoemSummarySchema>

export const PoemDetailSchema = PoemSummarySchema.extend({
  /** the source page this poem was scraped from; 38 rows have none */
  url: z.string().nullable(),
  poetFame: FameSchema,
})
export type PoemDetail = z.infer<typeof PoemDetailSchema>

/**
 * BaitDto — design-server.md §7, plus two fields the game and the client need:
 *  • `lastLetter` — the literal (unpeeled) final letter. amendments.md §1 makes
 *    it first-class: 'literal' mode chains on it and 'rhyme' mode accepts it as
 *    leniency, so the client cannot render the letter indicator without it.
 *  • `isPartial` — an odd hemistich count leaves a final بيت with `ajuz: null`
 *    (24,378 poems). Verify answers `incomplete_bait` for these.
 *
 * `sadr`/`ajuz` are the ORIGINAL cleaned text with tashkeel intact; nothing on
 * the wire is normalized (search `highlight` is the one exception).
 */
export const BaitDtoSchema = z.object({
  id: z.number().int().positive(),
  baytKey: BaytKeySchema,
  /** 1-based position within the poem */
  position: z.number().int().positive(),
  sadr: z.string(),
  ajuz: z.string().nullable(),
  /** peeled الروي — what the chain runs on in 'rhyme' mode */
  rawiyy: ArabicLetterSchema.nullable(),
  /** literal final letter — 'literal' mode, and the leniency in 'rhyme' mode */
  lastLetter: ArabicLetterSchema.nullable(),
  firstLetter: ArabicLetterSchema.nullable(),
  isPartial: z.boolean(),
  poem: PoemRefSchema,
  poet: PoetRefSchema,
  meter: MeterRefSchema.nullable(),
  era: EraRefSchema.nullable(),
})
export type BaitDto = z.infer<typeof BaitDtoSchema>

/** A bait carrying the FTS5 snippet of its normalized text, »word« marked. */
export const BaitHitSchema = BaitDtoSchema.extend({
  /**
   * `snippet(baits_fts, 0, '»', '«', '…', 8)` over the NORMALIZED column, sent
   * alongside the original text. The client maps the »…« words back onto
   * `sadr`/`ajuz` via `foldedIndex` (design-ux.md §3); it never renders this
   * string raw, because tashkeel is missing from it.
   */
  highlight: z.string().nullable(),
  score: z.number(),
})
export type BaitHit = z.infer<typeof BaitHitSchema>

export const PoemHitSchema = PoemSummarySchema.extend({
  highlight: z.string().nullable(),
  score: z.number(),
})
export type PoemHit = z.infer<typeof PoemHitSchema>

export const PoetHitSchema = PoetSummarySchema.extend({
  highlight: z.string().nullable(),
  score: z.number(),
})
export type PoetHit = z.infer<typeof PoetHitSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 5. Errors
// ═══════════════════════════════════════════════════════════════════════════

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  issues: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
    .optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

/** The 400 body every route must emit on a parse failure (design-server.md §7). */
export function toErrorBody(error: z.ZodError, code = "bad_request"): ApiError {
  return {
    error: code,
    issues: error.issues.map((i) => ({ path: [...i.path] as (string | number)[], message: i.message })),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Query schemas — GET routes (design-server.md §7)
// ═══════════════════════════════════════════════════════════════════════════

/** The filter vocabulary shared by /api/poems, /api/facets and the game. */
const poemFilterShape = {
  poet: optionalStr(PoetSlugSchema),
  era: optionalStr(SlugSchema),
  meter: optionalStr(SlugSchema),
  theme: optionalStr(SlugSchema),
  rhyme: optionalStr(ArabicLetterSchema),
  first: optionalStr(ArabicLetterSchema),
  lang: optionalStr(LangTypeSchema),
  minBaits: optionalIntParam(1, 20000),
  maxBaits: optionalIntParam(1, 20000),
  fame: optionalIntParam(0, 3),
}

const pageShape = {
  page: intParam(1, 100000, 1),
  limit: intParam(1, LIMITS.maxLimit, LIMITS.defaultLimit),
}

/**
 * How many شعراء one `?slugs=` batch may name. The duel summary is the caller
 * and a مساجلة cannot meet more شعراء than it has exchanges, so 30 is generous;
 * the cap exists so the comma list can never become an unbounded `IN (…)`.
 */
export const MAX_POET_SLUGS = 30

export const PoetsQuerySchema = z.object({
  letter: optionalStr(ArabicLetterSchema),
  era: optionalStr(SlugSchema),
  q: optionalStr(z.string().max(200)),
  fame: optionalIntParam(0, 3),
  /**
   * Batch lookup: `?slugs=mutanabi,abu-nuwas` returns those شعراء as full
   * `PoetSummary` rows, in the order asked, and ignores every other filter.
   * The duel summary's «الشعراء الذين لقيتهم» grid is why it exists — an
   * `Exchange` carries only `{slug, name}`, and a PoetCard needs عصر, ديوان
   * size and a ترجمة (design-ux.md §4 Summary). Unknown slugs are simply
   * absent, never a 400.
   */
  slugs: optionalStr(z.string().max(2000)),
  sort: PoetsSortSchema.optional().default("name"),
  ...pageShape,
})
export type PoetsQuery = z.infer<typeof PoetsQuerySchema>

export const PoetPoemsQuerySchema = z.object({
  meter: optionalStr(SlugSchema),
  theme: optionalStr(SlugSchema),
  rhyme: optionalStr(ArabicLetterSchema),
  sort: PoemsSortSchema.optional().default("fame"),
  seed: optionalStr(SeedSchema),
  ...pageShape,
})
export type PoetPoemsQuery = z.infer<typeof PoetPoemsQuerySchema>

export const PoemsQuerySchema = z.object({
  ...poemFilterShape,
  sort: PoemsSortSchema.optional().default("fame"),
  /** only meaningful for sort=random; makes pagination stable (design-ux.md §3) */
  seed: optionalStr(SeedSchema),
  ...pageShape,
})
export type PoemsQuery = z.infer<typeof PoemsQuerySchema>

/** GET /api/poems/:publicId/baits — the 11,608-hemistich poem is why. */
export const PoemBaitsQuerySchema = z.object({
  offset: intParam(0, 1000000, 0),
  limit: intParam(1, LIMITS.maxBaitsLimit, LIMITS.poemDetailBaits),
})
export type PoemBaitsQuery = z.infer<typeof PoemBaitsQuerySchema>

/** amendments.md §9 — GET /api/poems/:publicId/similar */
export const SimilarQuerySchema = z.object({
  limit: intParam(1, LIMITS.maxSimilarLimit, 8),
})
export type SimilarQuery = z.infer<typeof SimilarQuerySchema>

/** GET /api/baits — bayt-mode browse when rhyme/first are active. */
export const BaitsQuerySchema = z.object({
  era: optionalStr(SlugSchema),
  meter: optionalStr(SlugSchema),
  theme: optionalStr(SlugSchema),
  poet: optionalStr(PoetSlugSchema),
  rhyme: optionalStr(ArabicLetterSchema),
  first: optionalStr(ArabicLetterSchema),
  fame: optionalIntParam(0, 3),
  ...pageShape,
})
export type BaitsQuery = z.infer<typeof BaitsQuerySchema>

/**
 * GET /api/baits/random
 *
 * `poet` is what #/wander's «شاعره» door walks on — the route's filter already
 * joins `poems` for the قافية and البحر doors, so scoping the sample to one
 * شاعر costs nothing extra.
 */
export const RandomBaitQuerySchema = z.object({
  era: optionalStr(SlugSchema),
  meter: optionalStr(SlugSchema),
  poet: optionalStr(PoetSlugSchema),
  rhyme: optionalStr(ArabicLetterSchema),
  first: optionalStr(ArabicLetterSchema),
  fame: optionalIntParam(0, 3),
  seed: optionalStr(SeedSchema),
})
export type RandomBaitQuery = z.infer<typeof RandomBaitQuerySchema>

/** GET /api/baits/daily — seed = fnv1a32(date in Asia/Riyadh). */
export const DailyQuerySchema = z.object({
  date: optionalStr(DayKeySchema),
})
export type DailyQuery = z.infer<typeof DailyQuerySchema>

/** GET /api/facets — same filters as /api/poems, no paging. */
export const FacetsQuerySchema = z.object(poemFilterShape)
export type FacetsQuery = z.infer<typeof FacetsQuerySchema>

/** GET /api/search — limit capped at 40, not 100. */
export const SearchQuerySchema = z.object({
  q: z
    .union([z.string(), z.undefined()])
    .transform((v) => (v ?? "").trim().slice(0, 200))
    .default(""),
  scope: SearchScopeSchema.optional().default("all"),
  era: optionalStr(SlugSchema),
  meter: optionalStr(SlugSchema),
  poet: optionalStr(PoetSlugSchema),
  rhyme: optionalStr(ArabicLetterSchema),
  /** force a mode instead of letting AND fall back to OR ('عبارة' is quoting, not a mode) */
  mode: SearchModeSchema.optional(),
  page: intParam(1, 100000, 1),
  limit: intParam(1, LIMITS.maxSearchLimit, LIMITS.defaultLimit),
})
export type SearchQuery = z.infer<typeof SearchQuerySchema>

/** GET /api/train/candidates — new drill cards (design-ux.md §5). */
export const TrainCandidatesQuerySchema = z.object({
  letter: optionalStr(ArabicLetterSchema),
  famous: boolParam(true),
  meter: optionalStr(SlugSchema),
  era: optionalStr(SlugSchema),
  seed: optionalStr(SeedSchema),
  limit: intParam(1, LIMITS.maxLimit, 10),
})
export type TrainCandidatesQuery = z.infer<typeof TrainCandidatesQuerySchema>

/**
 * GET /api/game/pool — amendments.md §2. Reads `combo_counts` so the duel setup
 * screen shows a live eligible-pool count (and warns below 2,000) instantly.
 */
export const GamePoolQuerySchema = z.object({
  difficulty: DifficultySchema.optional().default("normal"),
  era: optionalStr(SlugSchema),
  meter: optionalStr(SlugSchema),
  theme: optionalStr(SlugSchema),
  lang: optionalStr(LangTypeSchema),
})
export type GamePoolQuery = z.infer<typeof GamePoolQuerySchema>

/**
 * GET /api/game/assist — وضع التدريب's suggestion rail (v2.md §2).
 *
 * `letter` is the chain letter the answer must open on, so it is the enum and
 * not a free string: the rail asks about the turn it is in, never about
 * arbitrary text. `q` is what the player has typed so far, raw — it is folded
 * by `shared/arabic.ts` on the way in and never reaches SQL as text.
 */
export const GameAssistQuerySchema = z.object({
  letter: ArabicLetterSchema,
  q: z.string().max(300).default(""),
  limit: intParam(1, ASSIST.maxLimit, ASSIST.defaultLimit),
})
export type GameAssistQuery = z.infer<typeof GameAssistQuerySchema>

// ═══════════════════════════════════════════════════════════════════════════
// 7. Response schemas — GET routes
// ═══════════════════════════════════════════════════════════════════════════

/** Every list response carries the same envelope: items + total + echo. */
function listResponse<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
  })
}

export const MetaResponseSchema = z.object({
  buildId: z.string(),
  builtAt: z.string(),
  schemaVersion: z.number().int().positive(),
  sourceRevision: z.string().nullable(),
  counts: z.object({
    poems: z.number().int().nonnegative(),
    baits: z.number().int().nonnegative(),
    poets: z.number().int().nonnegative(),
    gameBaits: z.number().int().nonnegative(),
  }),
  meters: z.array(MeterInfoSchema),
  eras: z.array(EraInfoSchema),
  themes: z.array(ThemeInfoSchema),
  /** amendments.md §10 — 28 rows, one per folded letter */
  letters: z.array(LetterInfoSchema),
})
export type MetaResponse = z.infer<typeof MetaResponseSchema>

export const PoetsResponseSchema = listResponse(PoetSummarySchema)
export type PoetsResponse = z.infer<typeof PoetsResponseSchema>

export const PoetPageResponseSchema = z.object({
  poet: PoetDetailSchema,
  /** the poet's most famous/opening بيت, for the header plate */
  signatureBait: BaitDtoSchema.nullable(),
  poems: z.array(PoemSummarySchema),
  poemsTotal: z.number().int().nonnegative(),
  /** facet chips scoped to this poet (design-ux.md §3 toolbar) */
  rhymes: z.array(z.object({ letter: ArabicLetterSchema, count: z.number().int().nonnegative() })),
  meters: z.array(z.object({ slug: SlugSchema, name: z.string(), count: z.number().int().nonnegative() })),
  themes: z.array(z.object({ slug: SlugSchema, name: z.string(), count: z.number().int().nonnegative() })),
})
export type PoetPageResponse = z.infer<typeof PoetPageResponseSchema>

export const PoemsResponseSchema = listResponse(PoemSummarySchema)
export type PoemsResponse = z.infer<typeof PoemsResponseSchema>

/**
 * GET /api/poems/:publicId. `baits` is the FIRST PAGE only (≤200) — `total` is
 * the whole poem, the rest comes from /baits. Every entry is a paired
 * `{sadr, ajuz|null}` bayt, never a flat hemistich list (design-ux.md §10).
 */
export const PoemDetailResponseSchema = z.object({
  poem: PoemDetailSchema,
  poet: PoetSummarySchema,
  baits: z.array(BaitDtoSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** mirrors poem.hasTashkeel; the تشكيل toolbar button renders only when true */
  hasTashkeel: z.boolean(),
})
export type PoemDetailResponse = z.infer<typeof PoemDetailResponseSchema>

export const PoemBaitsResponseSchema = z.object({
  items: z.array(BaitDtoSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
})
export type PoemBaitsResponse = z.infer<typeof PoemBaitsResponseSchema>

export const SimilarPoemsResponseSchema = z.object({
  items: z.array(PoemSummarySchema),
  total: z.number().int().nonnegative(),
})
export type SimilarPoemsResponse = z.infer<typeof SimilarPoemsResponseSchema>

export const BaitsResponseSchema = listResponse(BaitDtoSchema)
export type BaitsResponse = z.infer<typeof BaitsResponseSchema>

export const BaitDetailResponseSchema = z.object({
  bait: BaitDtoSchema,
  poem: PoemSummarySchema,
  poet: PoetSummarySchema,
  prev: BaitDtoSchema.nullable(),
  next: BaitDtoSchema.nullable(),
})
export type BaitDetailResponse = z.infer<typeof BaitDetailResponseSchema>

const slugFacetSchema = z.object({
  slug: SlugSchema,
  name: z.string(),
  count: z.number().int().nonnegative(),
})
const letterFacetSchema = z.object({
  letter: ArabicLetterSchema,
  count: z.number().int().nonnegative(),
})
export type SlugFacet = z.infer<typeof slugFacetSchema>
export type LetterFacet = z.infer<typeof letterFacetSchema>
export const SlugFacetSchema = slugFacetSchema
export const LetterFacetSchema = letterFacetSchema

/**
 * GET /api/facets. EVERY value of every facet appears, INCLUDING zeros — the
 * browse letter grids disable a letter at 0 rather than hiding it, and the
 * "جرّب إزالة: X (0 نتيجة)" empty state needs to know which chip zeroed the
 * combination (design-ux.md §3).
 */
export const FacetsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  eras: z.array(slugFacetSchema),
  meters: z.array(slugFacetSchema),
  themes: z.array(slugFacetSchema),
  rhymes: z.array(letterFacetSchema),
  firstLetters: z.array(letterFacetSchema),
  langTypes: z.array(z.object({ value: LangTypeSchema, count: z.number().int().nonnegative() })),
})
export type FacetsResponse = z.infer<typeof FacetsResponseSchema>

/**
 * GET /api/search. `mode` reports which pass actually produced these rows: 'or'
 * means AND returned nothing and the client must show «لا نتيجة بكل الكلمات».
 */
export const SearchResponseSchema = z.object({
  q: z.string(),
  scope: SearchScopeSchema,
  mode: SearchModeSchema,
  baits: z.array(BaitHitSchema),
  poems: z.array(PoemHitSchema),
  poets: z.array(PoetHitSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  ms: z.number().nonnegative(),
})
export type SearchResponse = z.infer<typeof SearchResponseSchema>

/**
 * GET /api/baits/daily. `seed` is exported because amendments.md §6 builds the
 * shared daily chain from `${dailySeed}:${turn}` — everyone faces the same
 * opponent on #/daily.
 */
export const DailyResponseSchema = z.object({
  date: DayKeySchema,
  seed: z.string(),
  bait: BaitDtoSchema,
  poem: PoemSummarySchema,
  poetOfTheDay: PoetSummarySchema,
})
export type DailyResponse = z.infer<typeof DailyResponseSchema>

export const HistogramBinSchema = z.object({
  /** inclusive lower bound of the bin, in أبيات */
  min: z.number().int().nonnegative(),
  /** inclusive upper bound; null = open-ended top bin */
  max: z.number().int().nonnegative().nullable(),
  label: z.string(),
  count: z.number().int().nonnegative(),
})
export type HistogramBin = z.infer<typeof HistogramBinSchema>

/** GET /api/stats — read straight out of meta.stats_json, never computed live. */
export const StatsResponseSchema = z.object({
  buildId: z.string(),
  counts: z.object({
    poems: z.number().int().nonnegative(),
    baits: z.number().int().nonnegative(),
    poets: z.number().int().nonnegative(),
    gameBaits: z.number().int().nonnegative(),
  }),
  eras: z.array(
    z.object({
      slug: SlugSchema,
      name: z.string(),
      sort: z.number().int(),
      poems: z.number().int().nonnegative(),
      poets: z.number().int().nonnegative(),
      baits: z.number().int().nonnegative(),
    }),
  ),
  meters: z.array(
    z.object({
      slug: SlugSchema,
      name: z.string(),
      kind: MeterKindSchema,
      poems: z.number().int().nonnegative(),
      baits: z.number().int().nonnegative(),
    }),
  ),
  themes: z.array(slugFacetSchema),
  rhymes: z.array(letterFacetSchema),
  firstLetters: z.array(letterFacetSchema),
  langTypes: z.array(z.object({ value: LangTypeSchema, count: z.number().int().nonnegative() })),
  poemLengths: z.array(HistogramBinSchema),
  topPoets: z.array(PoetSummarySchema),
})
export type StatsResponse = z.infer<typeof StatsResponseSchema>

export const TrainCandidatesResponseSchema = z.object({
  items: z.array(BaitDtoSchema),
  total: z.number().int().nonnegative(),
})
export type TrainCandidatesResponse = z.infer<typeof TrainCandidatesResponseSchema>

/** amendments.md §2 — the setup screen's live pool counter. */
export const GamePoolResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  byLetter: z.array(letterFacetSchema),
  /**
   * What the duel can ACTUALLY draw on: `pickBait` relaxes one tier when the
   * chosen one is dry (server/game.ts `RELAX`), and every arrow points at a
   * strictly larger pool, so the honest answer to «هل هذه القيود صالحة للعب؟»
   * is this number, not `total`. Equal to `total` at «سيف», which relaxes
   * nowhere. `byLetter` stays the chosen tier's own count — it is the shape of
   * the pool, and the relax is a fallback, not a promise.
   */
  effectiveTotal: z.number().int().nonnegative().optional(),
})
export type GamePoolResponse = z.infer<typeof GamePoolResponseSchema>

/**
 * v2.md §2 — up to eight real أبيات that open on the required letter and carry
 * what the player has typed. The list envelope is the house one even though
 * the rail never pages: `total` is how many of the scanned pool matched, so a
 * client can say «ومثلها كثير» without a second request.
 */
export const GameAssistResponseSchema = listResponse(BaitDtoSchema)
export type GameAssistResponse = z.infer<typeof GameAssistResponseSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 8. Game — requests (POST /api/game/*, design-server.md §8)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Optional constraints the player set on the setup screen («القيود»). Tolerant
 * on the way in — `null` and `""` are dropped to "unset" before validation, so
 * a client that keeps its filter object fully-keyed does not have to prune it.
 */
const dropEmptyKeys = (v: unknown): unknown => {
  if (v === null || v === undefined) return {}
  if (typeof v !== "object" || Array.isArray(v)) return v
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined || val === "") continue
    out[k] = val
  }
  return out
}

export const GameFiltersSchema = z.preprocess(
  dropEmptyKeys,
  z.object({
    era: SlugSchema.optional(),
    meter: SlugSchema.optional(),
    theme: SlugSchema.optional(),
    poet: PoetSlugSchema.optional(),
    lang: LangTypeSchema.optional(),
  }),
)
export type GameFilters = z.infer<typeof GameFiltersSchema>

/** Exclude list: any length accepted, truncated to MAX_EXCLUDES by the schema. */
const excludeIds = z
  .array(z.number().int().positive())
  .max(20000)
  .optional()
  .default([])
  .transform((ids) => ids.slice(0, MAX_EXCLUDES))

/** POST /api/game/start */
export const GameStartRequestSchema = z.object({
  difficulty: DifficultySchema.default("normal"),
  mode: ChainModeSchema.default("rhyme"),
  filters: GameFiltersSchema.optional(),
  seed: SeedSchema.optional(),
})
export type GameStartRequest = z.infer<typeof GameStartRequestSchema>

/**
 * POST /api/game/verify. The client sends what it knows; the server re-derives
 * everything it can and stays the sole authority on acceptance (design-ux.md
 * §4 — the client's letter pre-check is UI sugar only, amendments.md §13).
 */
export const GameVerifyRequestSchema = z.object({
  text: z.string().min(1).max(600),
  /** the bait the opponent just recited; the server reads its letters off it */
  prevBaitId: z.number().int().positive().nullish().transform((v) => v ?? undefined),
  /** fallback when there is no prev bait (e.g. after «بدّل الحرف») */
  requiredLetter: ArabicLetterSchema.nullish().transform((v) => v ?? undefined),
  mode: ChainModeSchema.default("rhyme"),
  usedBaitIds: excludeIds,
  usedPoemIds: excludeIds,
  filters: GameFiltersSchema.optional(),
  sessionSeed: SeedSchema.optional(),
})
export type GameVerifyRequest = z.infer<typeof GameVerifyRequestSchema>

/** POST /api/game/reply */
export const GameReplyRequestSchema = z.object({
  letter: ArabicLetterSchema,
  difficulty: DifficultySchema.default("normal"),
  mode: ChainModeSchema.default("rhyme"),
  /** amendments.md §5 — 'easy' avoids rare terminal rawiyy, 'hard' prefers it */
  tailBias: TailBiasSchema.default("none"),
  excludeBaitIds: excludeIds,
  excludePoemIds: excludeIds,
  filters: GameFiltersSchema.optional(),
  /** `${dailySeed}:${turn}` on #/daily so the whole chain is shared (amendments.md §6) */
  seed: SeedSchema.optional(),
})
export type GameReplyRequest = z.infer<typeof GameReplyRequestSchema>

export const HintKindSchema = z.enum(["poet", "first_word", "meter", "switch_letter"])
export type HintKind = z.infer<typeof HintKindSchema>

/**
 * POST /api/game/hint. The three cheap hints reveal something about the bait
 * the player is stuck ON (its id is `baitId`); «بدّل الحرف» (amendments.md §8)
 * instead asks the server for a fresh required letter from a famous بيت so a
 * duel never dead-ends on ظ.
 */
export const GameHintRequestSchema = z.object({
  kind: HintKindSchema,
  /** required for poet/first_word/meter — the opponent's bait */
  baitId: z.number().int().positive().nullish().transform((v) => v ?? undefined),
  /** switch_letter: the letter being abandoned, so the server picks a different one */
  letter: ArabicLetterSchema.nullish().transform((v) => v ?? undefined),
  /**
   * The duel's chain mode — the same field `verify`/`reply` carry, and for the
   * same reason: a hint describes a بيت that must ANSWER the required letter,
   * and which letter that is depends on the mode. Without it every hint bought
   * in `literal` mode described a بيت on the روي — the one letter the server
   * would then refuse — and «بدّل الحرف» handed back a chain state the play
   * screen rendered as the new wall while `verifyAnswer` demanded another.
   */
  mode: ChainModeSchema.default("rhyme"),
  difficulty: DifficultySchema.default("normal"),
  filters: GameFiltersSchema.optional(),
  seed: SeedSchema.optional(),
})
export type GameHintRequest = z.infer<typeof GameHintRequestSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 9. Game — responses (discriminated unions)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The chain state every accepted/recited بيت hands to the next turn.
 * `requiredLetter` is authoritative; `alsoAccepted` is the leniency set
 * (empty in 'literal' mode, `[lastLetter]` in 'rhyme' mode when the روي was
 * peeled). `obscurity = clamp(1 - fame/3 + (position>8 ? 0.15 : 0), 0, 1)`.
 */
const chainShape = {
  requiredLetter: ArabicLetterSchema,
  requiredLetterSource: RequiredLetterSourceSchema,
  alsoAccepted: z.array(ArabicLetterSchema),
  mode: ChainModeSchema,
  obscurity: z.number().min(0).max(1),
}

export const ChainStateSchema = z.object(chainShape)
export type ChainState = z.infer<typeof ChainStateSchema>

/** The payload shared by start / reply / a successful verify. */
const servedBaitShape = {
  bait: BaitDtoSchema,
  poem: PoemSummarySchema,
  poet: PoetSummarySchema,
  ...chainShape,
}

export const GameStartOkSchema = z.object({ ok: z.literal(true), seed: z.string().nullable(), ...servedBaitShape })
export const GameNoBaitSchema = z.object({
  ok: z.literal(false),
  reason: z.literal("no_bait"),
  letter: ArabicLetterSchema.nullable(),
})

/** POST /api/game/start → a bait to answer, or an exhausted pool. */
export const GameStartResponseSchema = z.discriminatedUnion("ok", [GameStartOkSchema, GameNoBaitSchema])
export type GameStartResponse = z.infer<typeof GameStartResponseSchema>

export const GameReplyOkSchema = z.object({
  ok: z.literal(true),
  seed: z.string().nullable(),
  /**
   * The opponent had to step OUTSIDE the «القيود» to answer at all — every tier
   * inside them was dry on this letter. The alternative is `no_bait`, which the
   * client scores as «أفحمتَ الخصم» (+500) and which a thin عصر×بحر pair makes
   * farmable in one move (server/game.ts `relaxFilters`). Absent means the
   * reply came from inside the filters, as asked.
   */
  relaxed: z.boolean().optional(),
  ...servedBaitShape,
})

/**
 * POST /api/game/reply → the opponent's بيت, or `no_bait`, which the client
 * turns into the «أفحمتَ الخصم» victory (+500, amendments.md §16).
 */
export const GameReplyResponseSchema = z.discriminatedUnion("ok", [GameReplyOkSchema, GameNoBaitSchema])
export type GameReplyResponse = z.infer<typeof GameReplyResponseSchema>

// ── verify ────────────────────────────────────────────────────────────────

export const GameVerifyOkSchema = z.object({
  ok: z.literal(true),
  matchKind: MatchKindSchema,
  /** 0..1; 1 for an exact h_full hit, the jaccard score for a fuzzy one */
  confidence: z.number().min(0).max(1),
  /** the normalized form of what the player typed, echoed for the reveal UI */
  normalized: z.string(),
  ...servedBaitShape,
})
export type GameVerifyOk = z.infer<typeof GameVerifyOkSchema>

/**
 * The eight rejection tags. `wrong_letter`, `already_used`, `ambiguous`,
 * `too_short` and `near_miss` cost no life; `not_found` and `incomplete_bait`
 * do (design-ux.md §4, amendments.md §7).
 */
export const GameVerifyFailureSchema = z.discriminatedUnion("reason", [
  /** «هذا البيت يبدأ بـ «م»، والمطلوب «ن»» — input kept, no life lost */
  z.object({
    ok: z.literal(false),
    reason: z.literal("wrong_letter"),
    expected: ArabicLetterSchema,
    alsoAccepted: z.array(ArabicLetterSchema),
    got: ArabicLetterSchema.nullable(),
    normalized: z.string(),
  }),
  /** «قيل هذا البيت في هذه المساجلة» — the link scrolls to that exchange */
  z.object({
    ok: z.literal(false),
    reason: z.literal("already_used"),
    bait: BaitDtoSchema,
  }),
  /** «لم أجده في الديوان» — −1 life, ≤3 tappable «هل تقصد؟» suggestions */
  z.object({
    ok: z.literal(false),
    reason: z.literal("not_found"),
    normalized: z.string(),
    suggestions: z.array(BaitDtoSchema).max(3),
  }),
  /**
   * amendments.md §7 — FTS band 0.35..0.60: one suggestion plus an
   * «اقبل هذا البيت» button costing HINT_COSTS.accept_near_miss. Distinct from
   * not_found, which only offers a list.
   */
  z.object({
    ok: z.literal(false),
    reason: z.literal("near_miss"),
    normalized: z.string(),
    suggestion: BaitDtoSchema,
    score: z.number().min(0).max(1),
    acceptCost: z.number().int().nonnegative(),
  }),
  /** «وجدتُ أكثر من بيت» — chip row, tap to pick, no life lost */
  z.object({
    ok: z.literal(false),
    reason: z.literal("ambiguous"),
    normalized: z.string(),
    candidates: z.array(BaitDtoSchema).min(2).max(4),
  }),
  /** matched a بيت whose عجز is missing (odd hemistich count in the source) */
  z.object({
    ok: z.literal(false),
    reason: z.literal("incomplete_bait"),
    bait: BaitDtoSchema,
  }),
  /** < 2 words — never reaches SQLite */
  z.object({
    ok: z.literal(false),
    reason: z.literal("too_short"),
    words: z.number().int().nonnegative(),
  }),
  /** the pool under these filters is empty (start/reply share this tag) */
  z.object({
    ok: z.literal(false),
    reason: z.literal("no_bait"),
    letter: ArabicLetterSchema.nullable(),
  }),
])
export type GameVerifyFailure = z.infer<typeof GameVerifyFailureSchema>

export const GameVerifyResponseSchema = z.union([GameVerifyOkSchema, GameVerifyFailureSchema])
export type GameVerifyResponse = z.infer<typeof GameVerifyResponseSchema>

/** The rejection tags, as a value — for exhaustive switches and tests. */
export const VERIFY_REJECT_REASONS = [
  "wrong_letter",
  "already_used",
  "not_found",
  "near_miss",
  "ambiguous",
  "incomplete_bait",
  "too_short",
  "no_bait",
] as const
export type VerifyRejectReason = (typeof VERIFY_REJECT_REASONS)[number]

// ── hint ──────────────────────────────────────────────────────────────────

export const GameHintResponseSchema = z.union([
  z.object({ ok: z.literal(true), kind: z.literal("poet"), cost: z.number().int(), poet: PoetRefSchema }),
  z.object({ ok: z.literal(true), kind: z.literal("first_word"), cost: z.number().int(), firstWord: z.string() }),
  z.object({ ok: z.literal(true), kind: z.literal("meter"), cost: z.number().int(), meter: MeterRefSchema.nullable() }),
  /** «بدّل الحرف»: a brand-new required letter, taken from a famous بيت */
  z.object({
    ok: z.literal(true),
    kind: z.literal("switch_letter"),
    cost: z.number().int(),
    bait: BaitDtoSchema,
    poem: PoemSummarySchema,
    poet: PoetSummarySchema,
    ...chainShape,
  }),
  z.object({ ok: z.literal(false), reason: z.enum(["not_found", "no_bait"]) }),
])
export type GameHintResponse = z.infer<typeof GameHintResponseSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 10. Client persisted slices (design-ux.md §6) — localStorage `qarid:v1:*`
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bump when a slice shape changes incompatibly and add the step to MIGRATIONS.
 * `persist.ts` stores `{v, data}`; a payload whose `v` has no migration path is
 * backed up to `qarid:corrupt-backup:<slice>` and the slice resets to defaults.
 */
export const PERSIST_VERSION = 2

export const PERSIST_KEYS = {
  settings: "qarid:v1:settings",
  duel: "qarid:v1:duel",
  training: "qarid:v1:training",
  profile: "qarid:v1:profile",
  favorites: "qarid:v1:favorites",
} as const
export type PersistSlice = keyof typeof PERSIST_KEYS

/** `{v, data}` envelope every slice is written inside. */
export function persistEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ v: z.number().int().nonnegative(), data })
}

/**
 * version → transform to the NEXT version.
 *
 * One rule the mechanism imposes: a step is applied to EVERY slice stored at
 * that version, not only to the one it was written for (`persist.ts` runs the
 * chain before it knows which schema it is about to parse). So a step must
 * recognise its own shape and hand everything else back untouched.
 */
export const MIGRATIONS: Record<number, (data: unknown) => unknown> = {
  /**
   * v1 → v2: `outcome` and `endedAt` join the duel session.
   *
   * A v1 session that ended is still on disk with neither, and both default to
   * null — which is exactly the backlog bug: reloading `#/duel/summary` traded
   * «انقضت الأرواح» for «سلسلة من 6 أبيات». What CAN be recovered from a v1
   * payload is recovered here, and only that: no lives left is a defeat, ten
   * أبيات in المبارزة is a finished مبارزة, and everything else stayed
   * genuinely ambiguous (انسحبتَ and أفحمتَ الخصم both end with lives to
   * spare), so it is left null rather than guessed. `endedAt` falls back to the
   * last بيت's timestamp — the honest floor on when the مساجلة stopped.
   */
  1: (data: unknown): unknown => {
    if (typeof data !== "object" || data === null || !("session" in data)) return data
    const slice = data as { session: unknown }
    const s = slice.session
    if (typeof s !== "object" || s === null) return data
    const session = s as Record<string, unknown>
    if (session.phase !== "summary") return data

    const exchanges = Array.isArray(session.exchanges) ? session.exchanges : []
    const last = exchanges.length ? (exchanges[exchanges.length - 1] as Record<string, unknown> | undefined) : undefined
    const lastAt = typeof last?.at === "number" ? last.at : null
    const startedAt = typeof session.startedAt === "number" ? session.startedAt : null

    const lives = typeof session.lives === "number" ? session.lives : 1
    const format = (session.config as Record<string, unknown> | undefined)?.format
    const playerTurns = exchanges.filter(
      (e) => typeof e === "object" && e !== null && (e as Record<string, unknown>).side === "player",
    ).length
    const outcome =
      session.outcome ?? (lives <= 0 ? "defeat" : format === "match" && playerTurns >= MUBARAZA_EXCHANGES ? "match" : null)

    return { ...slice, session: { ...session, outcome, endedAt: session.endedAt ?? lastAt ?? startedAt } }
  },
}

// ── settings ──────────────────────────────────────────────────────────────

export const VerseSizeSchema = z.enum(["sm", "md", "lg"])
export const ReduceMotionSchema = z.enum(["system", "on", "off"])

export const SettingsSliceSchema = z.object({
  /** render tashkeel when the poem has it; off strips it client-side */
  tashkeel: z.boolean().default(true),
  /** lapis underline under the روي */
  showRawiyy: z.boolean().default(false),
  verseSize: VerseSizeSchema.default("md"),
  sound: z.boolean().default(false),
  reduceMotion: ReduceMotionSchema.default("system"),
})
export type SettingsSlice = z.infer<typeof SettingsSliceSchema>

// ── duel session ──────────────────────────────────────────────────────────

export const DuelTierSchema = z.enum(["beginner", "poet", "champion", "sword"])
export type DuelTier = z.infer<typeof DuelTierSchema>

/** UX tier → server difficulty (design-server.md §8). */
export const TIER_DIFFICULTY: Record<DuelTier, Difficulty> = {
  beginner: "easy",
  poet: "normal",
  champion: "hard",
  sword: "brutal",
}

/** «الوصال» endless vs «المبارزة» best-of-10 on points (design-ux.md §4). */
export const DuelFormatSchema = z.enum(["endless", "match"])
export type DuelFormat = z.infer<typeof DuelFormatSchema>

export const DuelConfigSchema = z.object({
  tier: DuelTierSchema.default("poet"),
  difficulty: DifficultySchema.default("normal"),
  chainMode: ChainModeSchema.default("rhyme"),
  tailBias: TailBiasSchema.default("none"),
  format: DuelFormatSchema.default("endless"),
  timer: z.boolean().default(true),
  /** seconds per turn: 60/40/25/15 by tier; ignored when `timer` is false */
  turnSeconds: z.number().int().min(5).max(600).default(40),
  lives: z.number().int().min(1).max(9).default(3),
  filters: GameFiltersSchema.default({}),
  /**
   * وضع التدريب (v2.md §2): the answer field grows a suggestion rail of real
   * أبيات, and every award is halved for it (`ASSIST.scoreMultiplier`). Part of
   * the CONFIG rather than of the settings slice because it is a property of
   * the duel that was played — a summary that says «تدريب» has to still say it
   * after a reload, and a score earned at half price must never be compared
   * against one that was not. Defaulted, so a v1 session on disk parses.
   */
  assist: z.boolean().default(false),
})
export type DuelConfig = z.infer<typeof DuelConfigSchema>

export const DuelPhaseSchema = z.enum([
  "idle",
  "dealing",
  "reciting",
  "awaiting",
  "verifying",
  "disambiguating",
  "rejected",
  "penalising",
  "accepted",
  "computerThinking",
  "summary",
  "failed",
])
export type DuelPhase = z.infer<typeof DuelPhaseSchema>

/** One recited بيت in the transcript — denormalized so it renders offline. */
export const ExchangeSchema = z.object({
  side: z.enum(["player", "opponent"]),
  baytKey: BaytKeySchema,
  baitId: z.number().int().positive().nullable().default(null),
  sadr: z.string(),
  ajuz: z.string().nullable(),
  poemId: PublicPoemIdSchema.nullable().default(null),
  poet: PoetRefSchema.nullable().default(null),
  meter: MeterRefSchema.nullable().default(null),
  requiredLetter: ArabicLetterSchema.nullable().default(null),
  award: z.number().int().default(0),
  hints: z.array(HintKindSchema).default([]),
  /** ms the player took on this exchange (wall-clock anchored, amendments.md §7) */
  ms: z.number().int().nonnegative().default(0),
  obscurity: z.number().min(0).max(1).default(0),
  at: z.number().int().nonnegative().default(0),
  /**
   * The opponent had to leave the «القيود» to answer this one — `relaxed: true`
   * on `/api/game/reply`. Only ever set on an `opponent` exchange; the card
   * says «خرج عن القيود» so a بيت from outside the chosen عصر/بحر is not read
   * as the filter having quietly failed. Defaults false, so a session written
   * before the field existed still parses.
   */
  relaxed: z.boolean().default(false),
})
export type Exchange = z.infer<typeof ExchangeSchema>

/** The last rejection, kept so a reload lands back on the same feedback card. */
export const DuelLastResultSchema = z
  .object({
    kind: z.enum([...VERIFY_REJECT_REASONS, "timeout", "network", "accepted"]),
    message: z.string().nullable().default(null),
    at: z.number().int().nonnegative().default(0),
  })
  .nullable()

/**
 * How a مساجلة ended. Persisted (not derived) because nothing left in a
 * finished session distinguishes «أفحمتَ الخصم» from «انسحبتَ» — both end with
 * lives to spare — so a reload on #/duel/summary would otherwise downgrade the
 * headline to «سلسلة من N بيتًا».
 */
export const DuelOutcomeSchema = z.enum(["stumped", "defeat", "abandoned", "match"]).nullable()
export type DuelOutcomeValue = z.infer<typeof DuelOutcomeSchema>

export const DuelSessionSliceSchema = z.object({
  config: DuelConfigSchema,
  seed: z.string(),
  phase: DuelPhaseSchema.default("idle"),
  required: z
    .object({
      letter: ArabicLetterSchema.nullable().default(null),
      source: RequiredLetterSourceSchema.nullable().default(null),
      alsoAccepted: z.array(ArabicLetterSchema).default([]),
    })
    .default({ letter: null, source: null, alsoAccepted: [] }),
  exchanges: z.array(ExchangeSchema).default([]),
  /** `baytKey`s already said, for the already_used check + the ribbon */
  usedKeys: z.array(BaytKeySchema).default([]),
  usedBaitIds: z.array(z.number().int().positive()).default([]),
  usedPoemIds: z.array(z.number().int().positive()).default([]),
  score: z.number().int().default(0),
  lives: z.number().int().min(0).default(3),
  streak: z.number().int().nonnegative().default(0),
  best: z.number().int().nonnegative().default(0),
  startedAt: z.number().int().nonnegative(),
  /** epoch ms the turn expires; null when the timer is off or paused */
  deadline: z.number().int().nonnegative().nullable().default(null),
  pausedAt: z.number().int().nonnegative().nullable().default(null),
  lastResult: DuelLastResultSchema.default(null),
  /** set on #/daily so the one-attempt-per-day rule can be enforced */
  dailyDate: DayKeySchema.nullable().default(null),
  /* Both are PERSISTED — that is the whole point: nothing else in a finished
   * session tells «أفحمتَ الخصم» from «انسحبتَ». They arrived at v2, and both
   * default to null so a raw v1 payload still parses; what `MIGRATIONS[1]`
   * adds on top is the part of a v1 ending that can honestly be recovered. */
  outcome: DuelOutcomeSchema.default(null),
  endedAt: z.number().int().nonnegative().nullable().default(null),
})
export type DuelSessionSlice = z.infer<typeof DuelSessionSliceSchema>

/** The whole slice may be absent (no duel in progress). */
export const DuelSliceSchema = z.object({
  session: DuelSessionSliceSchema.nullable().default(null),
})
export type DuelSlice = z.infer<typeof DuelSliceSchema>

// ── training (design-ux.md §5) ────────────────────────────────────────────

export const CardGradeSchema = z.enum(["again", "hard", "good", "easy"])
export type CardGrade = z.infer<typeof CardGradeSchema>

/**
 * SM-2-lite card. `id` IS the `baytKey` (one card per بيت). The bait text is
 * denormalized onto the card so the drill works offline and a deleted poem
 * cannot orphan a review queue.
 */
export const TrainingCardSchema = z.object({
  id: BaytKeySchema,
  baitId: z.number().int().positive().nullable().default(null),
  sadr: z.string(),
  ajuz: z.string().nullable(),
  poet: PoetRefSchema.nullable().default(null),
  poemId: PublicPoemIdSchema.nullable().default(null),
  firstLetter: ArabicLetterSchema.nullable().default(null),
  rawiyy: ArabicLetterSchema.nullable().default(null),
  ease: z.number().min(1.3).max(2.8).default(2.3),
  /** days */
  interval: z.number().min(0).max(365).default(0),
  /** epoch ms */
  due: z.number().int().nonnegative(),
  reps: z.number().int().nonnegative().default(0),
  lapses: z.number().int().nonnegative().default(0),
  /** 8 lapses → surfaced on the hub for replace/delete */
  leech: z.boolean().default(false),
  addedAt: z.number().int().nonnegative(),
})
export type TrainingCard = z.infer<typeof TrainingCardSchema>

/** Per-letter arsenal cell: مستعمَل in a duel, محفوظ = interval ≥ 21 days. */
export const ArsenalCellSchema = z.object({
  used: z.number().int().nonnegative().default(0),
  mastered: z.number().int().nonnegative().default(0),
  lastAt: z.number().int().nonnegative().nullable().default(null),
})
export type ArsenalCell = z.infer<typeof ArsenalCellSchema>

export const ArsenalSchema = z.partialRecord(ArabicLetterSchema, ArsenalCellSchema)
export type Arsenal = z.infer<typeof ArsenalSchema>

export const TrainingSessionSchema = z
  .object({
    queue: z.array(BaytKeySchema).default([]),
    index: z.number().int().nonnegative().default(0),
    startedAt: z.number().int().nonnegative().default(0),
    correct: z.number().int().nonnegative().default(0),
    seen: z.number().int().nonnegative().default(0),
  })
  .nullable()

export const TrainingSliceSchema = z.object({
  cards: z.record(BaytKeySchema, TrainingCardSchema).default({}),
  /** local YYYY-MM-DD; resets `newIntroducedToday` on rollover */
  dayKey: DayKeySchema.nullable().default(null),
  newIntroducedToday: z.number().int().nonnegative().default(0),
  arsenal: ArsenalSchema.default({}),
  session: TrainingSessionSchema.default(null),
  reviewStreak: z.number().int().nonnegative().default(0),
  lastReviewDay: DayKeySchema.nullable().default(null),
})
export type TrainingSlice = z.infer<typeof TrainingSliceSchema>

// ── profile ───────────────────────────────────────────────────────────────

export const DailyResultSchema = z.object({
  date: DayKeySchema,
  score: z.number().int().default(0),
  chainLength: z.number().int().nonnegative().default(0),
  letters: z.array(ArabicLetterSchema).default([]),
  completedAt: z.number().int().nonnegative().default(0),
})
export type DailyResult = z.infer<typeof DailyResultSchema>

export const ProfileSliceSchema = z.object({
  gamesPlayed: z.number().int().nonnegative().default(0),
  abyatPlayed: z.number().int().nonnegative().default(0),
  bestStreak: z.number().int().nonnegative().default(0),
  bestScore: z.number().int().default(0),
  /** poet slugs met in duels — «لقيت 47 شاعرًا من 2400» retention mechanic */
  poetsMet: z.array(PoetSlugSchema).default([]),
  dailyResults: z.record(DayKeySchema, DailyResultSchema).default({}),
  reviewStreak: z.number().int().nonnegative().default(0),
  firstSeenAt: z.number().int().nonnegative().default(0),
  /**
   * When «كيف تتم المساجلة؟» was last closed — 0 means never (v2.md §1). The
   * walkthrough auto-offers itself on the FIRST visit to #/duel only, and this
   * is the flag that makes «once» mean once across sessions.
   */
  walkthroughSeenAt: z.number().int().nonnegative().default(0),
})
export type ProfileSlice = z.infer<typeof ProfileSliceSchema>

// ── favorites & collections ───────────────────────────────────────────────

/**
 * DENORMALIZED on purpose (design-ux.md §6): a favourite renders with no
 * network at all, so ♥ survives an offline reload and a corpus rebuild that
 * renumbers `baits.id`.
 */
export const SavedBaitSchema = z.object({
  baytKey: BaytKeySchema,
  baitId: z.number().int().positive().nullable().default(null),
  sadr: z.string(),
  ajuz: z.string().nullable(),
  poemId: PublicPoemIdSchema.nullable().default(null),
  poemTitle: z.string().nullable().default(null),
  poet: PoetRefSchema.nullable().default(null),
  meter: MeterRefSchema.nullable().default(null),
  note: z.string().max(500).nullable().default(null),
  savedAt: z.number().int().nonnegative(),
})
export type SavedBait = z.infer<typeof SavedBaitSchema>

export const CollectionSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  baytKeys: z.array(BaytKeySchema).default([]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type Collection = z.infer<typeof CollectionSchema>

export const FavoritesSliceSchema = z.object({
  favorites: z.array(SavedBaitSchema).default([]),
  collections: z.array(CollectionSchema).default([]),
})
export type FavoritesSlice = z.infer<typeof FavoritesSliceSchema>

/** slice name → schema, so `persist.ts` can be written once and looped. */
export const PERSIST_SCHEMAS = {
  settings: SettingsSliceSchema,
  duel: DuelSliceSchema,
  training: TrainingSliceSchema,
  profile: ProfileSliceSchema,
  favorites: FavoritesSliceSchema,
} as const
