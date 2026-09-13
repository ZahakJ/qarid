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

/**
 * The ديوان's own code — TEN characters of the room alphabet, not six.
 *
 * A room code is six letters because it is spoken aloud in the minute before a
 * مساجلة, and `rooms.join_key` is the credential that six-letter name is not
 * (CLAUDE.md). A ديوان has no second credential and no knock: an unlisted
 * ديوان is reachable by exactly the people its owner handed the link to, so the
 * CODE IS the capability and it has to be wide enough to be one. 14⁵ × 5⁵ =
 * 1.68 billion, against 343,000 for a room — and it is still speakable, because
 * a reader reads a ديوان's link aloud too.
 *
 * It lives up here among the identifiers, and not in §11 where the rest of
 * الدواوين is, because §10's persisted duel session now names a ديوان: a
 * مساجلة played inside one carries its code and its title in the config, the
 * way `poetName` carries a شاعر's.
 */
export const AlbumCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[BDFHJKLMNRSTWZ][AEIOU][BDFHJKLMNRSTWZ][AEIOU][BDFHJKLMNRSTWZ][AEIOU][BDFHJKLMNRSTWZ][AEIOU][BDFHJKLMNRSTWZ][AEIOU]$/)
export type AlbumCode = z.infer<typeof AlbumCodeSchema>

export const ALBUM_CODE_LENGTH = 10

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

/**
 * Caps on الدواوين, enforced server-side. A ديوان is a selection; a scrape is
 * not. They sit beside the other limits rather than in §11 because §8's game
 * requests bound the ديوان POOL by `ALBUM_LIMITS.pool` — a مساجلة played
 * inside a shelf is handed at most that many ids, whatever the shelf holds.
 */
export const ALBUM_LIMITS = {
  /** دواوين one account may own */
  perUser: 50,
  /**
   * ENTRIES one ديوان may hold — a قصيدة or a single بيت each. A playlist of
   * two hundred قصائد is a long one; a shelf of two hundred أبيات is the same
   * cap seen from the other kind, and neither is a scrape.
   */
  entries: 200,
  /** entries one `POST /:code/entries` may carry */
  bulk: 120,
  /**
   * The most bait ids a مساجلة is handed for a ديوان. The solo duel carries the
   * pool on every request (design-server.md §8 — the duel is stateless), so it
   * has to be bounded on the wire; a playlist of long قصائد can resolve to far
   * more playable أبيات than this, and the door then says so in words rather
   * than silently. The ROOM reads the shelf server-side and is not bound by it.
   */
  pool: 1000,
  /** أبيات one «أضِفه إلى التحفيظ» press may turn into cards */
  memorize: 300,
  /** other people's دواوين one account may keep in its مكتبة */
  saved: 100,
  /**
   * The floor under «ساجِل في هذا الديوان»: below ten PLAYABLE أبيات the door
   * is closed and says so. A مساجلة is a chain — the opponent must be able to
   * answer on whatever letter the player leaves him — and a shelf of four
   * أبيات concedes on the first turn, which is not a game, it is a bug that
   * awards +500 for pressing a button.
   */
  playableFloor: 10,
  /**
   * The longest اسم a ديوان may carry. `AlbumTitleSchema` is the enforcement;
   * this is the same number where a MESSAGE needs it, so «راجع ما كتبته» and
   * the `max()` can never drift apart.
   */
  titleChars: 60,
} as const

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
 *
 * `poet` is the one «قيد» `combo_counts` cannot answer and the setup screen
 * offers anyway (مساجلة في ديوان شاعرٍ بعينه): it is counted by one grouped scan
 * instead, memoised per (شاعر, رتبة) — see `poolByLetter` in server/game.ts.
 * It mirrors `GameFilters` field for field, which is the point: the number this
 * route reports is the pool `pickBait` will actually draw from.
 */
export const GamePoolQuerySchema = z.object({
  difficulty: DifficultySchema.optional().default("normal"),
  era: optionalStr(SlugSchema),
  meter: optionalStr(SlugSchema),
  theme: optionalStr(SlugSchema),
  poet: optionalStr(PoetSlugSchema),
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
  // The SECOND accepted start-letter, when there is one: in rhyme mode a بيت
  // whose روي was peeled off a وصل accepts an answer on EITHER the روي (`letter`)
  // or the literal ending (`also`), so the rail must search both — otherwise it
  // suggests أبيات on the روي while the player is writing one that opens on the
  // وصل letter. See `alsoAccepted` (design-server.md §8); it is ever only one.
  also: ArabicLetterSchema.optional(),
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

/**
 * المختارات المنظومة — `GET /api/anthologies` and `/api/anthologies/:slug`.
 *
 * An item is ALWAYS returned, resolved or not. `shared/anthologies.ts` explains
 * why: a curated معلقة the corpus does not hold is listed as «ليست في الديوان»
 * rather than dropped, so `poem`/`bait` are nullable and `poet`/`matla` carry
 * the anthology's own words for exactly that case.
 */
export const AnthologyItemSchema = z.object({
  /** position in the curated table — stable, and the client's row key */
  index: z.number().int().nonnegative(),
  /** the شاعر as the anthology names him (not necessarily the corpus spelling) */
  poet: z.string(),
  /** the curated مطلع, printed verbatim when nothing resolved */
  matla: z.string(),
  /** المعلقات only — «معلقة عنترة» */
  name: z.string().nullable(),
  /** the قصيدة, on a `kind: "poems"` shelf; null when unresolved */
  poem: PoemSummarySchema.nullable(),
  /** the بيت, on a `kind: "baits"` shelf; null when unresolved */
  bait: BaitDtoSchema.nullable(),
})
export type AnthologyItem = z.infer<typeof AnthologyItemSchema>

export const AnthologyShelfSchema = z.object({
  slug: SlugSchema,
  title: z.string(),
  tagline: z.string(),
  blurb: z.string(),
  kind: z.enum(["poems", "baits"]),
  /** how many entries the curated table holds */
  total: z.number().int().nonnegative(),
  /** how many of them the corpus actually answered */
  resolved: z.number().int().nonnegative(),
  /** the first few entries, as one display line each — the shelf card's spines */
  preview: z.array(z.string()),
})
export type AnthologyShelf = z.infer<typeof AnthologyShelfSchema>

export const AnthologiesResponseSchema = z.object({
  shelves: z.array(AnthologyShelfSchema),
})
export type AnthologiesResponse = z.infer<typeof AnthologiesResponseSchema>

export const AnthologyResponseSchema = z.object({
  shelf: AnthologyShelfSchema,
  items: z.array(AnthologyItemSchema),
})
export type AnthologyResponse = z.infer<typeof AnthologyResponseSchema>

/**
 * GET /api/buhur — ONE example بيت per بحر, for صفحة البحور.
 *
 * Everything else that page prints is already on the wire or in the bundle: the
 * اسم, التفعيلات, الدائرة and المفتاح are static (`client/data/buhur.ts` — the
 * sixteen بحور of الخليل do not change), and the count of قصائد comes off
 * `/api/meta`'s `meters[].poemCount`, precomputed at ingest. The one thing the
 * corpus alone can answer is «أسمِعني بيتًا على هذا البحر», so that is all this
 * route carries.
 *
 * `example` is nullable per بحر, not per response: a corpus with no voweled
 * قصيدة on المقتضب must still be able to serve the other fifteen, and the card
 * teaches without it — a بحر with no example still has its مفتاح.
 */
export const BahrExampleSchema = z.object({
  /** meter slug — `shared/meters.ts`, always one of the 16 `kind: "bahr"` */
  slug: SlugSchema,
  bait: BaitDtoSchema.nullable(),
})
export type BahrExample = z.infer<typeof BahrExampleSchema>

export const BuhurResponseSchema = z.object({
  items: z.array(BahrExampleSchema),
})
export type BuhurResponse = z.infer<typeof BuhurResponseSchema>

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

/**
 * THE ديوان POOL — the أبيات the OPPONENT may recite, and nothing else.
 *
 * «ساجِل في هذا الديوان» narrows the machine to one reader's shelf: the client
 * resolves the ديوان once (`GET /api/albums/:code/pool` — anchors to playable
 * bait ids) and then carries the ids on every start/reply, exactly the way it
 * already carries `usedBaitIds`. That is not laziness, it is the duel's own
 * shape: design-server.md §8 makes the solo مساجلة STATELESS, so every request
 * carries what the server needs to judge one move, and a pool the CLIENT sends
 * can only ever NARROW what the machine may say — it is not a credential and it
 * decides nothing about the player's own answers, which are still verified
 * against the whole 3.37-million-بيت ديوان.
 *
 * A «قيد» this is not: `GameFilters` narrows by عصر/بحر/شاعر and is dropped
 * when the pool inside it runs dry («خرج عن القيود»). The ديوان is not dropped
 * — leaving it would mean reciting a بيت that is not in the shelf the reader
 * chose, which is the whole feature — so a dry letter concedes instead
 * («أفحمتَ الخصم»), which is what a ديوان of thirty أبيات honestly owes.
 */
const poolBaitIds = z
  .array(z.number().int().positive())
  .max(4000)
  .optional()
  .default([])
  .transform((ids) => ids.slice(0, ALBUM_LIMITS.pool))

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
  /** «ساجِل في هذا الديوان» — the opponent opens from the shelf and nowhere else */
  poolBaitIds,
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
  /** the ديوان the opponent is confined to; empty means the whole corpus */
  poolBaitIds,
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
  /**
   * The ديوان pool, and it binds «بدّل الحرف» ONLY.
   *
   * That hint hands the player a fresh بيت from the OPPONENT — it is a
   * recitation, and inside a ديوان مساجلة it must come from the ديوان. The
   * other three describe a بيت that would ANSWER, i.e. one of the player's own,
   * and the player answers out of the whole corpus: pooling them would teach
   * him the shelf he is playing against instead of the ديوان he must answer
   * from.
   */
  poolBaitIds,
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
  /**
   * «ليس من هذا الديوان» — a مساجلة inside a ديوان only (server/rooms.ts).
   *
   * The بيت is REAL: it passed the same verifier, on the required letter, out of
   * the whole corpus. It simply is not on the shelf the two players agreed to
   * play inside, and the room's rule is that both of them answer from it.
   *
   * SOFT, and the COSTS_LIFE philosophy decides that rather than taste. A strike
   * is charged when the answer was not in the ديوان at all (`not_found`) —
   * memory failed. Nothing is charged when the بيت is real and the player
   * remembered it and some OTHER announced constraint refused it: that is
   * exactly `wrong_letter`, which is free in the solo duel, and this is the same
   * shape one constraint further out. The room says it in words and the turn
   * stays with the player.
   */
  z.object({
    ok: z.literal(false),
    reason: z.literal("not_in_album"),
    /** the بيت he did quote — right poetry, wrong shelf */
    bait: BaitDtoSchema,
    /** the ديوان's name, so the card can say which shelf refused it */
    albumTitle: z.string(),
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
  "not_in_album",
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
   * The chosen شاعر's DISPLAY NAME, when `filters.poet` names one.
   *
   * `GameFilters` is a wire shape and carries slugs, but the summary and the
   * share text have to say «مساجلة في ديوان المتنبي» — and a summary is read
   * offline, after a reload, and days later. So the name is denormalized onto
   * the config exactly as `Exchange` denormalizes `{slug, name}` for every بيت
   * it keeps: a قيد the reader can no longer read is not a قيد he set.
   * Defaulted, so a session written before the field existed still parses.
   */
  poetName: z.string().nullable().default(null),
  /**
   * مساجلة في ديوان — the shelf the OPPONENT recites from, resolved once.
   *
   * `baitIds` is the pool (§8 `poolBaitIds`) and it is persisted with the
   * session for the same reason `poetName` is: a duel survives a reload, and
   * re-resolving the ديوان on every rehydrate would make the machine's next
   * بيت depend on a request that may fail — or on a shelf its curator has
   * edited mid-مساجلة. `title` is the denormalized name the summary and the
   * share text say. Null for every ordinary duel, so a session written before
   * the field existed still parses.
   */
  album: z
    .object({
      code: AlbumCodeSchema,
      title: z.string(),
      baitIds: z.array(z.number().int().positive()).max(ALBUM_LIMITS.pool),
    })
    .nullable()
    .default(null),
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

// ═══════════════════════════════════════════════════════════════════════════
// 11. الدواوين — the shelves a READER compiles (v2 §Backlog, Track «social»)
// ═══════════════════════════════════════════════════════════════════════════
//
// المتنبي had a ديوان because someone collected his أبيات and put them in an
// order. This is that gesture, given to the reader: a named, ordered, shareable
// selection of أبيات out of a 3.37-million-بيت corpus.
//
// THE ONE RULE, and every shape below serves it: **a ديوان anchors its أبيات by
// CONTENT, never by id.** `public_id` is `q<row id>` for 73 % of قصائد and every
// id in the artefact moves on `npm run ingest`, so a table of ids in the
// writable database rots at the next rebuild. `hFull` (`baitAnchor` in
// shared/arabic.ts — the same hash the ingest writes into `baits.h_full`, as a
// decimal string) is the anchor, and beside it rides a display SNAPSHOT taken at
// the moment the بيت was added, so the entry still renders as a بيت even on the
// day a rebuild drops the قصيدة it came from.

/** The anchor of a بيت on the wire: `baits.h_full` as a signed decimal string. */
export const BaitAnchorSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}$/, "anchor must be a decimal fnv1a64")

/**
 * The anchor of a قصيدة on the wire: `poemAnchor(poems.dedup_key)` —
 * `p` and the signed decimal fnv1a64 of the key (shared/arabic.ts). The prefix
 * is what lets one `order` list and one DELETE path carry both kinds.
 */
export const PoemAnchorSchema = z
  .string()
  .trim()
  .regex(/^p-?\d{1,20}$/, "anchor must be p + a decimal fnv1a64")

/** Either kind — what `order` and `DELETE /:code/entries/:anchor` accept. */
export const AlbumAnchorSchema = z.union([PoemAnchorSchema, BaitAnchorSchema])
export type AlbumAnchor = z.infer<typeof AlbumAnchorSchema>

export const AlbumEntryKindSchema = z.enum(["poem", "bait"])
export type AlbumEntryKind = z.infer<typeof AlbumEntryKindSchema>

/* `AlbumCodeSchema` and `ALBUM_CODE_LENGTH` are declared in §1, and
 * `ALBUM_LIMITS` beside the other caps in §2 — the duel session (§10) and the
 * game requests (§8) both name a ديوان now, and both come before this section. */

/**
 * Who may open a ديوان.
 *
 * `private` — its owner and nobody else. `unlisted` — whoever holds the code,
 * and the code is never listed anywhere: no route enumerates another reader's
 * دواوين, so the link is the whole gate. `public` — anyone with the code, and
 * the owner's profile says it exists.
 *
 * There is no «discover» surface and deliberately so: a shelf of strangers'
 * دواوين is a moderation queue, and Track 3 already has one.
 */
export const AlbumVisibilitySchema = z.enum(["private", "unlisted", "public"])
export type AlbumVisibility = z.infer<typeof AlbumVisibilitySchema>

export const AlbumTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(ALBUM_LIMITS.titleChars)
  .regex(/^[^\r\n\t]+$/, "an album title is one line")

export const AlbumDescriptionSchema = z.string().trim().max(280)

/**
 * One entry on a shelf, as the server resolved it TODAY — a whole قصيدة, or a
 * single بيت.
 *
 * A ديوان is a playlist: what a reader puts on it is a قصيدة, and a قصيدة is
 * ONE entry, opened from its first بيت, never forty rows that happen to sit
 * together. A single بيت is the other kind of entry — the line that stood out —
 * and the two share an ordered list, a rail and a rule.
 *
 * The rule: `poem` / `bait` is the live corpus row when the anchor still finds
 * one and null when it does not; `snapshot` is what was true the day it was
 * added and is always present. A ديوان whose قصيدة a rebuild dropped still
 * prints it — from the snapshot, with the quiet «ليست في الديوان اليوم» state —
 * because a collection that empties itself when the artefact changes was never
 * a collection.
 */
const AlbumEntryBase = {
  /** the curator's order, 0-based and contiguous */
  position: z.number().int().nonnegative(),
  addedAt: z.number().int().nonnegative(),
}

export const AlbumPoemEntrySchema = z.object({
  kind: z.literal("poem"),
  anchor: PoemAnchorSchema,
  ...AlbumEntryBase,
  /** the قصيدة the day it was added: its عنوان, its مطلع, its شاعر, its length */
  snapshot: z.object({
    title: z.string(),
    sadr: z.string(),
    ajuz: z.string().nullable(),
    poet: z.string(),
    baitCount: z.number().int().nonnegative(),
  }),
  /** the live قصيدة, or null when today's artefact has no copy of it */
  poem: PoemSummarySchema.nullable(),
})
export type AlbumPoemEntry = z.infer<typeof AlbumPoemEntrySchema>

export const AlbumBaitEntrySchema = z.object({
  kind: z.literal("bait"),
  anchor: BaitAnchorSchema,
  ...AlbumEntryBase,
  snapshot: z.object({
    sadr: z.string(),
    ajuz: z.string().nullable(),
    poet: z.string(),
  }),
  /** the live row, or null when today's artefact has no copy of this بيت */
  bait: BaitDtoSchema.nullable(),
})
export type AlbumBaitEntry = z.infer<typeof AlbumBaitEntrySchema>

export const AlbumEntrySchema = z.discriminatedUnion("kind", [AlbumPoemEntrySchema, AlbumBaitEntrySchema])
export type AlbumEntry = z.infer<typeof AlbumEntrySchema>

/** A ديوان without its أبيات — the card in «دواويني» and the head of its page. */
export const AlbumSummarySchema = z.object({
  code: AlbumCodeSchema,
  title: z.string(),
  description: z.string().nullable(),
  visibility: AlbumVisibilitySchema,
  /** entries on the shelf — `poems + baits` */
  count: z.number().int().nonnegative(),
  /** قصائد on it, whole */
  poems: z.number().int().nonnegative(),
  /** single أبيات on it */
  baits: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** the compiler, for the visitor's «جمعه فلان» line */
  curator: z.object({ username: z.string(), displayName: z.string() }),
  /** true for the signed-in owner — the only reader who gets the edit rail */
  isOwner: z.boolean(),
  /**
   * Whether the SIGNED-IN reader keeps this ديوان in his مكتبة — a fact about
   * the VIEWER, exactly like `isOwner`, and false for a signed-out one. It rides
   * on the summary rather than on a second request because every surface that
   * shows a shelf belonging to someone else («دواوينه» on a profile, the shelf
   * page itself) needs the same button in the same two states.
   */
  saved: z.boolean().default(false),
})
export type AlbumSummary = z.infer<typeof AlbumSummarySchema>

/**
 * A ديوان somebody ELSE compiled, kept on your shelf — «من مكتبتك».
 *
 * The row survives its shelf being closed. A curator may take a ديوان back to
 * `private` after you saved it, and the honest thing then is neither to delete
 * your row silently nor to keep printing a title he retracted: the entry stays,
 * `album` is null, and `gated` says which of the two reasons it is. Nothing of
 * the shelf — not its title, not its count, not its curator — crosses that gate.
 */
export const SavedAlbumSchema = z.object({
  code: AlbumCodeSchema,
  savedAt: z.number().int().nonnegative(),
  /** the shelf as it stands today, or null when it is no longer yours to see */
  album: AlbumSummarySchema.nullable(),
  /** why it is null: its curator closed it, or you blocked him */
  gated: z.enum(["private", "blocked"]).nullable().default(null),
})
export type SavedAlbum = z.infer<typeof SavedAlbumSchema>

/** GET /api/albums/mine — the shelves you compiled, and the ones you kept. */
export const AlbumsResponseSchema = z.object({
  albums: z.array(AlbumSummarySchema),
  saved: z.array(SavedAlbumSchema).default([]),
})
export type AlbumsResponse = z.infer<typeof AlbumsResponseSchema>

/** GET /api/albums/:code — the shelf, resolved. */
export const AlbumResponseSchema = z.object({
  album: AlbumSummarySchema,
  entries: z.array(AlbumEntrySchema),
})
export type AlbumResponse = z.infer<typeof AlbumResponseSchema>

/** POST /api/albums */
export const AlbumCreateRequestSchema = z.object({
  title: AlbumTitleSchema,
  description: AlbumDescriptionSchema.nullish().transform((v) => (v && v.trim() ? v.trim() : null)),
  visibility: AlbumVisibilitySchema.default("private"),
})
export type AlbumCreateRequest = z.infer<typeof AlbumCreateRequestSchema>
/** What a CALLER sends — the pre-transform shape, where every key is optional. */
export type AlbumCreateInput = z.input<typeof AlbumCreateRequestSchema>

/**
 * PATCH /api/albums/:code — every owner edit in one door.
 *
 * `order` is the WHOLE anchor list in its new order, not a move instruction: a
 * drag that arrives out of sequence, or twice, then cannot leave the shelf in a
 * state neither side asked for. Anchors it does not name keep their places
 * after the ones it does.
 */
export const AlbumPatchRequestSchema = z.object({
  title: AlbumTitleSchema.optional(),
  description: AlbumDescriptionSchema.nullish().transform((v) => (v === undefined ? undefined : v && v.trim() ? v.trim() : null)),
  visibility: AlbumVisibilitySchema.optional(),
  order: z.array(AlbumAnchorSchema).max(ALBUM_LIMITS.entries).optional(),
})
export type AlbumPatchRequest = z.infer<typeof AlbumPatchRequestSchema>
/**
 * The CALLER's shape — and the reason it is a separate type: `description`'s
 * `nullish().transform()` makes the key REQUIRED on the output side, so a
 * reorder-only PATCH (`{ order }`) does not typecheck against `z.infer`. The
 * client sends the input shape; the server reads the output one.
 */
export type AlbumPatchInput = z.input<typeof AlbumPatchRequestSchema>

/**
 * POST /api/albums/:code/entries — add قصائد and أبيات, each named by what the
 * client can honestly know about it.
 *
 * A بيت is sent as its content hash (`baitAnchor`); a قصيدة as its PUBLIC id,
 * which is true today and is exactly what the poem page has. The SERVER
 * resolves each one against the corpus, derives the قصيدة's durable anchor from
 * its `dedup_key`, and writes the snapshot itself. That is what makes the
 * snapshot trustworthy — a client-supplied «poet» is a client-supplied
 * attribution — and it is why an item the artefact cannot answer is refused
 * rather than stored.
 */
export const AlbumAddItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("poem"), id: PublicPoemIdSchema }),
  z.object({ kind: z.literal("bait"), hFull: BaitAnchorSchema }),
])
export type AlbumAddItem = z.infer<typeof AlbumAddItemSchema>

export const AlbumAddEntriesRequestSchema = z.object({
  items: z.array(AlbumAddItemSchema).min(1).max(ALBUM_LIMITS.bulk),
})
export type AlbumAddEntriesRequest = z.infer<typeof AlbumAddEntriesRequestSchema>

/**
 * What an add answered: the shelf as it now stands, and how many of the sent
 * items actually landed. A second «أضِف القصيدة» is a duplicate, and «هذه
 * القصيدة في الديوان أصلًا» is the only honest thing to say about it.
 */
export const AlbumAddEntriesResponseSchema = z.object({
  album: AlbumSummarySchema,
  added: z.number().int().nonnegative(),
  /** already on the shelf */
  duplicates: z.number().int().nonnegative(),
  /** no copy in today's artefact */
  unresolved: z.number().int().nonnegative(),
})
export type AlbumAddEntriesResponse = z.infer<typeof AlbumAddEntriesResponseSchema>

/** PATCH / DELETE answer with the album (or its absence) — never a bare ok. */
export const AlbumMutationResponseSchema = z.object({ album: AlbumSummarySchema })
export type AlbumMutationResponse = z.infer<typeof AlbumMutationResponseSchema>

export const AlbumDeleteResponseSchema = z.object({ ok: z.literal(true) })
export type AlbumDeleteResponse = z.infer<typeof AlbumDeleteResponseSchema>

/**
 * POST / DELETE /api/albums/:code/save — «أضِف إلى مكتبتك».
 *
 * It answers with the shelf as the viewer now sees it, `saved` and all, so the
 * button's state comes from the same payload that changed it rather than from a
 * second read the client would have to keep in step.
 */
export const AlbumSaveResponseSchema = z.object({
  /** null when the row was removed from a shelf the reader may no longer see */
  album: AlbumSummarySchema.nullable(),
  saved: z.boolean(),
})
export type AlbumSaveResponse = z.infer<typeof AlbumSaveResponseSchema>

/**
 * GET /api/albums/:code/pool — the ديوان as a مساجلة can play it.
 *
 * Four numbers and a list of ids, and the numbers are different truths that
 * the door must not blur:
 *  • `count` — entries on the shelf, what its head already says;
 *  • `resolved` — those today's artefact can still find (a rebuild may have
 *    dropped a قصيدة; the shelf still prints them from its snapshot);
 *  • `baits` — the أبيات those entries amount to: every بيت of every resolved
 *    قصيدة, plus the single أبيات;
 *  • `playable` — those `game_baits` will serve, which is the only number the
 *    duel can honour. 39.8 % of قصائد carry no بحر and the pool admits only
 *    `kind='bahr'`, so a thirty-بيت shelf can easily be a twelve-بيت مساجلة,
 *    and saying «30» over a game built on 12 would be the interface knowing and
 *    not saying.
 *
 * `baitIds` holds ONE id per بيت — the best-ranked playable copy, the same
 * `po.fame DESC, b.position ASC, b.id ASC` order the anchor resolves by — so
 * the opponent's «already said» exclusions cannot be defeated by the corpus
 * holding the same بيت under a second id. It is capped at `ALBUM_LIMITS.pool`
 * in SHELF order, and when `baitIds.length < playable` the door says so: the
 * solo duel carries this list on every request and cannot carry a playlist of
 * long قصائد whole.
 */
export const AlbumPoolResponseSchema = z.object({
  album: AlbumSummarySchema,
  count: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  baits: z.number().int().nonnegative(),
  playable: z.number().int().nonnegative(),
  baitIds: z.array(z.number().int().positive()).max(ALBUM_LIMITS.pool),
})
export type AlbumPoolResponse = z.infer<typeof AlbumPoolResponseSchema>

/** The machine codes an album route can answer with, and their Arabic. */
export const ALBUM_ERRORS: Record<string, string> = {
  album_not_found: "لا ديوان بهذا الرمز",
  album_forbidden: "هذا الديوان ليس لك",
  too_many_albums: "بلغتَ أقصى عدد من الدواوين",
  album_full: "امتلأ هذا الديوان",
  unknown_entry: "لم أجد ذلك في الديوان",
  albums_unavailable: "الدواوين غير متاحة على هذا الخادم",
  cannot_save_own: "هذا ديوانك، وهو في دواوينك أصلًا",
  too_many_saved: "امتلأت مكتبتك",
  album_too_thin: "يحتاج عشرة أبيات صالحة للمساجلة",
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. Accounts, profiles, مساجلة rooms (v2.md §4/§5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A username is a PATH SEGMENT (`#/u/<username>`) and a display handle, so it
 * carries the strictest shape in this file: it must start with a letter or a
 * digit, and may then hold letters, digits, `_`, `.` and `-`. Arabic letters
 * are allowed — this is an Arabic site and «المتنبي» is a better handle than
 * `almutanabbi` for the reader who wants it — but tashkeel marks are not
 * (they are `\p{M}`, not `\p{L}`), because two names that differ only by a
 * fatha are the same name to every eye that reads them.
 *
 * Case-insensitive uniqueness is the database's job (`UNIQUE COLLATE NOCASE`).
 */
export const UsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(24)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u, "username must start with a letter or digit")

/** The name a reader actually sees. Any script, no line breaks. */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\r\n\t]+$/, "display name must be one line")

/** v2.md §4: eight characters, and an upper bound so scrypt cannot be a DoS. */
export const PasswordSchema = z.string().min(8).max(200)

export const InviteCodeSchema = z.string().trim().min(1).max(64)

/** The public shape of an account. No email exists to leak; no id is exposed. */
export const AuthUserSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  joinedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  /**
   * The versioned URL of this account's uploaded avatar, or null when it has
   * none (the client then draws the gold نِيب disc with the initial). The bytes
   * are NEVER in JSON — this is only the address `GET /api/profile/:u/avatar`
   * serves, with a `?v=<etag>` so a replaced picture busts every cache.
   */
  avatar: z.string().nullable(),
})
export type AuthUser = z.infer<typeof AuthUserSchema>

/**
 * The avatar upload cap: 256 KB, enforced off the BYTE STREAM in the route, not
 * merely the `Content-Length` header a chunked request can omit or lie about.
 * A 256×256 webp is a handful of KB; this only ever catches abuse.
 */
export const MAX_AVATAR_BYTES = 256 * 1024

/**
 * The only three raster types a stored avatar may be. The upload is validated
 * by MAGIC BYTES, never the client's `Content-Type` (an SVG — which can carry
 * script — or an HTML page renamed `.png` is rejected 415), and the serve route
 * answers with the STORED mime from exactly this allowlist, never a sniff, so it
 * is impossible to make the server return an uploaded blob as `text/html`.
 */
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const
export type AvatarMime = (typeof AVATAR_MIME_TYPES)[number]

/**
 * The versioned, cache-bustable avatar URL for a user, or null when the account
 * has no picture. One helper so the server DTOs and any client that needs to
 * build the URL agree on its exact shape — `?v=<etag>` is what makes a replaced
 * avatar a different URL, so an `immutable` cache still updates on change.
 */
export function avatarUrlFor(username: string, etag: string | null | undefined): string | null {
  return etag ? `/api/profile/${encodeURIComponent(username)}/avatar?v=${encodeURIComponent(etag)}` : null
}

export const RegisterRequestSchema = z.object({
  username: UsernameSchema,
  /** absent → the username stands in as the display name */
  displayName: DisplayNameSchema.optional(),
  password: PasswordSchema,
  /** only read when the server runs with REQUIRE_INVITE=1 */
  invite: InviteCodeSchema.optional(),
  /**
   * Ask for a bearer token in the response body (docs/roadmap-mobile.md §M1).
   * The Capacitor app sets the `X-Client: capacitor` header instead; either is
   * honoured. Web clients omit it and keep using the cookie unchanged.
   */
  bearer: z.boolean().optional(),
})
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>

/**
 * Login is deliberately LAX where registration is strict: an account created
 * before a rule tightened must still be able to log in, and the answer to a
 * malformed username is «الاسم أو كلمة السر غير صحيحة», not a 400 that tells
 * an attacker which half of the form was wrong.
 */
export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
  /** ask for a bearer token in the body (see RegisterRequestSchema.bearer) */
  bearer: z.boolean().optional(),
})
export type LoginRequest = z.infer<typeof LoginRequestSchema>

/**
 * Change the signed-in account's password (docs/roadmap-mobile.md §M1).
 *
 * The reason this route exists at all is the revoke requirement: a password
 * change must invalidate EVERY session — cookie and bearer alike — so there has
 * to be a route that changes the password. `oldPassword` is verified so a
 * ridden cookie cannot silently re-key the account out from under its owner.
 */
export const PasswordChangeRequestSchema = z.object({
  oldPassword: z.string().min(1).max(200),
  newPassword: PasswordSchema,
  /** re-issue the current device as a bearer token (see the flag above) */
  bearer: z.boolean().optional(),
})
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>

/**
 * The login/register/password response. `token` is present ONLY when the client
 * asked for a bearer session and the origin is secure (https or localhost); web
 * clients never see it and read the cookie instead. It appears here, in a body,
 * and NOWHERE else — never a URL, a log line, or an error message.
 *
 * `recoveryCode` is the once-shown, no-email account-recovery code: present on
 * REGISTER and on a RESET (where the used code is rotated), never on a plain
 * login. Like `token`, it is a secret that lives only in this body — the server
 * keeps nothing but its scrypt hash — so the client must show it to the reader
 * immediately and store nothing.
 */
export const AuthSessionResponseSchema = z.object({
  user: AuthUserSchema,
  token: z.string().optional(),
  recoveryCode: z.string().optional(),
})
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>

/**
 * Reset a forgotten password with the once-shown recovery code — unauthenticated
 * (docs, Play launch). The username is LAX like login (the answer to a malformed
 * one is the same «رمز أو اسم غير صحيح», never a 400 that says which half was
 * wrong); the code is lax too and canonicalized server-side, so its exact shape
 * is not an oracle; the new password is strict (≥8), the one field a reader is
 * choosing fresh. On success every session is revoked and a NEW code is issued.
 */
export const PasswordResetRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  recoveryCode: z.string().trim().min(1).max(64),
  newPassword: PasswordSchema,
  /** ask for a bearer token in the body (see RegisterRequestSchema.bearer) */
  bearer: z.boolean().optional(),
})
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>

/**
 * `POST /api/auth/recovery` — a signed-in reader regenerates their recovery code
 * (the signup one may be lost). The old code is invalidated and the new one is
 * shown ONCE; the server stores only its hash, so this body is the only place
 * the plaintext ever exists.
 */
export const RecoveryRegenerateResponseSchema = z.object({
  recoveryCode: z.string(),
})
export type RecoveryRegenerateResponse = z.infer<typeof RecoveryRegenerateResponseSchema>

/**
 * `GET /api/auth/me` — always 200, `user: null` when nobody is signed in.
 *
 * A 401 here would be a lie: "who am I" was answered. It also keeps the
 * masthead's boot request out of the smoke run's failure list. `requiresInvite`
 * is what the dialog reads to decide whether to show the رمز الدعوة field, and
 * `available` is false when this deployment has no writable users database at
 * all (v2.md §4: log + 503, never crash).
 */
export const AuthMeResponseSchema = z.object({
  user: AuthUserSchema.nullable(),
  requiresInvite: z.boolean().default(false),
  available: z.boolean().default(true),
})
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>

export const AuthLogoutResponseSchema = z.object({ ok: z.literal(true) })
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponseSchema>

/** Duel record, read off `rooms`/`match_turns` — zeros until §5 lands. */
export const DuelStatsSchema = z.object({
  matches: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  /** accepted أبيات recited across every مساجلة */
  turns: z.number().int().nonnegative(),
  /** longest run of accepted turns inside one room */
  bestChain: z.number().int().nonnegative(),
})
export type DuelStats = z.infer<typeof DuelStatsSchema>

export const MatchResultSchema = z.enum(["win", "loss", "open"])
export const RoomStatusSchema = z.enum(["waiting", "active", "done"])
export const RoomModeSchema = z.enum(["rhyme", "literal"])

export const ProfileMatchSchema = z.object({
  /**
   * The room code — and NULL to anyone but the account's owner.
   *
   * A profile page needs no cookie, and a room code is the credential that
   * names a room: publishing every code a user hosts, `waiting` ones included,
   * handed an unauthenticated scraper the live invite of every مساجلة the site
   * opened. Usernames are enumerable, so the whole table was scrapable. The
   * record — who, when, won or lost — is public; the way IN is not.
   */
  code: z.string().nullable(),
  status: RoomStatusSchema,
  /** the other player's display name, null while a room is still waiting */
  opponent: z.string().nullable(),
  result: MatchResultSchema,
  turns: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
})
export type ProfileMatch = z.infer<typeof ProfileMatchSchema>

/** The opt-in ترسانة snapshot, exactly the local slice's shape. */
export const ArsenalSnapshotSchema = z.object({
  letters: ArsenalSchema,
  updatedAt: z.number().int().nonnegative(),
})
export type ArsenalSnapshot = z.infer<typeof ArsenalSnapshotSchema>

export const ProfileResponseSchema = z.object({
  user: AuthUserSchema,
  /** true when the signed-in reader is looking at their own page */
  isSelf: z.boolean(),
  stats: DuelStatsSchema,
  recent: z.array(ProfileMatchSchema),
  arsenal: ArsenalSnapshotSchema.nullable(),
  /**
   * Whether the SIGNED-IN reader has blocked this account (v2.md Track 3). It is
   * a fact about the viewer, not the profile — false for a signed-out reader and
   * on your own page — so it never tells the blocked user they were blocked
   * (blocking is private); it only lets the «احظر» button render as «ألغِ الحظر»
   * when you are looking at someone you already blocked.
   */
  youBlocked: z.boolean().default(false),
  /**
   * This account's PUBLIC دواوين — «دواوينه» (see §الدواوين above).
   *
   * Only `public` shelves are ever in it, and making a ديوان public IS the
   * publish gesture: an `unlisted` one is reachable by its link and is
   * deliberately absent here, because listing it would hand out the very
   * capability its owner chose not to publish. A signed-out reader sees the
   * same list — published is published. What DOES empty it is a block in either
   * direction (Track 3): a shelf is a person speaking, and a blocked person does
   * not speak on the blocker's screen.
   */
  albums: z.array(AlbumSummarySchema).default([]),
})
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>

export const ProfileUpdateRequestSchema = z.object({ displayName: DisplayNameSchema })
export type ProfileUpdateRequest = z.infer<typeof ProfileUpdateRequestSchema>

/**
 * Delete the signed-in account — IRREVERSIBLE (a Google Play requirement for any
 * app with accounts).
 *
 * The password is re-entered as confirmation and verified with scrypt +
 * `timingSafeEqual`, exactly like login and the password change: a ridden cookie
 * or a walked-away session must not be able to erase the account. `password` is
 * lax (min 1) like every other VERIFY field — the answer to a wrong one is
 * «كلمة السر غير صحيحة», never a 400 that says which half was wrong.
 */
export const AccountDeleteRequestSchema = z.object({
  password: z.string().min(1).max(200),
})
export type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>

/** `POST /api/profile/delete` → the account and every trace of it are gone. */
export const AccountDeleteResponseSchema = z.object({ ok: z.literal(true) })
export type AccountDeleteResponse = z.infer<typeof AccountDeleteResponseSchema>

/**
 * The answer to `POST`/`DELETE /api/profile/avatar` — the new versioned avatar
 * URL, or null after a delete (the client reverts to the نِيب disc). The bytes
 * never travel in JSON; this is only the address the picture is served from.
 */
export const AvatarMutationResponseSchema = z.object({
  ok: z.literal(true),
  avatar: z.string().nullable(),
})
export type AvatarMutationResponse = z.infer<typeof AvatarMutationResponseSchema>

export const ArsenalSyncRequestSchema = z.object({ arsenal: ArsenalSchema })
export type ArsenalSyncRequest = z.infer<typeof ArsenalSyncRequestSchema>

export const ArsenalSyncResponseSchema = z.object({
  ok: z.literal(true),
  arsenal: ArsenalSnapshotSchema.nullable(),
})
export type ArsenalSyncResponse = z.infer<typeof ArsenalSyncResponseSchema>

/** v2.md §4: the stored snapshot is capped at 8 KB of JSON. */
export const MAX_ARSENAL_BYTES = 8 * 1024

/** How many recent مساجلات a profile page lists (every new list is paginated). */
export const PROFILE_MATCHES_LIMIT = 10

// ═══════════════════════════════════════════════════════════════════════════
// 12.5 UGC moderation — report, block, and the owner's admin routes (Track 3)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Why one player is reporting another. A closed enum, not free text: the note is
 * where anything specific goes, and a fixed set is what lets the owner triage a
 * queue at a glance. The Arabic labels live in the client (`REPORT_REASONS`);
 * these machine values are what the wire and the database carry.
 */
export const ReportReasonSchema = z.enum([
  "harassment", // مضايقة / إساءة
  "hate", // كراهية / تحقير
  "spam", // إغراق / دعاية
  "impersonation", // انتحال شخصية
  "inappropriate", // اسم أو صورة غير لائقة
  "other", // غير ذلك
])
export type ReportReason = z.infer<typeof ReportReasonSchema>

/**
 * POST /api/report — a logged-in reader reports another account (Track 3).
 *
 * `targetUsername` is strict (`UsernameSchema`): a report names a real account,
 * and the client always has the exact handle in hand. `note` is optional free
 * text the reader adds; `context` is a short breadcrumb the client sets so the
 * owner knows WHERE the report came from — «الملف» from a profile page, the room
 * code from a مساجلة — and is never trusted for anything but display.
 */
export const ReportRequestSchema = z
  .object({
    targetUsername: UsernameSchema.optional(),
    /**
     * A ديوان, when what is being reported is the SHELF rather than the account:
     * its اسم and وصف are the reader's own words on a page carrying his name, so
     * they are UGC like a display name is. The server derives the reported
     * ACCOUNT from the shelf's owner and does not trust `targetUsername` beside
     * it — a client that could name a different target would be able to file a
     * report against anybody in someone else's name.
     */
    albumCode: AlbumCodeSchema.optional(),
    reason: ReportReasonSchema,
    note: z.string().trim().max(1000).optional(),
    context: z.string().trim().max(80).optional(),
  })
  .refine((v) => v.targetUsername !== undefined || v.albumCode !== undefined, {
    message: "a report names an account or a ديوان",
  })
export type ReportRequest = z.infer<typeof ReportRequestSchema>

export const ReportResponseSchema = z.object({ ok: z.literal(true) })
export type ReportResponse = z.infer<typeof ReportResponseSchema>

/** POST /api/block and DELETE /api/block — block or unblock one account. */
export const BlockRequestSchema = z.object({ username: UsernameSchema })
export type BlockRequest = z.infer<typeof BlockRequestSchema>

/** One account on YOUR block list — enough to render the row and unblock it. */
export const BlockedUserSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  avatar: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
})
export type BlockedUser = z.infer<typeof BlockedUserSchema>

/** GET /api/block — the signed-in reader's own block list (private to them). */
export const BlocksResponseSchema = z.object({ blocks: z.array(BlockedUserSchema) })
export type BlocksResponse = z.infer<typeof BlocksResponseSchema>

/** POST/DELETE /api/block → the block list as it now stands. */
export const BlockMutationResponseSchema = z.object({ ok: z.literal(true), blocks: z.array(BlockedUserSchema) })
export type BlockMutationResponse = z.infer<typeof BlockMutationResponseSchema>

/**
 * The safe placeholder an admin resets an offensive display name to. It is a
 * legal `DisplayNameSchema` value (min 1) and says nothing about the account —
 * «لاعب» is a neutral noun, not «محظور» or «مُبلَّغ عنه», which would leak the
 * moderation action to everyone who reads the page.
 */
export const PLACEHOLDER_DISPLAY_NAME = "لاعب"

/** One report as the owner's admin queue shows it. */
export const AdminReportSchema = z.object({
  id: z.number().int().positive(),
  reporter: z.string().nullable(),
  target: z.string().nullable(),
  reason: ReportReasonSchema,
  note: z.string().nullable(),
  context: z.string().nullable(),
  status: z.enum(["open", "resolved"]),
  createdAt: z.number().int().nonnegative(),
  /** whether the target account still has an avatar / a suspension in force */
  targetHasAvatar: z.boolean(),
  targetSuspendedUntil: z.number().int().nonnegative(),
  /**
   * The ديوان this report is about, when it is about one — the code the two
   * album actions take, plus enough of it (اسم, وصف, من يراه) for the owner to
   * judge without opening the shelf. Null for a report about an account.
   */
  album: z
    .object({
      code: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      visibility: AlbumVisibilitySchema,
    })
    .nullable()
    .default(null),
})
export type AdminReport = z.infer<typeof AdminReportSchema>

export const AdminReportsResponseSchema = z.object({ reports: z.array(AdminReportSchema) })
export type AdminReportsResponse = z.infer<typeof AdminReportsResponseSchema>

/** Every admin action that targets one account by name. */
export const AdminActionRequestSchema = z.object({
  username: UsernameSchema,
  /** suspend only: how many days (1..365); absent → the default window */
  days: z.number().int().min(1).max(365).optional(),
})
export type AdminActionRequest = z.infer<typeof AdminActionRequestSchema>

/**
 * Every admin action that targets one ديوان by its code.
 *
 * The two the allowlist gained are the two a reported shelf actually needs, and
 * neither of them destroys the reader's collection: «أخفِه» takes a public or
 * unlisted ديوان back to `private` (the أبيات and the order are untouched — it
 * simply stops being a page other people can open), and «امحُ الوصف» clears the
 * one free-text field. Deleting somebody's ديوان is not on the list: an
 * offensive وصف is a وصف, and the أبيات under it are the corpus's own.
 */
export const AdminAlbumActionRequestSchema = z.object({ code: AlbumCodeSchema })
export type AdminAlbumActionRequest = z.infer<typeof AdminAlbumActionRequestSchema>

export const AdminResolveRequestSchema = z.object({ id: z.number().int().positive() })
export type AdminResolveRequest = z.infer<typeof AdminResolveRequestSchema>

export const AdminActionResponseSchema = z.object({ ok: z.literal(true) })
export type AdminActionResponse = z.infer<typeof AdminActionResponseSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 13. مساجلة rooms — 1v1 over the wire (v2.md §5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The room code is SPEAKABLE, because the first thing that happens to it is
 * that someone reads it down a phone or types it from a photograph of a
 * screen: three consonant+vowel pairs, six letters, one syllable each
 * («BADIRU», «KOSEMA»). No digits at all — «0/O» and «1/I» are the two
 * mistakes a shared code actually collects — and it is matched
 * case-insensitively both here and in SQLite (`UNIQUE COLLATE NOCASE`).
 */
export const ROOM_CODE_LENGTH = 6
export const RoomCodeSchema = z
  .string()
  .trim()
  .length(ROOM_CODE_LENGTH)
  .regex(/^[A-Za-z]{6}$/, "room code is six letters")
  .transform((s) => s.toUpperCase())

/** Where you stand in a room. A spectator is anyone else who opened the link. */
export const RoomRoleSchema = z.enum(["host", "guest", "spectator"])
export type RoomRole = z.infer<typeof RoomRoleSchema>

/** The two seats. A turn belongs to one of them; a spectator has none. */
export const RoomSeatSchema = z.enum(["host", "guest"])
export type RoomSeat = z.infer<typeof RoomSeatSchema>

/**
 * How a مساجلة stopped. `strikes` and `timeout` are the two v2.md §5 names;
 * `resign` is «انسحب», and `abandoned` is reserved for a room the server
 * closes without a winner.
 */
export const RoomEndReasonSchema = z.enum(["strikes", "timeout", "resign", "abandoned"])
export type RoomEndReason = z.infer<typeof RoomEndReasonSchema>

/**
 * What the transcript stores per row. `opening` is the host's starting بيت —
 * it is a بيت in the room but not a بيت he ANSWERED with, which is why it is
 * its own tag and not `ok` (`duelStats` counts only `ok`, server/users.ts).
 *
 * The only two rejections that become rows are the two v2.md §5 calls a
 * strike. Everything else the verifier can say — «وجدتُ أكثر من بيت», «البيت
 * شطران», «أهذا ما أردت؟», «قيل هذا البيت» — is feedback to the player who
 * typed it, changes nothing about the room, and is never written down.
 */
export const RoomTurnVerdictSchema = z.enum(["opening", "ok", "wrong_letter", "not_found"])
export type RoomTurnVerdict = z.infer<typeof RoomTurnVerdictSchema>

/** v2.md §5: «wrong-letter/not-found = strike». Everything else is soft. */
export const ROOM_STRIKE_REASONS = ["wrong_letter", "not_found"] as const

/** v2.md §5: the server-clocked turn, or no clock at all. */
export const ROOM_TIMERS = [30, 60, 90] as const
export const RoomTimerSchema = z.union([z.literal(30), z.literal(60), z.literal(90)])

/** v2.md §5: «configurable strikes 1–3 at creation». */
export const ROOM_STRIKES_MIN = 1
export const ROOM_STRIKES_MAX = 3
export const ROOM_STRIKES_DEFAULT = 3

/** The longest a room's transcript may grow before the server calls it a draw. */
export const MAX_ROOM_TURNS = 400

/**
 * KNOCK-TO-JOIN (owner's «أملِ عليه الرمز», restored securely).
 *
 * The keyed link is still the instant door: a guest who opens `#/room/<code>?k=`
 * joins with «ادخل المساجلة» and no knock. But a logged-in guest who reaches a
 * room by VOICE — the six spoken letters, no key — has no credential for the
 * seat, and the old dead-end («هذه الغرفة بدعوة») made dictating the code a lie.
 * So he KNOCKS: a pending request the host sees in the snapshot and accepts or
 * rejects. A knocker is not a player until accepted — he never reads the
 * transcript, only these four states.
 *
 *  • `none`      — this reader has no live knock on this room
 *  • `pending`   — he knocked, the host has not answered
 *  • `accepted`  — the host let him in; he is now the guest and reads the room
 *  • `rejected`  — the host refused, or closed the room out from under him
 */
export const RoomKnockStatusSchema = z.enum(["none", "pending", "accepted", "rejected"])
export type RoomKnockStatus = z.infer<typeof RoomKnockStatusSchema>

/**
 * The pending knocker, as the HOST sees him in the room snapshot — a name and
 * nothing more, because a knock is a request for a seat, not a seat. It rides in
 * `snapshot()` so the host learns of it over the socket AND the poller, and it
 * is null for everyone who is not the host (a spectator does not vet the door).
 */
export const RoomKnockerSchema = z.object({
  username: z.string(),
  displayName: z.string(),
})
export type RoomKnocker = z.infer<typeof RoomKnockerSchema>

/**
 * What the KNOCKER himself is told — the minimal view that does NOT leak the
 * room. `POST /:code/knock` and `GET /:code/knock` answer with this and never a
 * `RoomState`: an unaccepted knocker is behind the same join_key gate a
 * key-less spectator is, so he gets his own status, the code he is waiting on,
 * and the host's name — never the transcript. On `accepted` the client re-opens
 * the room the ordinary way, because his user id is now on the seat.
 */
export const RoomKnockViewSchema = z.object({
  status: RoomKnockStatusSchema,
  code: z.string(),
  hostName: z.string().nullable(),
})
export type RoomKnockView = z.infer<typeof RoomKnockViewSchema>

export const RoomKnockResponseSchema = z.object({ knock: RoomKnockViewSchema })
export type RoomKnockResponse = z.infer<typeof RoomKnockResponseSchema>

/**
 * The WebSocket subprotocol scheme that carries a bearer on the UPGRADE.
 *
 * A browser (or a WebView) cannot set `Authorization` on a WebSocket handshake,
 * but the constructor's `protocols` argument becomes the `Sec-WebSocket-Protocol`
 * request header — the one thing it CAN set. So the native shell offers
 * `qarid.bearer.<token>` as its subprotocol, the server reads the token off it
 * (docs/roadmap-mobile.md), and the `ws` server echoes the value back on the 101
 * so the handshake completes. This is ADDITIVE: the cookie path (web) and the
 * `Authorization` header path are unchanged and still tried, in that order.
 */
export const ROOM_WS_BEARER_PREFIX = "qarid.bearer."

/** A seat, as the other side sees it. `strikes` is derived from the turns. */
export const RoomPlayerSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  /** the versioned avatar URL, or null → the seat draws the نِيب disc */
  avatar: z.string().nullable(),
  seat: RoomSeatSchema,
  /** strikes SPENT (0..room.strikes) */
  strikes: z.number().int().nonnegative(),
  /** أبيات accepted from this player in this room */
  turns: z.number().int().nonnegative(),
  /** a live socket is open for this player right now */
  connected: z.boolean(),
})
export type RoomPlayer = z.infer<typeof RoomPlayerSchema>

/** One line of the transcript. `bait` is null only for a strike. */
export const RoomTurnSchema = z.object({
  turnNo: z.number().int().nonnegative(),
  seat: RoomSeatSchema,
  username: z.string().nullable(),
  verdict: RoomTurnVerdictSchema,
  bait: BaitDtoSchema.nullable(),
  /** what the player actually typed — kept for a strike, which has no بيت */
  text: z.string().nullable(),
  playedAt: z.number().int().nonnegative(),
  msTaken: z.number().int().nonnegative().nullable(),
})
export type RoomTurn = z.infer<typeof RoomTurnSchema>

/**
 * THE snapshot. Every event carries one, so a client that has just
 * reconnected, a client that has been watching all along and a client polling
 * `GET /api/room/:code/state` are all looking at exactly the same thing —
 * which is what makes reconnection free rather than a merge.
 *
 * `serverNow` is the clock the countdown is drawn from: `deadlineAt` is a
 * server timestamp, and a browser whose clock is four minutes fast would
 * otherwise render a turn as already lost. The client keeps the offset.
 */
export const RoomStateSchema = z.object({
  code: z.string(),
  status: RoomStatusSchema,
  mode: RoomModeSchema,
  timerS: z.number().int().positive().nullable(),
  strikes: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable(),
  endedAt: z.number().int().nonnegative().nullable(),
  host: RoomPlayerSchema.nullable(),
  guest: RoomPlayerSchema.nullable(),
  /** who YOU are in this room, and what you may do in it */
  you: z.object({
    username: z.string().nullable(),
    role: RoomRoleSchema,
    seat: RoomSeatSchema.nullable(),
    /** the room is waiting and this seat is open to you */
    canJoin: z.boolean(),
    /** it is your turn AND the room is active */
    canPlay: z.boolean(),
  }),
  turns: z.array(RoomTurnSchema),
  /** the seat that owes a بيت, null when the room is not active */
  turnSeat: RoomSeatSchema.nullable(),
  /** the chain state the next answer must satisfy */
  required: ChainStateSchema.nullable(),
  deadlineAt: z.number().int().nonnegative().nullable(),
  serverNow: z.number().int().nonnegative(),
  winner: z.string().nullable(),
  endReason: RoomEndReasonSchema.nullable(),
  /** the room «رجعة» opened, once someone pressed it */
  rematchCode: z.string().nullable(),
  /**
   * The invite key — present ONLY for the two players (server/rooms.ts
   * `newJoinKey`). It is what `POST /:code/join` checks before it hands out
   * the empty seat, and it rides in `shareUrl`; a spectator's snapshot carries
   * null and a link with no key in it.
   */
  joinKey: z.string().nullable(),
  spectators: z.number().int().nonnegative(),
  /** the absolute link to hand a friend (PUBLIC_ORIGIN + `#/room/<code>`) */
  shareUrl: z.string(),
  /**
   * The guest waiting at the door — present ONLY in the host's own snapshot,
   * and only while a room is `waiting` with a pending knock (see
   * `RoomKnockerSchema`). Null for a spectator, for the knocker, and whenever
   * nobody is knocking.
   */
  knock: RoomKnockerSchema.nullable(),
  /**
   * Somebody has this room OPEN and has not entered it — present ONLY in the
   * host's own snapshot, and only while the room is `waiting`.
   *
   * The knock path already surfaced a guest who arrived by voice («الضيف يطرق
   * الباب»), but the KEYED link — the normal path, the one «انسخ الرابط» hands
   * over — was silent: the guest saw a lobby («دُعيتَ إلى مساجلة… ادخل حين
   * تكون مستعدًّا») while the host still read «بانتظار خصم» and «تبدأ المساجلة
   * لحظة دخوله», which stopped being true the moment entering became a button.
   * Both sides then sat waiting for the other.
   *
   * It is derived from the socket hub, not from a row: a keyed guest holds a
   * socket from the moment the lobby paints (`roomStore.open` connects before
   * any join), so «is anyone on the other end of the link» is exactly what the
   * hub already knows. It is presence, so it is allowed to be approximate —
   * it says «someone is at the door», never who.
   */
  atDoor: z.boolean().default(false),
  /**
   * The ديوان this مساجلة is played INSIDE, or null for an ordinary room.
   *
   * A ديوان room is the memorization contest: the opening بيت comes off the
   * shelf and BOTH players must answer with أبيات that are on it, checked
   * server-side by the same anchor the shelf is built on (`baitAnchor` over the
   * MATCHED بيت, never an id — CLAUDE.md's «CANON ANCHORS BY CONTENT»). It is
   * on the snapshot rather than derived because every screen in the room has to
   * name it: the lobby, the HUD, the refusal card and the ending.
   *
   * It goes null if the curator deletes the shelf mid-match (`ON DELETE SET
   * NULL`), and the room then finishes as an ordinary مساجلة — the honest
   * outcome, since the constraint it was played under no longer exists.
   */
  album: z.object({ code: AlbumCodeSchema, title: z.string() }).nullable().default(null),
})
export type RoomState = z.infer<typeof RoomStateSchema>

/**
 * POST /api/room — the host's five decisions.
 *
 * `baitId` absent means «عشوائي»: the server picks from the شاعر tier, which
 * is `fame >= 2 AND position <= 12` (v2.md §5's «fame≥2 default», with the
 * position cap that keeps it out of بيت ٣٠٠ of a 500-بيت ديوان).
 */
export const CreateRoomRequestSchema = z.object({
  baitId: z.number().int().positive().nullish().transform((v) => v ?? undefined),
  /**
   * «ضدّ صديق في هذا الديوان» — the shelf both players are confined to.
   *
   * The host sends the CODE and nothing else about the ديوان: the server opens
   * it under the same read gate `GET /api/albums/:code` uses, counts its
   * playable أبيات, refuses below `ALBUM_LIMITS.playableFloor`, and takes the
   * opening بيت off the shelf itself — so `baitId` is not accepted beside it.
   */
  albumCode: AlbumCodeSchema.nullish().transform((v) => v ?? undefined),
  mode: RoomModeSchema.default("rhyme"),
  timerS: RoomTimerSchema.nullish().transform((v) => v ?? undefined),
  strikes: z.number().int().min(ROOM_STRIKES_MIN).max(ROOM_STRIKES_MAX).default(ROOM_STRIKES_DEFAULT),
})
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>

/**
 * GET /api/room/opening — «عشوائي» on the create dialog.
 *
 * A room's opening بيت must be PLAYABLE (`game_baits`: it has a عجز and a روي
 * to chain on), and `/api/baits/random` promises no such thing — so the host's
 * dice are thrown by the same picker that would have thrown them server-side
 * had he not asked to see it first.
 */
export const RoomOpeningResponseSchema = z.object({ bait: BaitDtoSchema })
export type RoomOpeningResponse = z.infer<typeof RoomOpeningResponseSchema>

/**
 * GET /api/room/playable?ids=… — which of these أبيات may OPEN a مساجلة.
 *
 * The host picks his مطلع out of `/api/search`, which searches the whole
 * ديوان — including the 1.66M أبيات the game pool excludes (no عجز, or a قصيدة
 * the pool drops). Offering one of those and then refusing it at creation is
 * the shape of bug where the interface knew and did not say, so the picker asks
 * first and simply does not offer what it cannot use.
 */
export const RoomPlayableQuerySchema = z.object({
  ids: z
    .string()
    .max(400)
    .transform((raw) =>
      raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 20),
    ),
})
export const RoomPlayableResponseSchema = z.object({ ids: z.array(z.number().int().positive()) })
export type RoomPlayableResponse = z.infer<typeof RoomPlayableResponseSchema>

/**
 * POST /api/room/:code/join — the invite, out of `#/room/<CODE>?k=…`.
 *
 * Optional, because a رجعة's named guest needs none: his seat carries his user
 * id, which is a stronger claim than any link.
 */
export const RoomJoinRequestSchema = z.object({
  key: z.string().max(64).nullish().transform((v) => v ?? undefined),
})
export type RoomJoinRequest = z.infer<typeof RoomJoinRequestSchema>

/** POST /api/room/:code/turn — the same 600 characters `/api/game/verify` takes. */
export const RoomTurnRequestSchema = z.object({ text: z.string().min(1).max(600) })
export type RoomTurnRequest = z.infer<typeof RoomTurnRequestSchema>

/** Every room route answers with the whole snapshot; there is no partial reply. */
export const RoomStateResponseSchema = z.object({ state: RoomStateSchema })
export type RoomStateResponse = z.infer<typeof RoomStateResponseSchema>

/**
 * What the verifier said about ONE submitted بيت, for the player who typed it.
 *
 * `result` is the SAME `GameVerifyResponse` the solo duel renders — one verify
 * pipeline, one set of rejection tags, one `RejectionCard` (v2.md §5:
 * «through THE SAME verify pipeline»). `strike` and `strikesLeft` are the room's
 * own accounting on top of it.
 */
export const RoomVerdictSchema = z.object({
  result: GameVerifyResponseSchema,
  strike: z.boolean(),
  strikesLeft: z.number().int().nonnegative(),
})
export type RoomVerdict = z.infer<typeof RoomVerdictSchema>

/** POST /api/room/:code/turn → the verdict AND the room it produced. */
export const RoomTurnResponseSchema = z.object({ verdict: RoomVerdictSchema, state: RoomStateSchema })
export type RoomTurnResponse = z.infer<typeof RoomTurnResponseSchema>

/**
 * The WebSocket vocabulary (v2.md §5: join/state/turn/verdict/timeout/end/
 * rematch). Every server event carries the full `state`, so no client ever has
 * to apply a delta — the transport is a notification that the snapshot moved,
 * not a stream the client has to fold.
 */
export const RoomEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: RoomStateSchema }),
  z.object({ type: z.literal("join"), state: RoomStateSchema, username: z.string() }),
  z.object({
    type: z.literal("turn"),
    state: RoomStateSchema,
    username: z.string().nullable(),
    verdict: RoomTurnVerdictSchema,
  }),
  /** private: only the socket that submitted sees why its بيت was refused */
  z.object({ type: z.literal("verdict"), state: RoomStateSchema, verdict: RoomVerdictSchema }),
  z.object({ type: z.literal("timeout"), state: RoomStateSchema, username: z.string().nullable() }),
  z.object({ type: z.literal("end"), state: RoomStateSchema }),
  z.object({ type: z.literal("rematch"), state: RoomStateSchema, code: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
])
export type RoomEvent = z.infer<typeof RoomEventSchema>

/** client → server. Everything else the room does is an ordinary POST. */
export const RoomCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), text: z.string().min(1).max(600) }),
  z.object({ type: z.literal("state") }),
  z.object({ type: z.literal("ping") }),
])
export type RoomCommand = z.infer<typeof RoomCommandSchema>

/** The machine codes a room route can answer with, and their Arabic. */
export const ROOM_ERRORS: Record<string, string> = {
  room_not_found: "لا غرفة بهذا الرمز",
  room_full: "الغرفة مكتملة",
  room_not_active: "لم تبدأ المساجلة بعد، أو قد انتهت",
  not_your_turn: "ليس دورك",
  spectator: "أنت مشاهد في هذه الغرفة",
  not_a_player: "لستَ من لاعبي هذه الغرفة",
  unauthenticated: "ادخل بحسابك أوّلًا",
  bad_bait: "هذا البيت لا يصلح مطلعًا للمساجلة",
  no_bait: "لم أجد بيتًا صالحًا للبدء",
  rooms_unavailable: "المساجلة مع الأصدقاء غير متاحة على هذا الخادم",
  too_fast: "على رِسْلك",
  needs_key: "هذه الغرفة تُدخَل برابط الدعوة — اطلبه ممّن فتحها",
  too_many_sockets: "فُتحت هذه الغرفة في نوافذ كثيرة",
  not_the_host: "لا يأذن بالدخول إلا صاحب الغرفة",
  no_knock: "لا أحد ينتظر الإذن على الباب",
  cannot_knock: "لا يمكنك الطرق على هذه الغرفة",
  room_busy: "على الباب طارقٌ قبلك — انتظر حتى يُبتّ أمره",
  knock_rejected: "لم يأذن لك صاحب الغرفة بالدخول",
  // A block stands between these two accounts (Track 3). Deliberately vague — it
  // never says WHO blocked WHOM, so a blocked player cannot confirm the block by
  // probing a room. It reads to either side as an ordinary «this door is shut».
  blocked: "تعذّر الدخول إلى هذه الغرفة",
  // «ضدّ صديق في هذا الديوان» over a shelf the reader cannot open, or one too
  // thin to chain in. Both are about the ديوان, not about the room.
  album_not_found: "لا ديوان بهذا الرمز",
  album_too_thin: "يحتاج عشرة أبيات صالحة للمساجلة",
}
