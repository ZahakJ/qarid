import { describe, expect, it } from "vitest"
import { z } from "zod"
import { HIJAI_LETTERS as ARABIC_LETTERS } from "./letters.ts"
import {
  BaitDtoSchema,
  BaitsQuerySchema,
  DailyResponseSchema,
  DuelSessionSliceSchema,
  FacetsResponseSchema,
  FavoritesSliceSchema,
  GameFiltersSchema,
  GamePoolQuerySchema,
  GameHintRequestSchema,
  GameHintResponseSchema,
  GameReplyRequestSchema,
  GameReplyResponseSchema,
  GameStartRequestSchema,
  GameStartResponseSchema,
  GameVerifyRequestSchema,
  GameVerifyResponseSchema,
  HINT_COSTS,
  LIMITS,
  ALBUM_LIMITS,
  MAX_EXCLUDES,
  MetaResponseSchema,
  PERSIST_KEYS,
  PERSIST_SCHEMAS,
  MIGRATIONS,
  PERSIST_VERSION,
  PoemBaitsQuerySchema,
  PoemDetailResponseSchema,
  PoemsQuerySchema,
  PoetsQuerySchema,
  PoetsResponseSchema,
  ProfileSliceSchema,
  SearchQuerySchema,
  SearchResponseSchema,
  SettingsSliceSchema,
  StatsResponseSchema,
  TIER_DIFFICULTY,
  TrainCandidatesQuerySchema,
  TrainingSliceSchema,
  VERIFY_REJECT_REASONS,
  persistEnvelope,
  toErrorBody,
  type BaitDto,
  type PoemSummary,
  type PoetSummary,
} from "./schema.ts"

// ── example payloads ───────────────────────────────────────────────────────
// Hand-built to look exactly like what a route will emit off the real corpus.

const poetRef = { slug: "almutanabbi", name: "المتنبي" }
/** The two ids a poem answers to: the public «16182» (aldiwan) and `poems.id`. */
const poemRef = { id: "16182", poemId: 4471, title: "على قدر أهل العزم" }
const meterRef = { slug: "tawil", name: "الطويل", variant: null }
const eraRef = { slug: "abbasi", name: "العصر العباسي" }

const poet: PoetSummary = {
  slug: "almutanabbi",
  name: "المتنبي",
  letter: "م",
  era: eraRef,
  location: "العراق",
  description: "أحمد بن الحسين الكندي، أشهر شعراء العربية.",
  fame: 3,
  poemCount: 326,
  baitCount: 5482,
}

const poem: PoemSummary = {
  id: "16182",
  title: "على قدر أهل العزم",
  poet: poetRef,
  meter: meterRef,
  theme: { slug: "madh", name: "قصيدة مدح", display: "مدح" },
  era: eraRef,
  langType: "فصيح",
  rhyme: "م",
  rhymeShare: 1,
  firstLetter: "ع",
  baitCount: 46,
  hasTashkeel: true,
  previewSadr: "على قدرِ أهلِ العزمِ تأتي العزائمُ",
  previewAjuz: "وتأتي على قدرِ الكرامِ المكارمُ",
}

const bait: BaitDto = {
  id: 918273,
  baytKey: "16182:1",
  position: 1,
  sadr: "على قدرِ أهلِ العزمِ تأتي العزائمُ",
  ajuz: "وتأتي على قدرِ الكرامِ المكارمُ",
  rawiyy: "م",
  lastLetter: "م",
  firstLetter: "ع",
  isPartial: false,
  poem: poemRef,
  poet: poetRef,
  meter: meterRef,
  era: eraRef,
}

/** parse(JSON(x)) === x — the contract has to survive the wire, not just TS. */
function roundTrip<T extends z.ZodType>(schema: T, value: z.infer<T>): z.infer<T> {
  const parsed = schema.parse(JSON.parse(JSON.stringify(value)))
  expect(parsed).toEqual(value)
  return parsed
}

// ═══════════════════════════════════════════════════════════════════════════

describe("letters", () => {
  it("draws its 28-letter alphabet from shared/letters.ts, with no second copy", () => {
    expect(ARABIC_LETTERS).toHaveLength(28)
    expect(new Set(ARABIC_LETTERS).size).toBe(28)
    expect(ARABIC_LETTERS[0]).toBe("ا")
    expect(ARABIC_LETTERS[27]).toBe("ي")
    // the folded-away forms must NOT be members
    for (const ch of ["أ", "إ", "آ", "ء", "ى", "ة", "ؤ", "ئ"]) {
      expect(ARABIC_LETTERS as readonly string[]).not.toContain(ch)
    }
  })
})

describe("query params — coercion and clamping", () => {
  it("clamps limit into 1..100 and page to >= 1", () => {
    expect(PoemsQuerySchema.parse({ limit: "1000" }).limit).toBe(LIMITS.maxLimit)
    expect(PoemsQuerySchema.parse({ limit: "0" }).limit).toBe(1)
    expect(PoemsQuerySchema.parse({ limit: "-40" }).limit).toBe(1)
    expect(PoemsQuerySchema.parse({ limit: "25" }).limit).toBe(25)
    expect(PoemsQuerySchema.parse({ page: "0" }).page).toBe(1)
    expect(PoemsQuerySchema.parse({ page: "-7" }).page).toBe(1)
    expect(PoemsQuerySchema.parse({ page: "3" }).page).toBe(3)
  })

  it("falls back instead of throwing on garbage numbers", () => {
    expect(PoemsQuerySchema.parse({ limit: "abc", page: "NaN" })).toMatchObject({
      limit: LIMITS.defaultLimit,
      page: 1,
    })
    expect(PoemsQuerySchema.parse({ limit: "" }).limit).toBe(LIMITS.defaultLimit)
    expect(PoemsQuerySchema.parse({ limit: "12.9" }).limit).toBe(12)
  })

  it("gives /baits its own 300 cap and /search its own 40 cap", () => {
    expect(PoemBaitsQuerySchema.parse({ limit: "5000" }).limit).toBe(LIMITS.maxBaitsLimit)
    expect(PoemBaitsQuerySchema.parse({}).limit).toBe(LIMITS.poemDetailBaits)
    expect(PoemBaitsQuerySchema.parse({ offset: "-3" }).offset).toBe(0)
    expect(SearchQuerySchema.parse({ q: "x", limit: "999" }).limit).toBe(LIMITS.maxSearchLimit)
  })

  it("treats absent and empty string filters as unset", () => {
    const q = PoemsQuerySchema.parse({ era: "", meter: undefined, rhyme: " م ", poet: " almutanabbi " })
    expect(q.era).toBeUndefined()
    expect(q.meter).toBeUndefined()
    expect(q.rhyme).toBe("م")
    expect(q.poet).toBe("almutanabbi")
    expect(q.minBaits).toBeUndefined()
  })

  it("applies documented enum defaults but rejects illegal enum values", () => {
    expect(PoetsQuerySchema.parse({}).sort).toBe("name")
    expect(PoemsQuerySchema.parse({}).sort).toBe("fame")
    expect(SearchQuerySchema.parse({ q: "بيت" }).scope).toBe("all")
    expect(PoemsQuerySchema.safeParse({ sort: "bogus" }).success).toBe(false)
    // a non-folded letter is a bug, not a filter
    expect(PoemsQuerySchema.safeParse({ rhyme: "ة" }).success).toBe(false)
    expect(BaitsQuerySchema.safeParse({ first: "أ" }).success).toBe(false)
  })

  it("parses boolean-ish famous=", () => {
    expect(TrainCandidatesQuerySchema.parse({}).famous).toBe(true)
    expect(TrainCandidatesQuerySchema.parse({ famous: "0" }).famous).toBe(false)
    expect(TrainCandidatesQuerySchema.parse({ famous: "false" }).famous).toBe(false)
    expect(TrainCandidatesQuerySchema.parse({ famous: "1" }).famous).toBe(true)
    expect(TrainCandidatesQuerySchema.parse({ letter: "ن", limit: "500" })).toMatchObject({
      letter: "ن",
      limit: LIMITS.maxLimit,
    })
  })

  it("trims and caps the search query without ever rejecting it", () => {
    expect(SearchQuerySchema.parse({}).q).toBe("")
    expect(SearchQuerySchema.parse({ q: "  الخيلُ  " }).q).toBe("الخيلُ")
    expect(SearchQuerySchema.parse({ q: "ا".repeat(900) }).q).toHaveLength(200)
  })
})

describe("DTO round-trips", () => {
  it("round-trips a BaitDto, including the partial (null عجز) case", () => {
    roundTrip(BaitDtoSchema, bait)
    roundTrip(BaitDtoSchema, { ...bait, baytKey: "q4471:24", position: 24, ajuz: null, rawiyy: null, lastLetter: null, isPartial: true, poem: { id: "q4471", poemId: 4471, title: "بلا عنوان" }, meter: null, era: null })
  })

  it("rejects an unfolded letter and a malformed baytKey", () => {
    expect(BaitDtoSchema.safeParse({ ...bait, rawiyy: "ة" }).success).toBe(false)
    expect(BaitDtoSchema.safeParse({ ...bait, baytKey: "16182" }).success).toBe(false)
    expect(BaitDtoSchema.safeParse({ ...bait, baytKey: "16182:1:2" }).success).toBe(false)
    expect(BaitDtoSchema.safeParse({ ...bait, position: 0 }).success).toBe(false)
  })

  it("accepts both public_id shapes (aldiwan id and the q<rowid> fallback)", () => {
    expect(
      BaitDtoSchema.parse({ ...bait, poem: { id: "q253119", poemId: 253119, title: "ت" }, baytKey: "q253119:1" }).poem.id,
    ).toBe("q253119")
    expect(BaitDtoSchema.safeParse({ ...bait, poem: { id: "../etc", poemId: 1, title: "ت" } }).success).toBe(false)
  })

  it("carries the INTERNAL poems.id alongside the public one — the duel excludes on it", () => {
    // 16182 is an aldiwan page number, 4471 is the row. They are unrelated, and
    // sending the first as the second was the `usedPoemIds` no-op.
    const parsed = BaitDtoSchema.parse(bait)
    expect(parsed.poem.id).toBe("16182")
    expect(parsed.poem.poemId).toBe(4471)
    expect(BaitDtoSchema.safeParse({ ...bait, poem: { ...poemRef, poemId: 0 } }).success).toBe(false)
    expect(BaitDtoSchema.safeParse({ ...bait, poem: { id: poemRef.id, title: poemRef.title } }).success).toBe(false)
  })

  it("round-trips a paired poem detail with hasTashkeel", () => {
    const res = roundTrip(PoemDetailResponseSchema, {
      poem: { ...poem, url: "https://www.aldiwan.net/poem16182.html", poetFame: 3 },
      poet,
      baits: [bait],
      total: 46,
      offset: 0,
      limit: LIMITS.poemDetailBaits,
      hasTashkeel: true,
    })
    expect(res.baits[0]?.sadr).toBeTruthy()
    expect(res.baits[0]?.ajuz).toBeTruthy()
    expect(res.hasTashkeel).toBe(true)
  })

  it("round-trips a poets list with its total/page/limit echo", () => {
    const res = roundTrip(PoetsResponseSchema, { items: [poet], total: 7167, page: 1, limit: 20 })
    expect(res.total).toBe(7167)
  })

  it("round-trips /api/meta with per-letter startsWith/endsWith", () => {
    const res = roundTrip(MetaResponseSchema, {
      buildId: "2026-08-23T19-40-00Z",
      builtAt: "2026-08-23T19:40:00.000Z",
      schemaVersion: 1,
      sourceRevision: "9b5e723df1c5b13b9e4428caff758fe2f3c737f6",
      counts: { poems: 254630, baits: 3857429, poets: 7167, gameBaits: 2100000 },
      meters: [{ slug: "tawil", name: "الطويل", tafila: "فعولن مفاعيلن فعولن مفاعلن", kind: "bahr", sort: 1, poemCount: 51234 }],
      eras: [{ slug: "abbasi", name: "العصر العباسي", sort: 5, kind: "period", poemCount: 90210, poetCount: 2100 }],
      themes: [{ slug: "madh", name: "قصيدة مدح", display: "مدح", sort: 2, kind: "theme", poemCount: 18000 }],
      letters: ARABIC_LETTERS.map((letter, i) => ({ letter, startsWith: 1000 + i, endsWith: 500 + i })),
    })
    expect(res.letters).toHaveLength(28)
    expect(res.letters[0]).toEqual({ letter: "ا", startsWith: 1000, endsWith: 500 })
  })

  it("round-trips a facets payload that keeps zero counts", () => {
    const res = roundTrip(FacetsResponseSchema, {
      total: 12,
      eras: [{ slug: "abbasi", name: "العصر العباسي", count: 12 }, { slug: "jahili", name: "العصر الجاهلي", count: 0 }],
      meters: [{ slug: "tawil", name: "الطويل", count: 12 }, { slug: "hazaj", name: "الهزج", count: 0 }],
      themes: [{ slug: "madh", name: "قصيدة مدح", count: 0 }],
      rhymes: ARABIC_LETTERS.map((letter) => ({ letter, count: letter === "م" ? 12 : 0 })),
      firstLetters: ARABIC_LETTERS.map((letter) => ({ letter, count: 0 })),
      langTypes: [{ value: "فصيح", count: 12 }, { value: "عامي", count: 0 }],
    })
    expect(res.rhymes).toHaveLength(28)
    expect(res.rhymes.filter((r) => r.count === 0)).toHaveLength(27)
    expect(res.firstLetters.every((f) => f.count === 0)).toBe(true)
  })

  it("round-trips a search response carrying mode + highlight", () => {
    const res = roundTrip(SearchResponseSchema, {
      q: "العزم",
      scope: "all",
      mode: "or",
      baits: [{ ...bait, highlight: "علي قدر اهل »العزم« تاتي العزايم وتاتي علي قدر الكرام المكارم", score: -6.42 }],
      poems: [{ ...poem, highlight: null, score: -3.1 }],
      poets: [{ ...poet, highlight: null, score: -1.2 }],
      total: 91,
      page: 1,
      limit: 20,
      ms: 7.4,
    })
    expect(res.mode).toBe("or")
    expect(res.baits[0]?.highlight).toContain("»العزم«")
    // the ORIGINAL tashkeel'd text travels alongside the normalized snippet
    expect(res.baits[0]?.sadr).toContain("العزمِ")
  })

  it("round-trips the daily payload with its shared seed", () => {
    const res = roundTrip(DailyResponseSchema, {
      date: "2026-08-23",
      seed: "daily:2026-08-23",
      bait,
      poem,
      poetOfTheDay: poet,
    })
    expect(res.date).toBe("2026-08-23")
    expect(DailyResponseSchema.safeParse({ date: "23-08-2026", seed: "s", bait, poem, poetOfTheDay: poet }).success).toBe(false)
  })

  it("round-trips the stats histograms", () => {
    const res = roundTrip(StatsResponseSchema, {
      buildId: "2026-08-23T19-40-00Z",
      counts: { poems: 254630, baits: 3857429, poets: 7167, gameBaits: 2100000 },
      eras: [{ slug: "abbasi", name: "العصر العباسي", sort: 5, poems: 90210, poets: 2100, baits: 1400000 }],
      meters: [{ slug: "tawil", name: "الطويل", kind: "bahr", poems: 51234, baits: 900000 }],
      themes: [{ slug: "madh", name: "قصيدة مدح", count: 18000 }],
      rhymes: [{ letter: "م", count: 41000 }],
      firstLetters: [{ letter: "ا", count: 62000 }],
      langTypes: [{ value: "فصيح", count: 174574 }, { value: "عامي", count: 8801 }],
      poemLengths: [
        { min: 1, max: 4, label: "١–٤", count: 60000 },
        { min: 100, max: null, label: "١٠٠+", count: 900 },
      ],
      topPoets: [poet],
    })
    expect(res.poemLengths[1]?.max).toBeNull()
  })
})

describe("game requests", () => {
  it("fills the documented defaults on a bare start body", () => {
    expect(GameStartRequestSchema.parse({})).toEqual({ difficulty: "normal", mode: "rhyme", poolBaitIds: [] })
    expect(GameStartRequestSchema.parse({ difficulty: "brutal", seed: "duel:1:2" })).toMatchObject({
      difficulty: "brutal",
      mode: "rhyme",
      seed: "duel:1:2",
    })
    expect(GameStartRequestSchema.safeParse({ difficulty: "impossible" }).success).toBe(false)
  })

  it("bounds the ديوان pool by the shelf's own cap, and defaults it to «no ديوان»", () => {
    const many = Array.from({ length: 900 }, (_, i) => i + 1)
    expect(GameReplyRequestSchema.parse({ letter: "م", poolBaitIds: many }).poolBaitIds).toHaveLength(ALBUM_LIMITS.baits)
    // `[]` is what an ordinary duel sends, and it means «the whole corpus» —
    // the server reads a NON-EMPTY list as the ديوان (server/routes/game.ts).
    expect(GameReplyRequestSchema.parse({ letter: "م" }).poolBaitIds).toEqual([])
    expect(GameStartRequestSchema.safeParse({ poolBaitIds: [0] }).success).toBe(false)
  })

  it("truncates exclude lists to MAX_EXCLUDES rather than 400ing", () => {
    const many = Array.from({ length: 900 }, (_, i) => i + 1)
    const req = GameReplyRequestSchema.parse({ letter: "م", excludeBaitIds: many, excludePoemIds: many })
    expect(MAX_EXCLUDES).toBe(500)
    expect(req.excludeBaitIds).toHaveLength(MAX_EXCLUDES)
    expect(req.excludePoemIds).toHaveLength(MAX_EXCLUDES)
    expect(req.excludeBaitIds[0]).toBe(1)
    expect(req.tailBias).toBe("none")
    expect(req.difficulty).toBe("normal")
    expect(GameReplyRequestSchema.parse({ letter: "م" }).excludeBaitIds).toEqual([])
  })

  it("keeps the reply letter strict and the tailBias lever legal", () => {
    expect(GameReplyRequestSchema.safeParse({ letter: "ة" }).success).toBe(false)
    expect(GameReplyRequestSchema.parse({ letter: "ظ", tailBias: "hard" }).tailBias).toBe("hard")
    expect(GameReplyRequestSchema.safeParse({ letter: "ظ", tailBias: "brutal" }).success).toBe(false)
  })

  it("accepts a verify body with nulls where the client has nothing yet", () => {
    const req = GameVerifyRequestSchema.parse({
      text: "وتأتي على قدرِ الكرامِ المكارمُ * فمن أين للعينِ",
      prevBaitId: null,
      requiredLetter: null,
      usedBaitIds: [1, 2, 3],
    })
    expect(req.prevBaitId).toBeUndefined()
    expect(req.requiredLetter).toBeUndefined()
    expect(req.mode).toBe("rhyme")
    expect(req.usedPoemIds).toEqual([])
    expect(GameVerifyRequestSchema.safeParse({ text: "" }).success).toBe(false)
  })

  it("drops null/empty game filter keys instead of failing", () => {
    expect(GameFiltersSchema.parse({ era: "abbasi", meter: null, theme: "", poet: undefined })).toEqual({ era: "abbasi" })
    expect(GameFiltersSchema.parse({})).toEqual({})
    expect(GameVerifyRequestSchema.parse({ text: "بيت كامل هنا", filters: { era: null } }).filters).toEqual({})
    expect(GameFiltersSchema.safeParse({ era: "العباسي" }).success).toBe(false)
    // A شاعر slug is NOT ascii — 92K rows carry no `poet url` and fall back to
    // one derived from the Arabic name_key, so `SlugSchema` would refuse them.
    expect(GameFiltersSchema.parse({ poet: "الاخطل-الصغير" }).poet).toBe("الاخطل-الصغير")
  })

  // The setup screen's «العدد المتاح» must be able to ask about every «قيد» the
  // duel can be started with, or the number over «ابدأ» describes a different
  // duel from the one the button starts.
  it("takes the same شاعر on the pool query as the filters carry", () => {
    expect(GamePoolQuerySchema.parse({ poet: "mutanabi" })).toMatchObject({ poet: "mutanabi", difficulty: "normal" })
    expect(GamePoolQuerySchema.parse({ poet: "" }).poet).toBeUndefined()
    expect(GamePoolQuerySchema.parse({}).poet).toBeUndefined()
    for (const key of Object.keys(GameFiltersSchema.parse({ era: "abbasi", meter: "tawil", theme: "hikma", poet: "mutanabi", lang: "فصيح" }))) {
      expect(GamePoolQuerySchema.shape, key).toHaveProperty(key)
    }
  })

  it("validates hint requests for all four kinds", () => {
    expect(GameHintRequestSchema.parse({ kind: "poet", baitId: 5 })).toMatchObject({ kind: "poet", baitId: 5, difficulty: "normal" })
    expect(GameHintRequestSchema.parse({ kind: "switch_letter", letter: "ظ" }).letter).toBe("ظ")
    expect(GameHintRequestSchema.safeParse({ kind: "بحر" }).success).toBe(false)
    expect(HINT_COSTS.switch_letter).toBe(150)
    expect(HINT_COSTS.accept_near_miss).toBe(25)
  })
})

describe("game responses", () => {
  const served = {
    bait,
    poem,
    poet,
    requiredLetter: "م" as const,
    requiredLetterSource: "rawiyy" as const,
    alsoAccepted: [] as ("م")[],
    mode: "rhyme" as const,
    obscurity: 0,
  }

  it("discriminates start ok from an exhausted pool", () => {
    const ok = roundTrip(GameStartResponseSchema, { ok: true, seed: "duel:7", ...served })
    expect(ok.ok && ok.requiredLetter).toBe("م")
    const none = roundTrip(GameStartResponseSchema, { ok: false, reason: "no_bait", letter: null })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.reason).toBe("no_bait")
  })

  it("round-trips a reply and its «أفحمتَ الخصم» no_bait", () => {
    const ok = roundTrip(GameReplyResponseSchema, {
      ok: true,
      seed: "daily:2026-08-23:3",
      ...served,
      requiredLetterSource: "peeled",
      alsoAccepted: ["ه"],
      obscurity: 0.48,
    })
    expect(ok.ok && ok.requiredLetterSource).toBe("peeled")
    expect(ok.ok && ok.alsoAccepted).toEqual(["ه"])
    roundTrip(GameReplyResponseSchema, { ok: false, reason: "no_bait", letter: "ظ" })
  })

  it("round-trips an accepted verify", () => {
    const res = roundTrip(GameVerifyResponseSchema, {
      ok: true,
      matchKind: "fuzzy",
      confidence: 0.82,
      normalized: "علي قدر اهل العزم تاتي العزايم وتاتي علي قدر الكرام المكارم",
      ...served,
      obscurity: 0.25,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.matchKind).toBe("fuzzy")
  })

  it("round-trips every rejection reason, and the union covers exactly the nine", () => {
    const samples: Record<(typeof VERIFY_REJECT_REASONS)[number], z.infer<typeof GameVerifyResponseSchema>> = {
      wrong_letter: { ok: false, reason: "wrong_letter", expected: "ن", alsoAccepted: ["ه"], got: "م", normalized: "من ذا الذي" },
      already_used: { ok: false, reason: "already_used", bait },
      not_found: { ok: false, reason: "not_found", normalized: "بيت مخترع", suggestions: [bait] },
      near_miss: { ok: false, reason: "near_miss", normalized: "علي قدر اهل العزم", suggestion: bait, score: 0.47, acceptCost: HINT_COSTS.accept_near_miss },
      ambiguous: { ok: false, reason: "ambiguous", normalized: "قفا نبك", candidates: [bait, { ...bait, id: 918274, baytKey: "16182:2", position: 2 }] },
      incomplete_bait: { ok: false, reason: "incomplete_bait", bait: { ...bait, ajuz: null, isPartial: true } },
      too_short: { ok: false, reason: "too_short", words: 1 },
      not_in_album: { ok: false, reason: "not_in_album", bait, albumTitle: "ما أحفظ" },
      no_bait: { ok: false, reason: "no_bait", letter: "ظ" },
    }

    expect(Object.keys(samples).sort()).toEqual([...VERIFY_REJECT_REASONS].sort())
    for (const reason of VERIFY_REJECT_REASONS) {
      const res = roundTrip(GameVerifyResponseSchema, samples[reason])
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe(reason)
    }
  })

  it("enforces the documented suggestion/candidate caps", () => {
    const four = [bait, bait, bait, bait]
    expect(GameVerifyResponseSchema.safeParse({ ok: false, reason: "not_found", normalized: "x", suggestions: four }).success).toBe(false)
    expect(GameVerifyResponseSchema.safeParse({ ok: false, reason: "ambiguous", normalized: "x", candidates: [bait] }).success).toBe(false)
    expect(GameVerifyResponseSchema.safeParse({ ok: false, reason: "ambiguous", normalized: "x", candidates: [...four, bait] }).success).toBe(false)
  })

  it("round-trips hint responses including «بدّل الحرف»", () => {
    roundTrip(GameHintResponseSchema, { ok: true, kind: "poet", cost: HINT_COSTS.poet, poet: poetRef })
    roundTrip(GameHintResponseSchema, { ok: true, kind: "first_word", cost: HINT_COSTS.first_word, firstWord: "على" })
    roundTrip(GameHintResponseSchema, { ok: true, kind: "meter", cost: HINT_COSTS.meter, meter: meterRef })
    const swapped = roundTrip(GameHintResponseSchema, {
      ok: true,
      kind: "switch_letter",
      cost: HINT_COSTS.switch_letter,
      bait,
      poem,
      poet,
      requiredLetter: "م",
      requiredLetterSource: "rawiyy",
      alsoAccepted: [],
      mode: "rhyme",
      obscurity: 0,
    })
    expect(swapped.ok && swapped.kind).toBe("switch_letter")
    roundTrip(GameHintResponseSchema, { ok: false, reason: "no_bait" })
  })
})

describe("persisted client slices", () => {
  it("is version 2 with namespaced keys and a schema per slice", () => {
    expect(PERSIST_VERSION).toBe(2)
    // The KEYS are literals and do not track the version — `qarid:v1:duel` is
    // where a v1 payload lives and where its migrated v2 successor is written
    // back. Renaming them would orphan every session on disk.
    for (const [slice, key] of Object.entries(PERSIST_KEYS)) {
      expect(key).toBe(`qarid:v1:${slice}`)
      expect(PERSIST_SCHEMAS[slice as keyof typeof PERSIST_SCHEMAS]).toBeDefined()
    }
    // every version below the current one must have a step, or `persist.ts`
    // gives up and resets the slice
    for (let v = 1; v < PERSIST_VERSION; v++) expect(MIGRATIONS[v]).toBeTypeOf("function")
  })

  it("round-trips the {v,data} envelope and rejects a corrupt payload", () => {
    const env = persistEnvelope(SettingsSliceSchema)
    const stored = { v: PERSIST_VERSION, data: SettingsSliceSchema.parse({}) }
    roundTrip(env, stored)
    expect(env.safeParse({ v: PERSIST_VERSION, data: { verseSize: "huge" } }).success).toBe(false)
    expect(env.safeParse({ data: stored.data }).success).toBe(false)
    expect(env.safeParse("qarid").success).toBe(false)
  })

  it("gives settings the design-ux defaults from an empty object", () => {
    expect(SettingsSliceSchema.parse({})).toEqual({
      tashkeel: true,
      showRawiyy: false,
      verseSize: "md",
      sound: false,
      reduceMotion: "system",
    })
    // a partially-written slice heals rather than resetting everything
    expect(SettingsSliceSchema.parse({ verseSize: "lg" }).verseSize).toBe("lg")
  })

  it("round-trips a mid-duel session", () => {
    const session = DuelSessionSliceSchema.parse({
      config: { tier: "champion", difficulty: "hard", chainMode: "rhyme", tailBias: "hard", format: "endless", timer: true, turnSeconds: 25, lives: 2, filters: { era: "abbasi" } },
      seed: "duel:1755980000000:champion",
      phase: "awaiting",
      required: { letter: "م", source: "rawiyy", alsoAccepted: [] },
      exchanges: [
        { side: "opponent", baytKey: "16182:1", baitId: 918273, sadr: bait.sadr, ajuz: bait.ajuz, poemId: "16182", poet: poetRef, meter: meterRef, requiredLetter: "م", award: 0, hints: [], ms: 0, obscurity: 0, at: 1755980001000 },
        { side: "player", baytKey: "q4471:3", baitId: 55, sadr: "منَ الشِعرِ ما قد سارَ", ajuz: "وما زالَ في الآفاقِ", poemId: "q4471", poet: { slug: "abu-tammam", name: "أبو تمام" }, meter: null, requiredLetter: "م", award: 140, hints: ["meter"], ms: 8400, obscurity: 0.33, at: 1755980010000 },
      ],
      usedKeys: ["16182:1", "q4471:3"],
      usedBaitIds: [918273, 55],
      usedPoemIds: [1, 2],
      score: 140,
      lives: 2,
      streak: 1,
      best: 1,
      startedAt: 1755980000000,
      deadline: 1755980035000,
      pausedAt: null,
      lastResult: { kind: "accepted", message: null, at: 1755980010000 },
      dailyDate: null,
    })
    roundTrip(DuelSessionSliceSchema, session)
    expect(session.exchanges).toHaveLength(2)
    expect(session.config.turnSeconds).toBe(25)
    expect(TIER_DIFFICULTY[session.config.tier]).toBe("hard")
    expect(DuelSessionSliceSchema.safeParse({ ...session, phase: "thinking" }).success).toBe(false)
  })

  it("round-trips training cards and a partial arsenal", () => {
    const slice = TrainingSliceSchema.parse({
      cards: {
        "16182:1": {
          id: "16182:1",
          baitId: 918273,
          sadr: bait.sadr,
          ajuz: bait.ajuz,
          poet: poetRef,
          poemId: "16182",
          firstLetter: "ع",
          rawiyy: "م",
          ease: 2.3,
          interval: 3,
          due: 1756100000000,
          reps: 2,
          lapses: 0,
          leech: false,
          addedAt: 1755000000000,
        },
      },
      dayKey: "2026-08-23",
      newIntroducedToday: 4,
      arsenal: { "م": { used: 12, mastered: 3, lastAt: 1755980010000 }, "ظ": { used: 0, mastered: 0, lastAt: null } },
      session: { queue: ["16182:1"], index: 0, startedAt: 1755980000000, correct: 0, seen: 1 },
      reviewStreak: 5,
      lastReviewDay: "2026-08-23",
    })
    roundTrip(TrainingSliceSchema, slice)
    expect(Object.keys(slice.arsenal)).toEqual(["م", "ظ"])
    expect(slice.cards["16182:1"]?.ease).toBe(2.3)
    expect(TrainingSliceSchema.parse({})).toMatchObject({ cards: {}, arsenal: {}, newIntroducedToday: 0, session: null })
    // ease outside SM-2-lite bounds is corrupt
    expect(TrainingSliceSchema.safeParse({ cards: { "16182:1": { ...slice.cards["16182:1"], ease: 9 } } }).success).toBe(false)
  })

  it("round-trips the profile and its daily results", () => {
    const profile = ProfileSliceSchema.parse({
      gamesPlayed: 12,
      abyatPlayed: 96,
      bestStreak: 14,
      bestScore: 2380,
      poetsMet: ["almutanabbi", "أبو-تمام"],
      dailyResults: { "2026-08-23": { date: "2026-08-23", score: 640, chainLength: 6, letters: ["ن", "م", "ب", "ر"], completedAt: 1755980010000 } },
      reviewStreak: 5,
      firstSeenAt: 1750000000000,
    })
    roundTrip(ProfileSliceSchema, profile)
    // poet slugs may be Arabic (91,936 rows carry no poet url to slugify)
    expect(profile.poetsMet).toContain("أبو-تمام")
    expect(ProfileSliceSchema.parse({}).gamesPlayed).toBe(0)
  })

  it("round-trips denormalized favorites and collections", () => {
    const favorites = FavoritesSliceSchema.parse({
      favorites: [
        { baytKey: "16182:1", baitId: 918273, sadr: bait.sadr, ajuz: bait.ajuz, poemId: "16182", poemTitle: poem.title, poet: poetRef, meter: meterRef, note: null, savedAt: 1755980010000 },
      ],
      collections: [{ id: "c1", name: "الحماسة", baytKeys: ["16182:1"], createdAt: 1755980010000, updatedAt: 1755980020000 }],
    })
    roundTrip(FavoritesSliceSchema, favorites)
    // renders with no network: the text itself is in the slice
    expect(favorites.favorites[0]?.sadr).toContain("العزمِ")
    expect(FavoritesSliceSchema.parse({})).toEqual({ favorites: [], collections: [] })
  })
})

describe("toErrorBody", () => {
  it("shapes a zod failure into the documented 400 body", () => {
    const parsed = PoemsQuerySchema.safeParse({ sort: "bogus" })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const body = toErrorBody(parsed.error, "bad_query")
    expect(body.error).toBe("bad_query")
    expect(body.issues?.[0]?.path).toEqual(["sort"])
    expect(typeof body.issues?.[0]?.message).toBe("string")
    // it must survive JSON — Hono serializes it straight onto the wire
    expect(JSON.parse(JSON.stringify(body))).toEqual(body)
  })
})
