import { describe, expect, it } from "vitest"

import { fnv1a32, fnv1a64Signed, normalizeArabic, stripTashkeel } from "../../shared/arabic.ts"
import { BUCKETS, PLAYABLE, TASHKEEL_THRESHOLD } from "../../shared/constants.ts"
import { METERS_BY_SLUG } from "../../shared/meters.ts"
import type { RawPoem } from "./readers.ts"
import {
  aldiwanIdFrom,
  bareLength,
  dedupCandidateOf,
  dedupKeyOfRaw,
  fallbackPoetSlug,
  isPlayableBait,
  modalRawiyy,
  pickDedupWinner,
  poetSlugFrom,
  stripParenthetical,
  SUSPECT_FLOOR,
  tashkeelRatio,
  transformPoem,
  UNKNOWN_POET,
  UNTITLED,
} from "./transform.ts"

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

const EMPTY: RawPoem = {
  title: null,
  meter: null,
  verses: [],
  theme: null,
  poemUrl: null,
  poetName: null,
  poetDescription: null,
  poetUrl: null,
  poetEra: null,
  poetLocation: null,
  langType: null,
}

function raw(over: Partial<RawPoem>): RawPoem {
  return { ...EMPTY, ...over }
}

/** Four hemistichs of المتنبي — two complete أبيات on ميم. */
const MUTANABBI = [
  "عَلى قَدرِ أَهلِ العَزمِ تَأتي العَزائِمُ",
  "وَتَأتي عَلى قَدرِ الكِرامِ المَكارِمُ",
  "وَتَعظُمُ في عَينِ الصَغيرِ صِغارُها",
  "وَتَصغُرُ في عَينِ العَظيمِ العَظائِمُ",
]

/** The transform never returns null for a row that has one real hemistich. */
function must(p: RawPoem) {
  const t = transformPoem(p)
  expect(t).not.toBeNull()
  return t!
}

const ALDIWAN = "https://www.aldiwan.net/poem1.html"

/** Which of these copies pass 0 would keep, as an INDEX into the array. */
function winnerOf(copies: readonly RawPoem[]): number {
  return pickDedupWinner(copies.map((c, i) => dedupCandidateOf(c, i)))
}

/** `n` hemistichs of one قصيدة: every عجز on the same روي. */
function longQasida(n: number): string[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `صدر رقم ${i} يمتد هنا` : `وعجز رقم ${i} على الميم`))
}

/** `n` hemistichs of a scraped ديوان: the روي changes every بيت. */
function blobVerses(n: number): string[] {
  const rawiyy = "بتثجحخدذرزسشصضطظعغفقكلمنهوي"
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? `صدر رقم ${i} يمتد هنا` : `وعجز رقم ${i} على حرف ${rawiyy[(i >> 1) % rawiyy.length]!}${rawiyy[(i >> 1) % rawiyy.length]!}`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// URL keys
// ═════════════════════════════════════════════════════════════════════════════

describe("aldiwanIdFrom", () => {
  it("lifts the numeric id out of an aldiwan poem url", () => {
    expect(aldiwanIdFrom("https://www.aldiwan.net/poem16182.html")).toBe(16182)
    expect(aldiwanIdFrom("http://aldiwan.net/poem1.html")).toBe(1)
  })

  it("answers null for the seven other hosts and for junk", () => {
    // CLAUDE.md spike finding 1 — 73% of the corpus lives on these
    expect(aldiwanIdFrom("https://poetry.dctabudhabi.ae/diwan/poem/38716")).toBeNull()
    expect(aldiwanIdFrom("https://www.poetsgate.com/ViewPoem.aspx?id=204454")).toBeNull()
    expect(aldiwanIdFrom("http://www.adab.com/modules.php?name=Sh3er&doWhat=shqas&qid=1")).toBeNull()
    expect(aldiwanIdFrom("https://www.aldiwan.net/cat-poet-almtnby")).toBeNull()
    expect(aldiwanIdFrom(null)).toBeNull()
    expect(aldiwanIdFrom("")).toBeNull()
  })
})

describe("poetSlugFrom", () => {
  it("lifts the ascii slug out of an aldiwan poet url", () => {
    expect(poetSlugFrom("https://www.aldiwan.net/cat-poet-almtnby")).toBe("almtnby")
    expect(poetSlugFrom("https://aldiwan.net/cat-poet-ahmed-shawqi")).toBe("ahmed-shawqi")
  })

  it("answers null where there is no aldiwan poet page (91,936 rows)", () => {
    expect(poetSlugFrom(null)).toBeNull()
    expect(poetSlugFrom("https://poetry.dctabudhabi.ae/diwan/poet/1421")).toBeNull()
    expect(poetSlugFrom("https://www.aldiwan.net/poem16182.html")).toBeNull()
  })

  it("rejects a slug that is not plain ascii — the fallback is better than mojibake", () => {
    expect(poetSlugFrom("https://www.aldiwan.net/cat-poet-%D8%A7%D9%84%D9%85%D8%AA%D9%86%D8%A8%D9%8A")).toBeNull()
  })
})

describe("fallbackPoetSlug", () => {
  it("hyphenates the normalised name", () => {
    expect(fallbackPoetSlug("زهير بن ابي سلمي")).toBe("زهير-بن-ابي-سلمي")
  })

  it("never returns the empty string", () => {
    expect(fallbackPoetSlug("")).toBe("shaer")
    expect(fallbackPoetSlug("   ")).toBe("shaer")
  })

  it("drops path characters that would break a route", () => {
    expect(fallbackPoetSlug("ابو/فراس؟")).toBe("ابوفراس؟")
  })
})

describe("stripParenthetical", () => {
  it("removes a nickname suffix", () => {
    expect(stripParenthetical("بشارة الخوري (الأخطل الصغير )").replace(/\s+/g, " ").trim()).toBe("بشارة الخوري")
  })

  it("tolerates an unclosed bracket", () => {
    expect(stripParenthetical("فلان (ملقب").trim()).toBe("فلان")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Hemistich pairing
// ═════════════════════════════════════════════════════════════════════════════

describe("transformPoem — pairing", () => {
  it("pairs (2i, 2i+1) into أبيات", () => {
    const t = must(raw({ verses: MUTANABBI, title: "على قدر أهل العزم" }))
    expect(t.baitCount).toBe(2)
    expect(t.baits.map((b) => b.position)).toEqual([1, 2])
    expect(t.baits[0]!.sadr).toBe(MUTANABBI[0])
    expect(t.baits[0]!.ajuz).toBe(MUTANABBI[1])
    expect(t.baits[1]!.sadr).toBe(MUTANABBI[2])
    expect(t.baits[1]!.ajuz).toBe(MUTANABBI[3])
    expect(t.baits.every((b) => !b.isPartial)).toBe(true)
  })

  it("leaves an odd trailing hemistich as a partial بيت with a null عجز", () => {
    const t = must(raw({ verses: [...MUTANABBI, "وَما نَيلُ المَطالِبِ بِالتَمَنّي"] }))
    expect(t.baitCount).toBe(3)
    const last = t.baits[2]!
    expect(last.isPartial).toBe(true)
    expect(last.ajuz).toBeNull()
    expect(last.rawiyy).toBeNull()
    expect(last.lastLetter).toBeNull()
    expect(last.hFull).toBeNull()
    expect(last.playable).toBe(false)
  })

  it("drops blank and junk hemistichs BEFORE pairing, so mid-poem junk cannot desync the pairs", () => {
    const t = must(
      raw({
        verses: [MUTANABBI[0]!, "   ", "***", MUTANABBI[1]!, "", "— — —", MUTANABBI[2]!, MUTANABBI[3]!],
      }),
    )
    expect(t.baitCount).toBe(2)
    expect(t.baits[0]!.ajuz).toBe(MUTANABBI[1])
    expect(t.baits[1]!.sadr).toBe(MUTANABBI[2])
  })

  it("returns null for a row with no verse at all, and for one that is all junk", () => {
    expect(transformPoem(raw({ verses: [] }))).toBeNull()
    expect(transformPoem(raw({ verses: ["***", "  ", "---", "…"] }))).toBeNull()
  })

  it("carries بيت ١ into the preview columns", () => {
    const t = must(raw({ verses: MUTANABBI }))
    expect(t.previewSadr).toBe(MUTANABBI[0])
    expect(t.previewAjuz).toBe(MUTANABBI[1])
    const lone = must(raw({ verses: [MUTANABBI[0]!] }))
    expect(lone.previewAjuz).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Identity
// ═════════════════════════════════════════════════════════════════════════════

describe("transformPoem — identity", () => {
  it("defaults a missing title and a missing شاعر", () => {
    const t = must(raw({ verses: MUTANABBI }))
    expect(t.title).toBe(UNTITLED)
    expect(t.poet.name).toBe(UNKNOWN_POET)
  })

  it("strips the parenthetical suffix from the شاعر's display name", () => {
    // …and then the alias table folds what is left onto the شهرة, so this row
    // shows both halves at once: the parenthetical goes, and «بشارة الخوري»
    // resolves to «الأخطل الصغير» — the two poets rows the corpus used to hold.
    const t = must(raw({ verses: MUTANABBI, poetName: "بشارة الخوري (الأخطل الصغير )" }))
    expect(t.poet.name).toBe("بشارة الخوري")
    expect(t.poet.nameKey).toBe(normalizeArabic("الأخطل الصغير"))
    expect(t.poet.isCanonicalName).toBe(false)
  })

  it("stores a شاعر under his canonical name_key, alias spellings included", () => {
    const alias = must(raw({ verses: MUTANABBI, poetName: "أبو الطيب المتنبي" }))
    const canonical = must(raw({ verses: MUTANABBI, poetName: "المتنبي" }))
    expect(alias.poet.nameKey).toBe(normalizeArabic("المتنبي"))
    expect(alias.poet.nameKey).toBe(canonical.poet.nameKey)
    // the display name is untouched — build.ts is what prefers the canonical one
    expect(alias.poet.name).toBe("أبو الطيب المتنبي")
    expect(alias.poet.isCanonicalName).toBe(false)
    expect(canonical.poet.isCanonicalName).toBe(true)
  })

  it("merges the dedup key too, so one قصيدة under two spellings is one row", () => {
    const alias = must(raw({ verses: MUTANABBI, title: "أ", poetName: "أبو الطيب المتنبي" }))
    const canonical = must(raw({ verses: MUTANABBI, title: "ب", poetName: "المتنبي" }))
    expect(alias.dedupKey).toBe(canonical.dedupKey)
  })

  it("leaves a شاعر the alias table does not name exactly where he was", () => {
    const t = must(raw({ verses: MUTANABBI, poetName: "متنبي المغرب" }))
    expect(t.poet.nameKey).toBe(normalizeArabic("متنبي المغرب"))
    expect(t.poet.isCanonicalName).toBe(true)
  })

  it("derives the شاعر's letter and sort key past the honorifics", () => {
    const t = must(raw({ verses: MUTANABBI, poetName: "أ.د/ مصطفى الشليح" }))
    // the CARD still reads the name the source gave …
    expect(t.poet.name).toBe("أ.د/ مصطفى الشليح")
    // … while the شعراء index files him under الميم, not الألف
    expect(t.poet.letter).toBe("م")
    expect(t.poet.sortKey).toBe("مصطفي الشليح")
  })

  it("builds dedup_key from normalised name|first hemistich — never the title", () => {
    const t = must(raw({ verses: MUTANABBI, title: "على قدر", poetName: "المتنبي" }))
    expect(t.dedupKey).toBe(`${normalizeArabic("المتنبي")}|${normalizeArabic(MUTANABBI[0]!)}`)
  })

  it("gives one قصيدة the same key under the eight sources' eight titles", () => {
    // «جدارية» / «جدارية..محمود درويش» / «جدارية محمود درويش» were three rows
    // in the artefact, adjacent on the first screen of التصفح.
    const key = (title: string) => must(raw({ verses: MUTANABBI, title, poetName: "محمود درويش" })).dedupKey
    expect(key("جدارية")).toBe(key("جدارية..محمود درويش"))
    expect(key("جدارية محمود درويش")).toBe(key("جدارية"))
    expect(key("إلى متى؟")).toBe(key("إلى متى ؟"))
  })

  it("gives a truncated copy the SAME key, and ranks it below the whole قصيدة", () => {
    // build.ts pass 0 keeps the winning copy of a key, so a source that stored
    // five أبيات of a hundred-بيت قصيدة never wins.
    const whole = raw({ verses: MUTANABBI, poetName: "المتنبي" })
    const cut = raw({ verses: MUTANABBI.slice(0, 2), poetName: "المتنبي" })
    expect(must(cut).dedupKey).toBe(must(whole).dedupKey)
    expect(dedupKeyOfRaw(cut)).toBe(must(whole).dedupKey)
    expect(winnerOf([cut, whole])).toBe(1)
    // …and among equals, the بحر-carrying copy wins over the merely vocalised
    // one — the بحر is what makes its أبيات playable at all.
    const vocalised = raw({ verses: MUTANABBI, meter: null, poemUrl: null })
    const labelled = raw({ verses: MUTANABBI.map(stripTashkeel), meter: "بحر الطويل", poemUrl: null })
    expect(winnerOf([vocalised, labelled])).toBe(1)
    // …and below that, the DENSER tashkeel, then aldiwan.net.
    const half = raw({ verses: [`${MUTANABBI[0]!} وما نيل المطالب بالتمني`, MUTANABBI[1]!] })
    expect(winnerOf([half, raw({ verses: MUTANABBI.slice(0, 2) })])).toBe(1)
    const bare = raw({ verses: MUTANABBI.slice(0, 2).map(stripTashkeel) })
    expect(winnerOf([bare, raw({ verses: MUTANABBI.slice(0, 2).map(stripTashkeel), poemUrl: ALDIWAN })])).toBe(1)
  })

  it("ranks a ديوان scraped as ONE poem below the بحر-labelled قصيدة it swallowed", () => {
    // The bug this rule exists for: dctabudhabi indexes all of المتنبي under
    // «على قدر أهل العزم», 1,810 hemistichs with no metre, and length alone let
    // it beat the real 46-بيت طويل قصيدة — which took the most famous ع-بيت in
    // the language out of `game_baits` entirely.
    const blob = raw({ verses: blobVerses(1810), poetName: "المتنبي" })
    const real = raw({ verses: longQasida(92), meter: "بحر الطويل", poetName: "المتنبي", poemUrl: ALDIWAN })
    expect(winnerOf([blob, real])).toBe(1)
    // Nothing else is touched: with no بحر-labelled copy in the group at all,
    // the longest still wins…
    expect(winnerOf([blob, raw({ verses: longQasida(92), poetName: "المتنبي" })])).toBe(0)
    // …a long MONORHYME copy is a قصيدة, not a compilation (ابن الفارض's
    // التائية الكبرى against a truncated labelled copy)…
    const taiyya = raw({ verses: longQasida(1520), poetName: "ابن الفارض" })
    expect(winnerOf([taiyya, raw({ verses: longQasida(387), meter: "بحر الطويل" })])).toBe(0)
    // …and a compilation under `SUSPECT_FLOOR` is left alone, because a real
    // poem in sections looks exactly like a small one.
    const small = raw({ verses: blobVerses(SUSPECT_FLOOR), poetName: "علي محمود طه" })
    expect(winnerOf([small, raw({ verses: longQasida(20), meter: "بحر الخفيف" })])).toBe(0)
  })

  it("collapses ا/أ, ة/ه and ى/ي spellings onto ONE dedup_key and ONE name_key", () => {
    const a = must(raw({ verses: ["أَبى الضَيمُ وَالفُؤادُ أَبى"], title: "إباء", poetName: "عنترة بن شداد" }))
    const b = must(raw({ verses: ["ابى الضيم والفؤاد ابى"], title: "اباء", poetName: "عنتره بن شداد" }))
    expect(a.dedupKey).toBe(b.dedupKey)
    expect(a.poet.nameKey).toBe(b.poet.nameKey)
    // …while the DISPLAY forms stay exactly as the corpus spelled them
    expect(a.poet.name).not.toBe(b.poet.name)
  })

  it("keeps the شاعر's own era, location and description on the poem's poet record", () => {
    const t = must(
      raw({
        verses: MUTANABBI,
        poetName: "المتنبي",
        poetEra: "العصر العباسي",
        poetLocation: "سوريا",
        poetDescription: "  أبو الطيّب\n أحمد بن الحسين   ",
      }),
    )
    expect(t.poet.eraSlug).toBe("abbasi")
    expect(t.eraSlug).toBe("abbasi")
    // design-server.md §4 misses the merge; shared/themes.ts does it
    expect(t.poet.location).toBe("سورية")
    expect(t.poet.description).toBe("أبو الطيّب أحمد بن الحسين")
  })

  it("uses the aldiwan poem id when there is one and nothing when there is not", () => {
    expect(must(raw({ verses: MUTANABBI, poemUrl: "https://www.aldiwan.net/poem16182.html" })).aldiwanId).toBe(16182)
    expect(must(raw({ verses: MUTANABBI, poemUrl: "https://www.poetsgate.com/ViewPoem.aspx?id=9" })).aldiwanId).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Vocabulary — always delegated, never reimplemented
// ═════════════════════════════════════════════════════════════════════════════

describe("transformPoem — vocabulary", () => {
  it("normalises the metre and peels its modifier into meter_variant", () => {
    const t = must(raw({ verses: MUTANABBI, meter: "بحر مجزوء الرمل " }))
    expect(t.meterSlug).toBe("ramal")
    expect(t.meterVariant).toBe("مجزوء")
    expect(t.meterUnmapped).toBeNull()
    expect(METERS_BY_SLUG.get(t.meterSlug!)!.kind).toBe("bahr")
  })

  it("treats «عامي» in the METRE column as the dialect marker it is", () => {
    const t = must(raw({ verses: MUTANABBI, meter: "عامي", langType: null }))
    expect(t.meterSlug).toBeNull()
    expect(t.langType).toBe("عامي")
    expect(t.meterUnmapped).toBeNull() // NOT an unmapped metre — the build asserts on those
  })

  it("collapses فصحى→فصيح and شعبي→عامي", () => {
    expect(must(raw({ verses: MUTANABBI, langType: "فصحى" })).langType).toBe("فصيح")
    expect(must(raw({ verses: MUTANABBI, langType: "شعبي" })).langType).toBe("عامي")
    expect(must(raw({ verses: MUTANABBI, langType: "-" })).langType).toBeNull()
  })

  it("maps the theme and the era through the shared tables", () => {
    const t = must(raw({ verses: MUTANABBI, theme: "قصيدة رثاء", poetEra: "قبل الإسلام" }))
    expect(t.themeSlug).toBe("ritha")
    expect(t.eraSlug).toBe("jahili") // absorbed by العصر الجاهلي
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Chain letters, hashes and buckets
// ═════════════════════════════════════════════════════════════════════════════

describe("transformPoem — بيت derivations", () => {
  it("derives first_letter from the صدر and both chain letters from the عجز", () => {
    const t = must(raw({ verses: MUTANABBI }))
    expect(t.baits[0]!.firstLetter).toBe("ع") // عَلى — no ال/و/ف stripping
    expect(t.baits[0]!.rawiyy).toBe("م")
    expect(t.baits[0]!.lastLetter).toBe("م")
    expect(t.firstLetter).toBe("ع")
  })

  it("stores the peeled الروي AND the literal final letter separately (amendment 1)", () => {
    // «اِرتَجي» peels ي → ج, so the two letters differ and the game accepts both
    const t = must(raw({ verses: ["وَلا زِلتُ أَرجو", "ما كُنتُ اِرتَجي"] }))
    expect(t.baits[0]!.rawiyy).toBe("ج")
    expect(t.baits[0]!.lastLetter).toBe("ي")
  })

  it("hashes the بيت with the SIGNED fnv1a64 node:sqlite will accept", () => {
    const t = must(raw({ verses: MUTANABBI }))
    const b = t.baits[0]!
    expect(b.hFull).toBe(fnv1a64Signed(normalizeArabic(`${MUTANABBI[0]} ${MUTANABBI[1]}`)))
    expect(b.hSadr).toBe(fnv1a64Signed(normalizeArabic(MUTANABBI[0]!)))
    expect(b.hFull!).toBeGreaterThanOrEqual(-(2n ** 63n))
    expect(b.hFull!).toBeLessThan(2n ** 63n)
  })

  it("indexes the NORMALISED بيت for FTS — both halves, one string", () => {
    const t = must(raw({ verses: MUTANABBI }))
    expect(t.baits[0]!.norm).toBe(normalizeArabic(`${MUTANABBI[0]} ${MUTANABBI[1]}`))
    expect(t.baits[0]!.norm).not.toContain("َ") // fatha is gone
  })

  it("derives bucket/rand from (dedup_key, position), never from a rowid (amendment 4)", () => {
    const t = must(raw({ verses: MUTANABBI, title: "على قدر", poetName: "المتنبي" }))
    for (const b of t.baits) {
      const h = fnv1a32(`${t.dedupKey}:${b.position}`)
      expect(b.rand).toBe(h)
      expect(b.bucket).toBe(h % BUCKETS)
      expect(b.bucket).toBeGreaterThanOrEqual(0)
      expect(b.bucket).toBeLessThan(BUCKETS)
    }
    // two أبيات of the same poem land in different buckets
    expect(t.baits[0]!.bucket).not.toBe(t.baits[1]!.bucket)
  })

  it("is deterministic: the same row transforms to the same buckets every time", () => {
    const p = raw({ verses: MUTANABBI, title: "على قدر", poetName: "المتنبي" })
    expect(must(p).baits.map((b) => [b.bucket, b.rand])).toEqual(must(p).baits.map((b) => [b.bucket, b.rand]))
  })

  it("flags a صدر that opens on a bare واو/فاء (amendment 5)", () => {
    expect(must(raw({ verses: MUTANABBI })).baits[1]!.opensConj).toBe(true) // وَتَعظُمُ
    expect(must(raw({ verses: MUTANABBI })).baits[0]!.opensConj).toBe(false) // عَلى
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// poems.rhyme
// ═════════════════════════════════════════════════════════════════════════════

describe("modalRawiyy", () => {
  it("picks the روي most of the أبيات share", () => {
    const r = modalRawiyy([{ rawiyy: "م" }, { rawiyy: "م" }, { rawiyy: "د" }])
    expect(r.rhyme).toBe("م")
    expect(r.share).toBeCloseTo(2 / 3)
  })

  it("breaks a tie in favour of بيت ١ (§6)", () => {
    expect(modalRawiyy([{ rawiyy: "د" }, { rawiyy: "م" }]).rhyme).toBe("د")
    expect(modalRawiyy([{ rawiyy: "م" }, { rawiyy: "د" }]).rhyme).toBe("م")
  })

  it("ignores أبيات with no روي, and answers null when none has one", () => {
    expect(modalRawiyy([{ rawiyy: null }, { rawiyy: "ل" }, { rawiyy: null }])).toEqual({ rhyme: "ل", share: 1 })
    expect(modalRawiyy([{ rawiyy: null }])).toEqual({ rhyme: null, share: 0 })
    expect(modalRawiyy([])).toEqual({ rhyme: null, share: 0 })
  })

  it("reports a LOW share rather than a wrong answer for a non-monorhyme form", () => {
    // موشحات / شعر حر are genuinely not monorhyme — 84.3% agreement corpus-wide
    const t = must(raw({ verses: ["أَلا يا صَبا", "نَجدٍ مَتى", "هِجتِ مِن", "نَجدِ الحِمى"] }))
    expect(t.rhyme).not.toBeNull()
    expect(t.rhymeShare).toBeLessThanOrEqual(1)
    expect(t.rhymeShare).toBeGreaterThan(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// has_tashkeel
// ═════════════════════════════════════════════════════════════════════════════

describe("tashkeelRatio / has_tashkeel", () => {
  it("is a ratio, not a count", () => {
    expect(tashkeelRatio(["على قدر أهل العزم تأتي العزائم"])).toBe(0)
    expect(tashkeelRatio(MUTANABBI)).toBeGreaterThan(TASHKEEL_THRESHOLD)
    expect(tashkeelRatio([])).toBe(0)
    expect(tashkeelRatio(["hello"])).toBe(0)
  })

  it("marks a vocalised poem and leaves a bare one alone", () => {
    expect(must(raw({ verses: MUTANABBI })).hasTashkeel).toBe(true)
    expect(must(raw({ verses: MUTANABBI.map((v) => v.replace(/[ً-ْ]/g, "")) })).hasTashkeel).toBe(false)
  })

  it("does not mark a long ديوان that carries three stray marks", () => {
    const bare = "على قدر أهل العزم تأتي العزائم وتأتي على قدر الكرام المكارم"
    const verses = Array.from({ length: 40 }, () => bare)
    verses[0] = "عَلى قَدر أهل العزم تأتي العزائم وتأتي على قدر الكرام المكارم"
    expect(tashkeelRatio(verses)).toBeLessThan(TASHKEEL_THRESHOLD)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Playability (amendment 3)
// ═════════════════════════════════════════════════════════════════════════════

describe("isPlayableBait", () => {
  const ok = {
    sadr: "عَلى قَدرِ أَهلِ العَزمِ تَأتي العَزائِمُ",
    ajuz: "وَتَأتي عَلى قَدرِ الكِرامِ المَكارِمُ",
    firstLetter: "ع",
    rawiyy: "م",
    lastLetter: "م",
    isPartial: false,
  }

  it("accepts a well-formed بيت", () => {
    expect(isPlayableBait(ok)).toBe(true)
  })

  it("measures length with the tashkeel off", () => {
    expect(bareLength("عَلى  قَدرِ")).toBe(bareLength("على قدر"))
    expect(bareLength("  على   قدر  ")).toBe("على قدر".length)
  })

  it("rejects a partial بيت and one with no عجز", () => {
    expect(isPlayableBait({ ...ok, isPartial: true })).toBe(false)
    expect(isPlayableBait({ ...ok, ajuz: null })).toBe(false)
  })

  it("rejects a بيت whose chain letters do not resolve", () => {
    expect(isPlayableBait({ ...ok, firstLetter: null })).toBe(false)
    expect(isPlayableBait({ ...ok, rawiyy: null })).toBe(false)
    expect(isPlayableBait({ ...ok, lastLetter: null })).toBe(false)
  })

  it("rejects hemistichs shorter than 12 or longer than 80 characters", () => {
    const short = "يا دار مي"
    expect(bareLength(short)).toBeLessThan(PLAYABLE.minHemistichChars)
    expect(isPlayableBait({ ...ok, sadr: short })).toBe(false)
    expect(isPlayableBait({ ...ok, ajuz: short })).toBe(false)
    const long = "ا".repeat(PLAYABLE.maxHemistichChars + 1)
    expect(isPlayableBait({ ...ok, sadr: long })).toBe(false)
  })

  it("rejects a tadwir split — one long line cut at a wild length ratio", () => {
    // «داجمعا» / «علينا فصرنا في انتهاز المثاني» is a real corpus row
    expect(
      isPlayableBait({ ...ok, sadr: "أصبح الملك للذي فطر الخلق العظيم الجليل", ajuz: "قَ بِتَقدير" }),
    ).toBe(false)
    // the ratio bound cuts both ways
    expect(
      isPlayableBait({ ...ok, sadr: "قَ بِتَقدير", ajuz: "أصبح الملك للذي فطر الخلق العظيم الجليل" }),
    ).toBe(false)
  })

  it("rejects scraper junk — latin text, digits and placeholder runs", () => {
    expect(isPlayableBait({ ...ok, sadr: "على قدر أهل العزم page 12" })).toBe(false)
    expect(isPlayableBait({ ...ok, ajuz: "وتأتي على قدر الكرام ٢٣٤٥" })).toBe(false)
    expect(isPlayableBait({ ...ok, ajuz: "وتأتي على قدر الكرام ***" })).toBe(false)
    expect(isPlayableBait({ ...ok, ajuz: "وتأتي على قدر الكرام ----" })).toBe(false)
  })

  it("agrees with the flag transformPoem writes", () => {
    const t = must(raw({ verses: MUTANABBI }))
    expect(t.baits.map((b) => b.playable)).toEqual([true, true])
    expect(t.baits[0]!.playable).toBe(isPlayableBait(t.baits[0]!))
  })
})
