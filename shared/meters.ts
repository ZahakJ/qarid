/**
 * البحور — the 16 canonical metres of الخليل, the handful of non-عمودي forms
 * the corpus files under `poem meter`, and the normaliser that maps all 101
 * distinct raw strings onto them.
 *
 * `data/profile.json` is the authority on the raw vocabulary and
 * `meters.test.ts` is exhaustive over it: every one of the 101 non-null values
 * must resolve, and `kind:'unknown'` is allowed for exactly three of them
 * (عموديه, عدة أبحر, عامي — see UNKNOWN_BY_DESIGN). design-server.md §6's build
 * asserts zero unmapped metres at ingest end, and this is what makes that
 * assertion hold.
 */

import { cleanText, normalizeArabic } from "./arabic.ts"

export type MeterKind = "bahr" | "free" | "prose" | "muwashah" | "folk" | "unknown"

export interface MeterRow {
  /** ASCII, URL-safe — hash routes and API params carry this, never the name. */
  slug: string
  /** The Arabic name, with its ال. `meters.name` in the schema. */
  name: string
  /** التفعيلات of one شطر, space-separated. `null` for the non-عمودي forms. */
  tafila: string | null
  /** مفتاح البحر — the mnemonic بيت that scans as its own metre. */
  miftah: string | null
  sort: number
  kind: MeterKind
}

export interface NormalizedMeter {
  /** `null` when the raw value names no metre we model. */
  meterSlug: string | null
  /** مجزوء / مشطور / منهوك / مخلع / أحذ / مربع / مقطوع / تفعيلة / خبب. */
  variant: string | null
  kind: MeterKind
  /**
   * `'عامي'` when the raw metre value was itself a dialect marker rather than a
   * metre — design-server.md §3 says that case sets `poems.lang_type`.
   */
  langHint: "عامي" | null
}

// ─────────────────────────────────────────────────────────────────────────────
// The table
// ─────────────────────────────────────────────────────────────────────────────

/** البحور الستة عشر, in الخليل's traditional دوائر order. */
export const BUHUR: readonly MeterRow[] = [
  {
    slug: "tawil", name: "الطويل", tafila: "فعولن مفاعيلن فعولن مفاعلن", sort: 1, kind: "bahr",
    miftah: "طَويلٌ لَهُ دونَ البُحورِ فَضائِلُ · فَعولُنْ مَفاعيلُنْ فَعولُنْ مَفاعِلُنْ",
  },
  {
    slug: "madid", name: "المديد", tafila: "فاعلاتن فاعلن فاعلاتن", sort: 2, kind: "bahr",
    miftah: "لِمَديدِ الشِّعرِ عِندي صِفاتُ · فاعِلاتُنْ فاعِلُنْ فاعِلاتُنْ",
  },
  {
    slug: "basit", name: "البسيط", tafila: "مستفعلن فاعلن مستفعلن فعلن", sort: 3, kind: "bahr",
    miftah: "إِنَّ البَسيطَ لَدَيهِ يُبسَطُ الأَمَلُ · مُستَفعِلُنْ فاعِلُنْ مُستَفعِلُنْ فَعِلُنْ",
  },
  {
    slug: "wafir", name: "الوافر", tafila: "مفاعلتن مفاعلتن فعولن", sort: 4, kind: "bahr",
    miftah: "بُحورُ الشِّعرِ وافِرُها جَميلُ · مُفاعَلَتُنْ مُفاعَلَتُنْ فَعولُنْ",
  },
  {
    slug: "kamil", name: "الكامل", tafila: "متفاعلن متفاعلن متفاعلن", sort: 5, kind: "bahr",
    miftah: "كَمُلَ الجَمالُ مِنَ البُحورِ الكامِلُ · مُتَفاعِلُنْ مُتَفاعِلُنْ مُتَفاعِلُنْ",
  },
  {
    slug: "hazaj", name: "الهزج", tafila: "مفاعيلن مفاعيلن", sort: 6, kind: "bahr",
    miftah: "عَلى الأَهزاجِ تَسهيلُ · مَفاعيلُنْ مَفاعيلُنْ",
  },
  {
    slug: "rajaz", name: "الرجز", tafila: "مستفعلن مستفعلن مستفعلن", sort: 7, kind: "bahr",
    miftah: "في أَبحُرِ الأَرجازِ بَحرٌ يَسهُلُ · مُستَفعِلُنْ مُستَفعِلُنْ مُستَفعِلُنْ",
  },
  {
    slug: "ramal", name: "الرمل", tafila: "فاعلاتن فاعلاتن فاعلاتن", sort: 8, kind: "bahr",
    miftah: "رَمَلُ الأَبحُرِ تَرويهِ الثِّقاتُ · فاعِلاتُنْ فاعِلاتُنْ فاعِلاتُنْ",
  },
  {
    slug: "sari", name: "السريع", tafila: "مستفعلن مستفعلن فاعلن", sort: 9, kind: "bahr",
    miftah: "بَحرٌ سَريعٌ ما لَهُ ساحِلُ · مُستَفعِلُنْ مُستَفعِلُنْ فاعِلُنْ",
  },
  {
    slug: "munsarih", name: "المنسرح", tafila: "مستفعلن مفعولات مستفعلن", sort: 10, kind: "bahr",
    miftah: "مُنسَرِحٌ فيهِ يُضرَبُ المَثَلُ · مُستَفعِلُنْ مَفعولاتُ مُفتَعِلُنْ",
  },
  {
    slug: "khafif", name: "الخفيف", tafila: "فاعلاتن مستفعلن فاعلاتن", sort: 11, kind: "bahr",
    miftah: "يا خَفيفاً خَفَّت بِهِ الحَرَكاتُ · فاعِلاتُنْ مُستَفعِلُنْ فاعِلاتُنْ",
  },
  {
    slug: "mudari", name: "المضارع", tafila: "مفاعيلن فاعلاتن", sort: 12, kind: "bahr",
    miftah: "تُعَدُّ المُضارِعاتُ · مَفاعيلُ فاعِلاتُنْ",
  },
  {
    slug: "muqtadab", name: "المقتضب", tafila: "مفعولات مستفعلن", sort: 13, kind: "bahr",
    miftah: "اِقتَضِبْ كَما سَأَلوا · مَفعُلاتُ مُفتَعِلُنْ",
  },
  {
    slug: "mujtath", name: "المجتث", tafila: "مستفعلن فاعلاتن فاعلاتن", sort: 14, kind: "bahr",
    miftah: "أَنِ اِجتُثَّتِ الحَرَكاتُ · مُستَفعِلُنْ فاعِلاتُنْ",
  },
  {
    slug: "mutaqarib", name: "المتقارب", tafila: "فعولن فعولن فعولن فعولن", sort: 15, kind: "bahr",
    miftah: "عَنِ المُتَقارِبِ قالَ الخَليلُ · فَعولُنْ فَعولُنْ فَعولُنْ فَعولُنْ",
  },
  {
    slug: "mutadarik", name: "المتدارك", tafila: "فاعلن فاعلن فاعلن فاعلن", sort: 16, kind: "bahr",
    miftah: "حَرَكاتُ المُحدَثِ تَنتَقِلُ · فَعِلُنْ فَعِلُنْ فَعِلُنْ فَعِلُنْ",
  },
]

/** Everything that is filed under `poem meter` but is not one of the 16. */
export const NON_BUHUR: readonly MeterRow[] = [
  { slug: "taf3ila", name: "شعر التفعيلة", tafila: null, miftah: null, sort: 20, kind: "free" },
  { slug: "muwashah", name: "الموشح", tafila: null, miftah: null, sort: 21, kind: "muwashah" },
  { slug: "nathr", name: "النثرية", tafila: null, miftah: null, sort: 22, kind: "prose" },
  { slug: "dubayt", name: "الدوبيت", tafila: null, miftah: null, sort: 30, kind: "folk" },
  { slug: "mawwaliya", name: "المواليا", tafila: null, miftah: null, sort: 31, kind: "folk" },
  { slug: "kankan", name: "الكان كان", tafila: null, miftah: null, sort: 32, kind: "folk" },
  { slug: "quma", name: "القوما", tafila: null, miftah: null, sort: 33, kind: "folk" },
  { slug: "zajal", name: "الزجل", tafila: null, miftah: null, sort: 34, kind: "folk" },
  { slug: "mashub", name: "المسحوب", tafila: null, miftah: null, sort: 35, kind: "folk" },
  { slug: "hijayni", name: "الهجيني", tafila: null, miftah: null, sort: 36, kind: "folk" },
  { slug: "luwayhani", name: "اللويحاني", tafila: null, miftah: null, sort: 37, kind: "folk" },
  { slug: "hida", name: "الحداء", tafila: null, miftah: null, sort: 38, kind: "folk" },
  { slug: "sakhri", name: "الصخري", tafila: null, miftah: null, sort: 39, kind: "folk" },
  { slug: "silsila", name: "السلسلة", tafila: null, miftah: null, sort: 40, kind: "folk" },
  { slug: "amudi", name: "عمودية", tafila: null, miftah: null, sort: 50, kind: "unknown" },
  { slug: "muta3addid", name: "عدة أبحر", tafila: null, miftah: null, sort: 51, kind: "unknown" },
]

/** The rows `build.ts` seeds `meters` with, in `sort` order. */
export const METERS: readonly MeterRow[] = [...BUHUR, ...NON_BUHUR]

export const METERS_BY_SLUG: ReadonlyMap<string, MeterRow> = new Map(
  METERS.map((m) => [m.slug, m] as const),
)

export function meterBySlug(slug: string | null | undefined): MeterRow | null {
  if (!slug) return null
  return METERS_BY_SLUG.get(slug) ?? null
}

/** Only `kind:'bahr'` rows are eligible for the game pool (design-server.md §3). */
export function isGameEligibleMeter(slug: string | null | undefined): boolean {
  return meterBySlug(slug)?.kind === "bahr"
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeMeter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Modifiers that peel off a metre name into `variant`. Matched on the
 * normalised token with an optional ال, which is how «بحر الكامل المقطوع» and
 * «بحر المتدارك المنهوك» resolve the same way as their leading-modifier twins.
 */
const MODIFIERS: readonly string[] = [
  "مجزوء", "مشطور", "منهوك", "مخلع", "أحذ", "مربع", "مقطوع", "تفعيلة",
]

const MODIFIER_BY_KEY: ReadonlyMap<string, string> = new Map(
  MODIFIERS.flatMap((m) => {
    const k = normalizeArabic(m)
    return [[k, m] as const, [`ال${k}`, m] as const]
  }),
)

/** Canonical lookup key: normalised, ال dropped. الطويل and طويل are one thing. */
function meterKey(s: string): string {
  const n = normalizeArabic(s)
  return n.startsWith("ال") && n.length > 3 ? n.slice(2) : n
}

const CANONICAL_BY_KEY: ReadonlyMap<string, MeterRow> = new Map(
  BUHUR.map((m) => [meterKey(m.name), m] as const),
)

/**
 * design-server.md §3's exception table, keyed the same way. Every entry here
 * is a raw value `data/profile.json` actually contains — nothing speculative,
 * because an exception that matches nothing is an exception that hides a bug.
 */
const EXCEPTIONS: ReadonlyMap<string, NormalizedMeter> = new Map(
  (
    [
      // الخبب is المتدارك with all its فاعلن turned فعلن — a variant, not a bahr.
      ["الخبب", { meterSlug: "mutadarik", variant: "خبب", kind: "bahr", langHint: null }],
      ["التفعيلة", { meterSlug: "taf3ila", variant: null, kind: "free", langHint: null }],
      ["شعر التفعيلة", { meterSlug: "taf3ila", variant: null, kind: "free", langHint: null }],
      ["شعر حر", { meterSlug: "taf3ila", variant: null, kind: "free", langHint: null }],
      ["الموشح", { meterSlug: "muwashah", variant: null, kind: "muwashah", langHint: null }],
      ["النثرية", { meterSlug: "nathr", variant: null, kind: "prose", langHint: null }],
      ["عمودية", { meterSlug: "amudi", variant: null, kind: "unknown", langHint: null }],
      ["عدة أبحر", { meterSlug: "muta3addid", variant: null, kind: "unknown", langHint: null }],
      ["الدوبيت", { meterSlug: "dubayt", variant: null, kind: "folk", langHint: null }],
      ["المواليا", { meterSlug: "mawwaliya", variant: null, kind: "folk", langHint: null }],
      ["الكان كان", { meterSlug: "kankan", variant: null, kind: "folk", langHint: null }],
      ["القوما", { meterSlug: "quma", variant: null, kind: "folk", langHint: null }],
      ["الزجل", { meterSlug: "zajal", variant: null, kind: "folk", langHint: null }],
      ["المسحوب", { meterSlug: "mashub", variant: null, kind: "folk", langHint: null }],
      ["الهجيني", { meterSlug: "hijayni", variant: null, kind: "folk", langHint: null }],
      ["اللويحاني", { meterSlug: "luwayhani", variant: null, kind: "folk", langHint: null }],
      ["الحداء", { meterSlug: "hida", variant: null, kind: "folk", langHint: null }],
      ["الصخري", { meterSlug: "sakhri", variant: null, kind: "folk", langHint: null }],
      ["السلسلة", { meterSlug: "silsila", variant: null, kind: "folk", langHint: null }],
      // «عامي» in the metre column is not a metre at all — it is the dialect
      // marker leaking one column to the left. Carry it to `poems.lang_type`.
      ["عامي", { meterSlug: null, variant: null, kind: "unknown", langHint: "عامي" }],
    ] as const
  ).map(([raw, out]) => [meterKey(raw), out as NormalizedMeter] as const),
)

/**
 * The three raw values that legitimately resolve to `kind:'unknown'`. Anything
 * ELSE landing on unknown is an ingest bug and `build.ts` asserts on it.
 */
export const UNKNOWN_BY_DESIGN: readonly string[] = ["عموديه", "عدة أبحر", "عامي"]

const UNKNOWN: NormalizedMeter = { meterSlug: null, variant: null, kind: "unknown", langHint: null }

/**
 * `normalizeMeter(raw)` — design-server.md §3, step for step.
 *
 * 1. `cleanText`; empty or "-" → unknown  (32 rows carry a literal "-")
 * 2. drop a leading «بحر » — 65 of the 101 values have it
 * 3. peel modifiers off either end into `variant`
 * 4. normalise the remainder; ال is added or dropped by `meterKey`, so «بسيط»
 *    and «البسيط» — both present in the corpus — land together
 * 5. canonical 16 → kind 'bahr'
 * 6. exceptions
 * 7. otherwise unknown, and the caller logs it
 */
export function normalizeMeter(raw: string | null | undefined): NormalizedMeter {
  const cleaned = cleanText(raw)
  if (cleaned === "" || cleaned === "-") {
    // cleanText already drops "-" (it carries no Arabic letter), but be
    // explicit: a future change there must not silently mint a metre.
    return UNKNOWN
  }

  let tokens = cleaned.split(/\s+/).filter((t) => t !== "")
  if (tokens.length > 1 && normalizeArabic(tokens[0]!) === "بحر") tokens = tokens.slice(1)

  // Resolve the whole remainder FIRST. Several exceptions are multi-word and
  // one of them — «شعر التفعيلة» — ends on a token that is also a modifier;
  // peeling before looking up would strip it down to a meaningless «شعر».
  const whole = resolve(meterKey(tokens.join(" ")), null)
  if (whole !== null) return whole

  const variants: string[] = []
  while (tokens.length > 1) {
    const hit = MODIFIER_BY_KEY.get(normalizeArabic(tokens[0]!))
    if (hit === undefined) break
    variants.push(hit)
    tokens = tokens.slice(1)
  }
  while (tokens.length > 1) {
    const hit = MODIFIER_BY_KEY.get(normalizeArabic(tokens[tokens.length - 1]!))
    if (hit === undefined) break
    variants.push(hit)
    tokens = tokens.slice(0, -1)
  }

  const variant = variants.length > 0 ? variants.join(" ") : null
  const peeled = resolve(meterKey(tokens.join(" ")), variant)
  return peeled ?? { ...UNKNOWN, variant }
}

/** Canonical 16 → exceptions → nothing. `variant` is the peel result so far. */
function resolve(key: string, variant: string | null): NormalizedMeter | null {
  if (key === "") return null

  const canonical = CANONICAL_BY_KEY.get(key)
  if (canonical !== undefined) {
    return { meterSlug: canonical.slug, variant, kind: "bahr", langHint: null }
  }

  const exception = EXCEPTIONS.get(key)
  if (exception !== undefined) {
    // An exception that carries its own variant keeps it («الخبب» → خبب);
    // otherwise the peeled modifier applies («بحر مجزوء موشح» → مجزوء).
    return { ...exception, variant: exception.variant ?? variant }
  }

  return null
}
