/**
 * Normalization is the contract between the index and every query — kalam's
 * test file says it best, and it is even more true here, where the same
 * functions also decide which letter a مساجلة turns on. If `rawiyyOf` and the
 * client's letter indicator drift, the game rejects correct answers and no
 * test anywhere else notices: a wrong fold just returns zero hits.
 *
 * Golden tables only. Every worked example from design-server.md §2 is below,
 * every case ported from kalam's tests/test_normalize.py is below, and the
 * three peel refinements this project made are pinned with the corpus words
 * that forced them.
 */

import { describe, expect, it } from "vitest"

import {
  bareWords,
  baytKey,
  cleanText,
  findFolded,
  firstLetterOf,
  fnv1a32,
  fnv1a64,
  fnv1a64Signed,
  baitAnchor,
  foldLetter,
  foldLetters,
  foldQuery,
  foldedIndex,
  ftsQuery,
  ftsTermRecords,
  ftsTerms,
  normalizeArabic,
  PREFIX_MIN_LENGTH,
  STAR_TERM_CAP,
  opensConj,
  parseBaytKey,
  rawiyyOf,
  shuhraLetter,
  sortName,
  stripHonorifics,
  stripMarks,
  stripTashkeel,
} from "./arabic.ts"
import { HIJAI_LETTERS } from "./letters.ts"

// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeArabic — the kalam port", () => {
  it("strips tashkeel", () => {
    expect(normalizeArabic("الرَّحْمَٰنِ الرَّحِيمِ")).toBe("الرحمن الرحيم")
  })

  it("strips tatweel", () => {
    expect(normalizeArabic("الرحـــمن")).toBe("الرحمن")
  })

  it("strips Quranic annotation marks (U+06D6..U+06ED)", () => {
    expect(normalizeArabic("الحمدۖ لله")).toBe("الحمد لله")
  })

  it("folds every alef form", () => {
    for (const src of ["آ", "أ", "إ", "ٱ"]) expect(normalizeArabic(src), src).toBe("ا")
  })

  it("folds alef maqsura to ya", () => {
    expect(normalizeArabic("على")).toBe("علي")
  })

  it("folds ta marbuta to ha", () => {
    expect(normalizeArabic("الصلاة")).toBe("الصلاه")
  })

  it("folds the hamza carriers", () => {
    expect(normalizeArabic("مؤمن")).toBe("مومن")
    expect(normalizeArabic("سائل")).toBe("سايل")
  })

  it("leaves a bare hamza alone — people search for «ماء»", () => {
    expect(normalizeArabic("ماء")).toBe("ماء")
  })

  it("collapses whitespace", () => {
    expect(normalizeArabic("باب   الصلاة\n\tوالزكاة")).toBe("باب الصلاه والزكاه")
  })

  it("trims", () => {
    expect(normalizeArabic("  باب  ")).toBe("باب")
  })

  it("leaves Latin untouched", () => {
    expect(normalizeArabic("Sahih al-Bukhari")).toBe("Sahih al-Bukhari")
  })

  it("is idempotent — indexing normalizes once, ftsQuery may normalize twice", () => {
    const src = "قَالَ رَسُولُ اللَّهِ ﷺ إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ"
    const once = normalizeArabic(src)
    expect(normalizeArabic(once)).toBe(once)
  })

  it("applies NFKC — aldiwan's scrape is full of presentation forms", () => {
    // U+FEFB ARABIC LIGATURE LAM WITH ALEF decomposes to two real letters.
    expect(normalizeArabic("ﻻ")).toBe("لا")
    expect(normalizeArabic("ﷲ")).toBe("الله")
  })

  it("collapses a marks-only input to empty", () => {
    expect(normalizeArabic("ًٌٍَُِّْ")).toBe("")
  })

  it("survives null and undefined", () => {
    expect(normalizeArabic(null)).toBe("")
    expect(normalizeArabic(undefined)).toBe("")
  })
})

describe("stripTashkeel / stripMarks / foldLetters", () => {
  it("stripTashkeel keeps every letter and every punctuation mark", () => {
    expect(stripTashkeel("العَليمِ، وَالحَكيمِ")).toBe("العليم، والحكيم")
  })

  it("stripTashkeel does NOT fold — the peel rules need ة and ى intact", () => {
    expect(stripTashkeel("الصَلاةُ عَلى")).toBe("الصلاة على")
  })

  it("stripMarks reaches the extended annotation block too", () => {
    expect(stripMarks("الحمدٖࣤ لله")).toBe("الحمد لله")
  })

  it("foldLetters folds five carriers and nothing else", () => {
    expect(foldLetters("أإآٱ ى ة ؤ ئ ء")).toBe("اااا ي ه و ي ء")
  })
})

describe("cleanText — display text, tashkeel intact", () => {
  it("keeps the tashkeel it is handed", () => {
    expect(cleanText("العَليمِ")).toBe("العَليمِ")
  })

  it("normalises presentation forms and drops tatweel", () => {
    expect(cleanText("قـــال ﻻ")).toBe("قال لا")
  })

  it("collapses every kind of whitespace, NBSP included", () => {
    expect(cleanText("  بابُ   الصلاةِ\n\tوالزكاةِ ")).toBe("بابُ الصلاةِ والزكاةِ")
  })

  it("strips bidi controls and zero-width junk", () => {
    expect(cleanText("‏البيت‎")).toBe("البيت")
  })

  it("shaves scrape junk off both ends but keeps Arabic punctuation", () => {
    expect(cleanText("12. البيت |")).toBe("البيت")
    expect(cleanText("«البيت»")).toBe("«البيت»")
    expect(cleanText("- البيت،")).toBe("البيت،")
  })

  it("returns empty when nothing Arabic survives — the caller drops the row", () => {
    expect(cleanText("")).toBe("")
    expect(cleanText("   ")).toBe("")
    expect(cleanText("-")).toBe("")
    expect(cleanText("12345")).toBe("")
    expect(cleanText("hello")).toBe("")
    expect(cleanText(null)).toBe("")
  })

  it("is idempotent", () => {
    const src = "  ١٢- قـــالَ ﻻ يَنفَعُ ٱلنَدَمُ ! "
    const once = cleanText(src)
    expect(cleanText(once)).toBe(once)
  })
})

describe("foldLetter — the 28-letter chain alphabet", () => {
  it("is the identity on all 28", () => {
    for (const l of HIJAI_LETTERS) expect(foldLetter(l), l).toBe(l)
  })

  it("folds every hamza carrier to ألف — «الهمزات كلها ألف»", () => {
    for (const src of ["آ", "أ", "إ", "ٱ", "ء", "ؤ", "ئ"]) {
      expect(foldLetter(src), src).toBe("ا")
    }
  })

  it("folds ى to ي and ة to ه", () => {
    expect(foldLetter("ى")).toBe("ي")
    expect(foldLetter("ة")).toBe("ه")
  })

  it("answers null for anything that is not an Arabic letter", () => {
    for (const src of ["", " ", "a", "١", "،", "َ", null, undefined]) {
      expect(foldLetter(src), JSON.stringify(src)).toBeNull()
    }
  })

  it("PROPERTY: هجائي order is code-point order once folded", () => {
    // This is what lets `ORDER BY letter` in SQLite and the client's letter
    // rail agree without either of them carrying a collation table.
    const codes = HIJAI_LETTERS.map((l) => l.codePointAt(0)!)
    for (let i = 1; i < codes.length; i++) {
      expect(codes[i]! > codes[i - 1]!, `${HIJAI_LETTERS[i - 1]} < ${HIJAI_LETTERS[i]}`).toBe(true)
    }
    expect([...HIJAI_LETTERS].sort()).toEqual([...HIJAI_LETTERS])
  })
})

describe("firstLetterOf", () => {
  it("does NOT strip a leading ال / و / ف — مساجلة is played on the written letter", () => {
    expect(firstLetterOf("وَالشَمسُ تَجري")).toBe("و")
    expect(firstLetterOf("فَاِصبِر جَميلاً")).toBe("ف")
    expect(firstLetterOf("الشَمسُ تَجري")).toBe("ا")
  })

  it("folds the opening hamza", () => {
    expect(firstLetterOf("أَحمَدُ")).toBe("ا")
    expect(firstLetterOf("إِنَّ")).toBe("ا")
    expect(firstLetterOf("آمَنتُ")).toBe("ا")
  })

  it("skips leading punctuation, digits and Latin", () => {
    expect(firstLetterOf("«يا لَيلُ»")).toBe("ي")
    expect(firstLetterOf("1. مَن ذا")).toBe("م")
  })

  it("answers null when there is no Arabic letter at all", () => {
    expect(firstLetterOf("")).toBeNull()
    expect(firstLetterOf("hello")).toBeNull()
    expect(firstLetterOf(null)).toBeNull()
  })
})

describe("rawiyyOf — the golden table from design-server.md §2", () => {
  const golden: [string, string][] = [
    ["العَليمِ", "م"],
    ["المُتَبَلِجِ", "ج"],
    ["اِرتَجي", "ج"],
    ["يَدعو", "ع"],
    ["كِتابُهُ", "ب"],
    ["دَعا", "ع"],
    ["دَعَوا", "و"],
    ["شِفاهُ", "ه"],
    ["اللَّهُ", "ه"],
  ]

  for (const [ajuz, rawiyy] of golden) {
    it(`${ajuz} → ${rawiyy}`, () => {
      expect(rawiyyOf(ajuz).rawiyy).toBe(rawiyy)
    })
  }

  it("keeps the unpeeled letter alongside — amendment 1's «street rules»", () => {
    expect(rawiyyOf("اِرتَجي")).toEqual({ rawiyy: "ج", lastLetter: "ي" })
    expect(rawiyyOf("كِتابُهُ")).toEqual({ rawiyy: "ب", lastLetter: "ه" })
    expect(rawiyyOf("دَعَوا")).toEqual({ rawiyy: "و", lastLetter: "ا" })
    expect(rawiyyOf("العَليمِ")).toEqual({ rawiyy: "م", lastLetter: "م" })
  })

  it("stops the peel on واو الجماعة under an ألف الإطلاق", () => {
    // دَعَوا and يَدعو both end و-after-ع once the ألف is gone. The ألف is the
    // only thing that says which واو is a root letter, so it decides.
    expect(rawiyyOf("دَعَوا").rawiyy).toBe("و")
    expect(rawiyyOf("يَدعو").rawiyy).toBe("ع")
    expect(rawiyyOf("رَأَوا").rawiyy).toBe("و")
    expect(rawiyyOf("الدُنيا").rawiyy).toBe("ي")
  })

  it("peels at most twice: كِتابُها → كِتابُه → كِتاب", () => {
    expect(rawiyyOf("كِتابُها").rawiyy).toBe("ب")
  })

  it("never takes a word below two letters", () => {
    expect(rawiyyOf("ما").rawiyy).toBe("ا")
    expect(rawiyyOf("بِهِ").rawiyy).toBe("ه")
    expect(rawiyyOf("لَها").rawiyy).toBe("ه")
  })

  it("protects a root ه: اللهُ, وَجهُ, فِقهُ", () => {
    expect(rawiyyOf("اللَّهُ").rawiyy).toBe("ه")
    expect(rawiyyOf("وَجهُ").rawiyy).toBe("ه")
    expect(rawiyyOf("بِاللَّهِ").rawiyy).toBe("ه")
  })

  it("protects ه after a long vowel: شِفاهُ, إِليهِ", () => {
    expect(rawiyyOf("شِفاهُ").rawiyy).toBe("ه")
    expect(rawiyyOf("إِليهِ").rawiyy).toBe("ه")
  })

  it("peels a three-letter هاء الضمير — the §2 floor of 4 missed جَدُّهُ", () => {
    expect(rawiyyOf("جَدُّهُ").rawiyy).toBe("د")
    expect(rawiyyOf("مِنهُ").rawiyy).toBe("ن")
  })

  it("never peels تاء مربوطة — it is not a pronoun", () => {
    // «الأحبة» in a قافية تائية was coming out as a rhyme on الباء.
    expect(rawiyyOf("الأَحِبَّةِ")).toEqual({ rawiyy: "ه", lastLetter: "ه" })
    expect(rawiyyOf("الصَلاةُ").rawiyy).toBe("ه")
  })

  it("treats a hamza rhyme as ألف however it is written", () => {
    expect(rawiyyOf("الرَجاءِ").rawiyy).toBe("ا")
    expect(rawiyyOf("رَجائي").rawiyy).toBe("ا")
    expect(rawiyyOf("عَزائي").rawiyy).toBe("ا")
  })

  it("takes the last word, past punctuation and trailing junk", () => {
    expect(rawiyyOf("وَما نَيلُ المَطالِبِ بِالتَمَنّي!").rawiyy).toBe("ن")
    expect(rawiyyOf("تُؤخَذُ الدُنيا غِلابا …").rawiyy).toBe("ب")
    expect(rawiyyOf("البيتُ - 12").rawiyy).toBe("ت")
  })

  it("answers {null,null} for anything without an Arabic letter", () => {
    for (const src of [null, undefined, "", "   ", "***", "12 34"]) {
      expect(rawiyyOf(src), JSON.stringify(src)).toEqual({ rawiyy: null, lastLetter: null })
    }
  })
})

describe("opensConj", () => {
  it("sees a bare conjunction on the front of the صدر", () => {
    expect(opensConj("وَالشَمسُ تَجري")).toBe(true)
    expect(opensConj("فَاِصبِر جَميلاً")).toBe(true)
  })

  it("says no when the صدر opens on anything else", () => {
    expect(opensConj("قِفا نَبكِ")).toBe(false)
    expect(opensConj("")).toBe(false)
    expect(opensConj(null)).toBe(false)
  })

  it("says no to a one- or two-letter opening word", () => {
    expect(opensConj("وَ الشَمسُ")).toBe(false)
    expect(opensConj("في الدارِ")).toBe(false)
  })
})

describe("ftsQuery — the quoting trick", () => {
  it("quotes and ANDs bare words", () => {
    expect(ftsQuery("باب الصلاة")).toBe('"باب" "الصلاه"')
  })

  it("ORs in or-mode", () => {
    expect(ftsQuery("باب الصلاة", "or")).toBe('"باب" OR "الصلاه"')
  })

  it("keeps a double-quoted phrase as a phrase", () => {
    expect(ftsQuery('"طلب العلم"')).toBe('"طلب العلم"')
  })

  it("keeps a «guillemet» phrase as a phrase", () => {
    expect(ftsQuery("«طلب العلم»")).toBe('"طلب العلم"')
  })

  it("combines a phrase with bare words", () => {
    expect(ftsQuery('"طلب العلم" فريضة')).toBe('"طلب العلم" "فريضه"')
  })

  it("normalizes inside the phrase too", () => {
    expect(ftsQuery('"الصلاة"')).toBe('"الصلاه"')
  })

  it("returns empty for an empty or punctuation-only query", () => {
    // The caller MUST short-circuit on "" — an empty MATCH is a SQLite error,
    // not an empty result set.
    expect(ftsQuery("")).toBe("")
    expect(ftsQuery("   ")).toBe("")
    expect(ftsQuery("!!! ???")).toBe("")
    expect(ftsQuery(null)).toBe("")
  })

  const hostile = [
    "foo*", "foo:bar", "foo AND bar", "(foo OR bar)", "foo^2", 'foo"bar',
    "NEAR(a b)", "-foo", "foo-bar", "a OR b NOT c", "*", "\"", "))))",
  ]
  for (const q of hostile) {
    it(`no FTS5 operator escapes the quoting: ${JSON.stringify(q)}`, () => {
      const out = ftsQuery(q)
      // Strip every quoted span; whatever is left must be joiners and space.
      const residue = out.replace(/"[^"]*"/g, "").replace(/OR/g, "").trim()
      expect(residue, `unquoted residue in ${out}`).toBe("")
    })
  }

  it("caps a runaway query at 12 terms", () => {
    const q = Array.from({ length: 40 }, (_, i) => `كلمة${i}`).join(" ")
    expect(ftsTerms(q)).toHaveLength(12)
    expect(ftsQuery(q).split(" ")).toHaveLength(12)
  })
})

describe("ftsQuery — the trailing star (v2.md §2)", () => {
  it("ignores the star unless the caller opts in", () => {
    // Default OFF: every existing caller keeps the exact expression it had,
    // and a reader's `*` stays a literal character the quoting swallows.
    expect(ftsQuery("كتابه*")).toBe('"كتابه"')
    expect(ftsQuery("كتابه*", "and", { stars: true })).toBe('"كتابه"*')
  })

  it("puts the star OUTSIDE the quotes — FTS5's prefix operator", () => {
    expect(ftsQuery("قفا نبكي*", "and", { stars: true })).toBe('"قفا" "نبكي"*')
    expect(ftsQuery("قفا* نبكي", "and", { stars: true })).toBe('"قفا" "نبكي"')
  })

  it("stars only the words that carry one, in either mode", () => {
    expect(ftsQuery("غامرت* شرف", "or", { stars: true })).toBe('"غامرت"* OR "شرف"')
  })

  it("refuses a prefix shorter than PREFIX_MIN_LENGTH", () => {
    // «ال»* costs 2,058 ms on the real corpus — see PREFIX_MIN_LENGTH.
    expect(PREFIX_MIN_LENGTH).toBe(4)
    expect(ftsQuery("ال*", "and", { stars: true })).toBe('"ال"')
    expect(ftsQuery("الح*", "and", { stars: true })).toBe('"الح"')
    expect(ftsQuery("الحب*", "and", { stars: true })).toBe('"الحب"*')
  })

  it("only a TRAILING star is an operator", () => {
    // `a*b` sanitizes to one word, exactly as it did before stars existed.
    expect(ftsQuery("كتا*به", "and", { stars: true })).toBe('"كتابه"')
    expect(ftsQuery("*", "and", { stars: true })).toBe("")
    expect(ftsQuery("* *", "and", { stars: true })).toBe("")
  })

  it("survives punctuation glued after the star", () => {
    expect(ftsQuery("كتابه*،", "and", { stars: true })).toBe('"كتابه"*')
  })

  it("stars a phrase from outside its closing quote", () => {
    expect(ftsQuery('"طلب العلم"*', "and", { stars: true })).toBe('"طلب العلم"*')
    expect(ftsQuery('"طلب العلم"', "and", { stars: true })).toBe('"طلب العلم"')
  })

  it("measures the floor on the token the star expands, not on the whole phrase", () => {
    // FTS5 applies `*` to the LAST token of a phrase. Counting the whole term
    // let «"يا ا"*» through at four code points and scanned the one-letter
    // prefix «ا» — 19.8 s of blocked event loop on the real corpus, through one
    // unauthenticated GET /api/search.
    expect([..."يا ا"].length).toBe(PREFIX_MIN_LENGTH)
    expect(ftsQuery('"يا ا"*', "and", { stars: true })).toBe('"يا ا"')
    expect(ftsQuery('"في ال"*', "and", { stars: true })).toBe('"في ال"')
    // …and a phrase whose last token clears the floor still stars.
    expect(ftsQuery('"يا حبيب"*', "and", { stars: true })).toBe('"يا حبيب"*')
  })

  it("honours at most STAR_TERM_CAP stars in one query", () => {
    expect(STAR_TERM_CAP).toBe(2)
    const q = "الحب* قلبي* كانت* والم* فالم*"
    expect(ftsQuery(q, "or", { stars: true })).toBe('"الحب"* OR "قلبي"* OR "كانت" OR "والم" OR "فالم"')
    // The cap counts only the stars actually honoured: a term refused by the
    // length floor does not spend one.
    expect(ftsQuery("ال* الحب* قلبي* كانت*", "and", { stars: true })).toBe('"ال" "الحب"* "قلبي"* "كانت"')
  })

  it("normalizes the starred term exactly like the index", () => {
    // tashkeel and همزة spelling are gone before the star is attached
    expect(ftsQuery("الصَّلاة*", "and", { stars: true })).toBe('"الصلاه"*')
  })

  const hostile = ["foo*", "*foo*", "a OR b*", "NEAR(a b)*", '"*', "**", "-*"]
  for (const q of hostile) {
    it(`no operator escapes the quoting with stars on: ${JSON.stringify(q)}`, () => {
      const out = ftsQuery(q, "and", { stars: true })
      // Strip every quoted span AND the prefix operator that may follow one;
      // whatever is left must be joiners and space.
      const residue = out.replace(/"[^"]*"\*?/g, "").replace(/OR/g, "").trim()
      expect(residue, `unquoted residue in ${out}`).toBe("")
    })
  }
})

describe("ftsTermRecords / bareWords", () => {
  it("reports the star per term without leaving it in the term", () => {
    expect(ftsTermRecords("قفا نبكي*")).toEqual([
      { term: "قفا", starred: false },
      { term: "نبكي", starred: true },
    ])
  })

  it("ftsTerms is unchanged by the star", () => {
    expect(ftsTerms("قفا نبكي*")).toEqual(["قفا", "نبكي"])
  })

  it("bareWords strips what normalizeArabic keeps", () => {
    // the comma is neither a mark nor a letter, so `normalizeArabic` keeps it
    expect(normalizeArabic("اعبدُ الله ، خيرٌ")).toBe("اعبد الله ، خير")
    expect(bareWords("اعبدُ الله ، خيرٌ")).toBe("اعبد الله خير")
    expect(bareWords("  «قِفا»  نَبكِ…  ")).toBe("قفا نبك")
    expect(bareWords(null)).toBe("")
  })

  it("bareWords is idempotent — both sides of a prefix comparison run it", () => {
    const once = bareWords("إذا غامَرْتَ، في شرفٍ مَرومِ")
    expect(bareWords(once)).toBe(once)
  })
})

describe("baytKey", () => {
  it("round-trips", () => {
    expect(baytKey(1234, 7)).toBe("1234:7")
    expect(parseBaytKey("1234:7")).toEqual({ poemId: "1234", position: 7 })
    expect(parseBaytKey("q88231:0")).toEqual({ poemId: "q88231", position: 0 })
  })

  it("rejects nonsense", () => {
    expect(parseBaytKey("nope")).toBeNull()
    expect(parseBaytKey(":7")).toBeNull()
    expect(parseBaytKey("1234:x")).toBeNull()
  })
})

describe("fnv1a", () => {
  it("matches the published FNV-1a vectors", () => {
    expect(fnv1a32("")).toBe(2166136261)
    expect(fnv1a32("a")).toBe(0xe40c292c)
    expect(fnv1a32("abc")).toBe(0x1a47e90b)
    expect(fnv1a64("")).toBe(0xcbf29ce484222325n)
    expect(fnv1a64("a")).toBe(0xaf63dc4c8601ec8cn)
    expect(fnv1a64("abc")).toBe(0xe71fa2190541574bn)
  })

  it("hashes the UTF-8 bytes, so Arabic is stable across platforms", () => {
    expect(fnv1a32("الطويل")).toBe(fnv1a32("الطويل"))
    expect(fnv1a32("الطويل")).not.toBe(fnv1a32("الكامل"))
  })

  it("signs the 64-bit form for node:sqlite, which rejects anything wider", () => {
    const signed = fnv1a64Signed("abc")
    expect(signed).toBe(BigInt.asIntN(64, 0xe71fa2190541574bn))
    expect(signed).toBeLessThan(0n)
    expect(signed >= -(2n ** 63n) && signed < 2n ** 63n).toBe(true)
  })
})

describe("baitAnchor — what a ديوان stores instead of an id", () => {
  it("is exactly the hash the ingest writes into baits.h_full", () => {
    const sadr = "على قدر أهل العزم تأتي العزائم"
    const ajuz = "وتأتي على قدر الكرام المكارم"
    expect(baitAnchor(sadr, ajuz)).toBe(fnv1a64Signed(normalizeArabic(`${sadr} ${ajuz}`)).toString())
  })

  it("survives تشكيل, tatweel and spacing — the same بيت is the same anchor", () => {
    const a = baitAnchor("عَلى قَدرِ أَهلِ العَزمِ تَأتي العَزائِمُ", "وَتَأتي عَلى قَدرِ الكِرامِ المَكارِمُ")
    const b = baitAnchor("على  قدر أهل العزم تأتي العزائم ", "وتأتي على قدر الكرام المكارم")
    expect(a).toBe(b)
    expect(a).not.toBeNull()
  })

  it("is null for a بيت the scrape left without a عجز — there is nothing to anchor", () => {
    expect(baitAnchor("قفا نبك من ذكرى حبيب ومنزل", null)).toBeNull()
    expect(baitAnchor("قفا نبك من ذكرى حبيب ومنزل", "   ")).toBeNull()
  })

  it("is a DECIMAL STRING, because JSON has no 64-bit integer", () => {
    const anchor = baitAnchor("صدرٌ ما", "عجزٌ ما")!
    expect(typeof anchor).toBe("string")
    expect(anchor).toMatch(/^-?\d+$/)
    expect(BigInt(anchor)).toBe(fnv1a64Signed(normalizeArabic("صدرٌ ما عجزٌ ما")))
  })
})

describe("sortName / shuhraLetter", () => {
  it("files a poet under his شهرة, not under his ال", () => {
    expect(sortName("المتنبي")).toBe("متنبي")
    expect(shuhraLetter("المتنبي")).toBe("م")
    expect(shuhraLetter("الأخطل")).toBe("ا")
    expect(shuhraLetter("أبو تمام")).toBe("ا")
    expect(shuhraLetter("ابن الرومي")).toBe("ا")
  })

  it("does not eat a name that is only ال plus one letter", () => {
    expect(sortName("الا")).toBe("الا")
  })

  it("does not eat the ألف of إلياس — the article is never hamza-carrying", () => {
    // normalizeArabic folds إ → ا first, so the raw spelling is what decides.
    // Four شعراء were filed under الياء by the blind strip, «إلياس أبو شبكة»
    // (195 قصيدة) among them.
    expect(shuhraLetter("إلياس أبو شبكة")).toBe("ا")
    expect(shuhraLetter("إلياس بن المدور اليهودي")).toBe("ا")
    expect(shuhraLetter("آل ثاني")).toBe("ا")
    // …and the two copies the sources spell with a plain ألف are named
    expect(shuhraLetter("الياس فياض")).toBe("ا")
    expect(shuhraLetter("الياس إده")).toBe("ا")
    // while a real article on a word that merely starts with ياء still goes
    expect(shuhraLetter("الياسمين الدمشقي")).toBe("ي")
  })

  it("normalizes first, so the two spellings of أبو نواس group together", () => {
    expect(sortName("أبو نواس")).toBe(sortName("ابو نواس"))
  })

  it("survives empty input", () => {
    expect(sortName(null)).toBe("")
    expect(shuhraLetter("")).toBeNull()
  })
})

describe("sortName — honorifics (CLAUDE.md backlog: the شعراء index)", () => {
  it("files «أ.د/ مصطفى الشليح» under الميم, sort key and letter together", () => {
    expect(sortName("أ.د/ مصطفى الشليح")).toBe("مصطفي الشليح")
    expect(shuhraLetter("أ.د/ مصطفى الشليح")).toBe("م")
  })

  it("strips an initial glued straight onto the name with no space", () => {
    expect(sortName("أ.عبدالله بن يحي علي البت")).toBe("عبدالله بن يحي علي البت")
    expect(shuhraLetter("أ.عبدالله بن يحي علي البت")).toBe("ع")
  })

  it("strips the corpus's other abbreviations", () => {
    expect(shuhraLetter("د/ عبد العزيز الرنتيسي")).toBe("ع")
    expect(shuhraLetter("د/محمد رفعت الدومي")).toBe("م")
    expect(shuhraLetter("د. أحمد بن سعيد")).toBe("ا")
    // a lone letter needs no dot when it is an initial the corpus uses
    expect(shuhraLetter("الشيخة د خلدية آل خليفة")).toBe("خ")
  })

  it("strips the spelled-out titles", () => {
    expect(shuhraLetter("الدكتور جاسم الفهيد")).toBe("ج")
    expect(shuhraLetter("دكتور المعز عمر بخيت")).toBe("م")
    expect(shuhraLetter("الدكتورة سعاد الصباح")).toBe("س")
    expect(shuhraLetter("الشيخ محمد متولي الشعراوي")).toBe("م")
    expect(shuhraLetter("الأستاذ أبو الحسن الشيباني")).toBe("ا")
    expect(shuhraLetter("المهندس خالد الفيصل")).toBe("خ")
    expect(shuhraLetter("القاضي عبد الوهاب المالكي")).toBe("ع")
    expect(shuhraLetter("السيد عبد الله سالم")).toBe("ع")
  })

  it("peels a run of them, one token at a time", () => {
    expect(stripHonorifics("أ.د/ مصطفى الشليح")).toBe("مصطفى الشليح")
    expect(stripHonorifics("الأستاذ الدكتور محمد عبد الله")).toBe("محمد عبد الله")
  })

  it("KEEPS a title that is the شهرة — the one-token guard", () => {
    // «القاضي الفاضل» (685 قصيدة) is not a judge called الفاضل; the whole
    // phrase is the name, and filing him under الفاء hides him.
    expect(shuhraLetter("القاضي الفاضل")).toBe("ق")
    expect(shuhraLetter("القاضي عياض")).toBe("ق")
    expect(shuhraLetter("القاضي التنوخي")).toBe("ق")
    expect(shuhraLetter("السيد الحميري")).toBe("س")
    expect(shuhraLetter("الشيخ علوان")).toBe("ش")
  })

  it("never strips a name away to nothing", () => {
    expect(sortName("الشيخ")).toBe("شيخ")
    expect(sortName("د.")).toBe("د.")
    expect(stripHonorifics("أ.")).toBe("أ.")
  })

  it("leaves an ordinary name exactly as it was", () => {
    for (const name of [
      "المتنبي", "أبو تمام", "ابن الرومي", "إلياس أبو شبكة", "الياسمين الدمشقي",
      "محمود درويش", "بدر شاكر السياب", "أ", "شاعر مجهول",
    ]) {
      expect(stripHonorifics(name), name).toBe(name)
    }
  })
})

describe("foldedIndex — matches reported in ORIGINAL offsets", () => {
  const source = "قالَ رَسولُ اللَّهِ: الصَلاةُ نورٌ"

  it("folds for matching but never materialises the fold in place", () => {
    const idx = foldedIndex(source)
    expect(idx.folded).toBe("قال رسول الله: الصلاه نور")
    expect(idx.source).toBe(source)
    expect(idx.starts).toHaveLength(idx.folded.length)
    expect(idx.ends).toHaveLength(idx.folded.length)
  })

  it("finds a query typed without tashkeel and points back at the real text", () => {
    const [hit] = findFolded(source, "الصلاة")
    expect(hit).toBeDefined()
    expect(source.slice(hit!.start, hit!.end)).toBe("الصَلاةُ".slice(0, -1))
  })

  it("finds a query typed WITH different orthography", () => {
    expect(findFolded(source, "الصلاه")).toHaveLength(1)
    expect(findFolded(source, "رسول")).toHaveLength(1)
  })

  it("collapses whitespace on both sides — a line break must match a space", () => {
    const wrapped = "قالَ\n   رَسولُ"
    const [hit] = findFolded(wrapped, "قال رسول")
    expect(hit).toBeDefined()
    // The hit stops at the ل — the trailing ضمة is past the end of the needle.
    expect(wrapped.slice(hit!.start, hit!.end)).toBe("قالَ\n   رَسول")
  })

  it("does not overlap matches", () => {
    expect(findFolded("aaaa", "aa")).toHaveLength(2)
  })

  it("treats a marks-only query as no query, not as a match everywhere", () => {
    expect(foldQuery("ًٌٍَُِّْ")).toBe("")
    expect(findFolded(source, "ًٌٍَُِّْ")).toEqual([])
    expect(findFolded(source, "")).toEqual([])
  })

  it("respects the limit", () => {
    expect(findFolded("ا ا ا ا ا", "ا", 2)).toHaveLength(2)
  })
})
