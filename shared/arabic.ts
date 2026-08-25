/**
 * قريض — the ONE Arabic text layer.
 *
 * Load-bearing invariant (CLAUDE.md, design-ux.md §0): this file is the only
 * normalizer in the project. The FTS index, the روي derivation at ingest, the
 * `dedup_key`, the server's chain-letter authority, the client's live letter
 * indicator and the search highlighter all call these functions. A second copy
 * of "strip tashkeel" anywhere else is a bug, not an optimisation — the index
 * and the query would silently collapse to different forms and search would
 * return nothing with no error to catch it.
 *
 * Two different foldings live here on purpose:
 *   · `normalizeArabic` — the kalam port. Index/query form. Folds أإآٱ→ا, ى→ي,
 *     ة→ه, ؤ→و, ئ→ي but LEAVES a bare ء alone, because a standalone hamza is a
 *     word people search for.
 *   · `foldLetter` — the 28-letter alphabet. Chain form. Also folds ء→ا,
 *     because «الهمزات كلها ألف» is the rule of the مساجلة: a بيت ending on
 *     ماءُ answers one ending on سماءِ.
 */

import { HIJAI_LETTERS } from "./letters.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Character classes
// ─────────────────────────────────────────────────────────────────────────────

/** Arabic letters proper: ء..غ, ف..ي, plus alef wasla ٱ. Excludes marks. */
const ARABIC_LETTER_RE = /[ء-غف-يٱکی]/

/** §2 step 6's liveness test: does the string carry a real Arabic letter? */
const HAS_ARABIC_RE = /[ء-غف-ي]/

/**
 * Tashkeel as design-ux.md §0 defines it: harakat + shadda + sukun + maddah
 * (U+064B–U+0655), the dagger alef, the Quranic annotation block, tatweel, and
 * the zero-width/bidi run that aldiwan's HTML scraping leaves behind.
 */
const TASHKEEL_RE = /[\u064B-\u0655\u0670\u06D6-\u06ED\u0640\u200B-\u200F]/g

/**
 * The wider mark set kalam's `_DIACRITICS` strips — everything TASHKEEL_RE
 * removes plus U+0656–U+065F (the modern Quranic annotation additions) and the
 * Arabic Extended-A mark block U+08E3–U+08FF. `normalizeArabic` uses this one;
 * `stripTashkeel` uses the narrower display-safe one.
 */
const MARKS_RE = /[\u0640\u064B-\u065F\u0670\u06D6-\u06ED\u08E3-\u08FF]/g

/** Bidi controls, zero-width joiners and the BOM. Never carry meaning here. */
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/** Arabic punctuation `cleanText` is allowed to keep at a string's edges. */
const EDGE_KEEP_RE =
  /[\u0621-\u063A\u0641-\u064A\u0671\u064B-\u0655\u0670\u06D6-\u06ED\u060C\u061B\u061F\u066A-\u066D\u06D4\u00AB\u00BB]/

/** Whitespace of every flavour, NBSP and the Arabic-friendly spaces included. */
const WS_RE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g

export function isArabicLetter(ch: string): boolean {
  return ARABIC_LETTER_RE.test(ch)
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripping and folding
// ─────────────────────────────────────────────────────────────────────────────

/** Remove tashkeel, tatweel and invisibles; keep every letter and punctuation. */
export function stripTashkeel(s: string): string {
  return s.replace(TASHKEEL_RE, "")
}

/** kalam's wider mark strip — tashkeel plus the extended annotation blocks. */
export function stripMarks(s: string): string {
  return s.replace(MARKS_RE, "")
}

/**
 * The orthographic folds every Arabic search box in the world applies, over a
 * whole string. Bare ء is deliberately NOT folded here (see the file header).
 */
export function foldLetters(s: string): string {
  let out = ""
  for (const ch of s) out += STRING_FOLD[ch] ?? ch
  return out
}

const STRING_FOLD: Readonly<Record<string, string>> = {
  "آ": "ا", // آ  alef madda
  "أ": "ا", // أ  alef hamza above
  "إ": "ا", // إ  alef hamza below
  "ٱ": "ا", // ٱ  alef wasla
  "ى": "ي", // ى  alef maksura
  "ی": "ي", // ی  farsi yeh
  "ة": "ه", // ة  teh marbuta
  "ۀ": "ه", // ۀ  heh with yeh above
  "ؤ": "و", // ؤ  waw hamza
  "ئ": "ي", // ئ  yeh hamza
  "ک": "ك", // ک  keheh
}

/**
 * One character → one of the 28 هجائي letters, or `null` if it is not a letter.
 *
 * This is the chain alphabet: it folds every hamza carrier AND the bare ء down
 * to ا, ة to ه, ى/ئ to ي, ؤ to و. `firstLetterOf` and `rawiyyOf` both end here,
 * which is why the game's «عندك» indicator and the server's `first_letter`
 * column can never disagree.
 */
export function foldLetter(ch: string | null | undefined): string | null {
  if (!ch) return null
  const c = ch.length === 1 ? ch : [...ch][0]
  if (!c) return null
  const folded = LETTER_FOLD[c] ?? c
  return HIJAI_LOOKUP.has(folded) ? folded : null
}

const LETTER_FOLD: Readonly<Record<string, string>> = {
  ...STRING_FOLD,
  // Every hamza is one letter for the chain. design-server.md §2 folds ؤ→و and
  // ئ→ي here, following normalizeArabic; the corpus says otherwise and so
  // does design-ux.md §4, whose own on-screen clause is «الهمزات كلها ألف».
  // A قصيدة همزية rhymes رَجائي with الرَجاءِ and the poet did not think
  // one ended on ياء; splitting them cost 173 of the 354 disagreements measured
  // over data/sample-2000.jsonl. This is the CHAIN alphabet only — `foldLetters`
  // and therefore the FTS index keep kalam's ؤ→و / ئ→ي exactly as they were.
  "ء": "ا", // ء  bare hamza
  "ؤ": "ا", // ؤ  waw hamza
  "ئ": "ا", // ئ  yeh hamza
}

const HIJAI_LOOKUP: ReadonlySet<string> = new Set<string>(HIJAI_LETTERS)

// ─────────────────────────────────────────────────────────────────────────────
// The two text transforms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `cleanText(s)` — for text we are going to DISPLAY. Keeps tashkeel; the
 * poem page's «تشكيل» toggle is what removes it later, and only in the client.
 *
 * design-server.md §2:
 *   1. NFKC — aldiwan's HTML carries presentation forms (ﻻ, ﷲ, ﷺ)
 *   2. drop bidi controls / zero-width / BOM / soft hyphen
 *   3. drop tatweel
 *   4. every kind of whitespace → one space, collapsed and trimmed
 *   5. trim leading/trailing runs of characters that are neither Arabic letters
 *      nor Arabic punctuation (scrape junk: «)»، `1.`، `-`، `|`)
 *   6. no Arabic letter left → "" and the caller drops the row
 *
 * Deviation from the literal wording of §5, deliberate: tashkeel marks count as
 * "keep" characters at the edges too. Without that, `cleanText("العَليمِ")`
 * would eat the final kasra, and the whole point of this function is that it is
 * the one transform which does NOT touch tashkeel.
 */
export function cleanText(s: string | null | undefined): string {
  if (s === null || s === undefined) return ""
  let t = s.normalize("NFKC")
  t = t.replace(INVISIBLE_RE, "")
  t = t.replace(/\u0640/g, "")
  t = t.replace(WS_RE, " ").trim()
  if (t === "") return ""

  const chars = [...t]
  let start = 0
  let end = chars.length
  while (start < end && !EDGE_KEEP_RE.test(chars[start]!)) start++
  while (end > start && !EDGE_KEEP_RE.test(chars[end - 1]!)) end--
  t = chars.slice(start, end).join("").trim()

  if (!HAS_ARABIC_RE.test(t)) return ""
  return t
}

/**
 * `normalizeArabic(s)` — the index/query form. A direct port of kalam's
 * `ingest/normalize.py::normalize_arabic`, plus the NFKC pass design-server.md
 * §2 adds (kalam's corpus is already normalised; aldiwan's is not).
 *
 * Lossy on purpose and idempotent by construction: indexing normalises once,
 * `ftsQuery` may normalise twice, and both sides must land on the same string.
 */
export function normalizeArabic(s: string | null | undefined): string {
  if (s === null || s === undefined) return ""
  let t = s.normalize("NFKC")
  t = t.replace(INVISIBLE_RE, "")
  t = t.replace(MARKS_RE, "")
  t = foldLetters(t)
  return t.replace(WS_RE, " ").trim()
}

/** design-ux.md §0 spells this one `normalize`. Same function, one source. */
export const normalize = normalizeArabic

// ─────────────────────────────────────────────────────────────────────────────
// Chain letters — the spine of the مساجلة
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The letter a بيت STARTS on: the player's answer must open with this.
 *
 * design-server.md §2 is explicit that we do NOT strip a leading ال / و / ف —
 * مساجلة is played on the written letter, and «والشمسُ» opens with واو.
 */
export function firstLetterOf(text: string | null | undefined): string | null {
  const n = normalizeArabic(text)
  for (const ch of n) {
    const f = foldLetter(ch)
    if (f !== null) return f
  }
  return null
}

/** design-ux.md §0 spells this one `firstChainLetter`. */
export const firstChainLetter = firstLetterOf

export interface RawiyyResult {
  /** الروي — the rhyme consonant after peeling وصل/إطلاق. Facets use this. */
  rawiyy: string | null
  /** The literal final letter, unpeeled. "Street rules" (amendment 1). */
  lastLetter: string | null
}

/**
 * Words whose final ه is a root letter, not a pronoun — peeling it would turn
 * a قافية هائية into something else. اللهُ is the one that matters most: half
 * the دواوين end a بيت on it and the ه is unmistakably the روي.
 *
 * Stored folded (`foldLetters`) so membership survives أ/ا and ة/ه spellings.
 */
export const HA_ROOT_WORDS: ReadonlySet<string> = new Set(
  [
    "الله", "اله", "لله", "بالله", "والله", "تالله", "فالله", "للاله", "اللهم",
    "وجه", "وجوه", "اوجه", "بوجه", "فقه", "شبه", "اشباه", "سفه", "وله", "فوه",
    "افواه", "شفه", "مياه", "جاه", "تيه", "نزه", "كره", "بله", "دهه", "نبه",
    "امه", "فقيه", "سفيه", "وجيه", "شبيه",
  ].map((w) => foldLetters(w)),
)

/**
 * `rawiyyOf(ajuz)` → {rawiyy, lastLetter} — design-server.md §2, with the one
 * refinement the doc's own golden table forces.
 *
 * The doc gives «دَعَوا → و» and «يَدعو → ع». Both words end, after one peel,
 * on a واو preceded by عين; nothing about the peeled word tells them apart. The
 * ألف is what does: an ألف الإطلاق sitting on top of a واو الجماعة means the
 * واو is the last consonant of the word and therefore the روي. So: after
 * peeling a trailing ا/ى, if the letter now exposed is و or ي, stop. Every
 * other golden example is unaffected, and the pair now both come out right.
 *
 * The peel is capped at two iterations (كِتابُها → كِتابُه → كِتاب) and never
 * takes a word below two letters.
 */
export function rawiyyOf(ajuz: string | null | undefined): RawiyyResult {
  const none: RawiyyResult = { rawiyy: null, lastLetter: null }
  if (ajuz === null || ajuz === undefined) return none

  // 1. tashkeel + tatweel out, NO folding yet — the peel rules read ة vs ه and
  //    ى vs ي, and folding first would erase exactly those distinctions.
  const bare = stripTashkeel(ajuz.normalize("NFKC"))

  // 2 + 3. last whitespace-delimited token that carries Arabic letters, with
  //        its punctuation shaved off both ends.
  let w = ""
  const tokens = bare.split(WS_RE)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const letters = [...tokens[i]!].filter(isArabicLetter).join("")
    if (letters.length > 0) {
      w = letters
      break
    }
  }
  if (w === "") return none

  // 4. the literal ending, before any peeling
  const lastLetter = foldLetter(w[w.length - 1]!)

  // 5. peel وصل / إطلاق
  let peeledVowel = false
  for (let iter = 0; iter < 2; iter++) {
    const len = w.length
    const last = w[len - 1]!

    // (a) هاء الضمير — but not after a long vowel (شِفاهُ), and not in a word
    //     whose ه is root (اللَّهُ).
    //
    //     Two departures from design-server.md §2, both measured against
    //     data/sample-2000.jsonl:
    //     · ة is NEVER peeled. The pronoun suffix is هاء; تاء مربوطة is not a
    //       suffix at all, it is the word's own last letter, and peeling it
    //       turned «الأحبة» in a قافية تائية into a rhyme on الباء.
    //     · the length floor is 3, not 4. جَدُّهُ / حَدُّهُ / بَدُّهُ are three
    //       letters with an unmistakable pronoun on the end, and the 4-floor
    //       left every one of them unpeeled.
    if (last === "ه" && len >= 3) {
      const prev = w[len - 2]!
      if (prev !== "ا" && prev !== "و" && prev !== "ي" && !HA_ROOT_WORDS.has(foldLetters(w))) {
        w = w.slice(0, -1)
        continue
      }
      break
    }

    // (b) ألف/ياء/واو of إطلاق — at most one of them.
    if ((last === "ا" || last === "ى" || last === "و" || last === "ي") && len >= 3) {
      if (peeledVowel) break
      w = w.slice(0, -1)
      peeledVowel = true
      if (last === "ا" || last === "ى") {
        const exposed = w[w.length - 1]!
        // واو الجماعة / ياء under an ألف الإطلاق: that letter IS the روي.
        if (exposed === "و" || exposed === "ي") break
      }
      continue
    }

    break // (c)
  }

  return { rawiyy: foldLetter(w[w.length - 1]!), lastLetter }
}

/** design-ux.md §0 spells this one `lastChainLetter` and returns just the روي. */
export function lastChainLetter(ajuz: string | null | undefined): string | null {
  return rawiyyOf(ajuz).rawiyy
}

/**
 * Does this صدر open on a bare conjunction واو/فاء? (amendment 5's
 * `opens_conj` column.) A بيت that starts «وَ…» is a soft target — almost any
 * chain can reach it — so `tailBias:'hard'` prefers replies that do not.
 *
 * Heuristic and known to be one: وَجه and فَتى look identical to a machine. The
 * cost of a false positive is a marginally easier opponent, which is why this
 * is a ranking hint and never a filter.
 */
export function opensConj(sadr: string | null | undefined): boolean {
  const n = normalizeArabic(sadr)
  if (n === "") return false
  const first = n.split(" ")[0] ?? ""
  const letters = [...first].filter(isArabicLetter)
  if (letters.length < 3) return false // و + a two-letter word at minimum
  return letters[0] === "و" || letters[0] === "ف"
}

// ─────────────────────────────────────────────────────────────────────────────
// FTS5
// ─────────────────────────────────────────────────────────────────────────────

/** design-server.md §2: no query ever emits more than this many terms. */
export const FTS_TERM_CAP = 12

const PHRASE_RE = /"([^"]+)"|«([^»]+)»/g

/**
 * The terms of an FTS5 MATCH expression, normalised exactly like the index and
 * with every operator character already gone. Phrases keep their internal
 * spaces; bare words are single tokens.
 */
export function ftsTerms(q: string | null | undefined, cap = FTS_TERM_CAP): string[] {
  return ftsTermRecords(q, cap).map((t) => t.term)
}

/** One term of a MATCH expression, plus whether the reader starred it. */
export interface FtsTermRecord {
  term: string
  /** the reader typed a trailing `*` on this word — «كتاب*» */
  starred: boolean
}

/** A trailing `*`, with any punctuation that trailed it — «كتاب*،». */
const STAR_TAIL_RE = /\*[^\p{L}\p{N}]*$/u

/**
 * `ftsTerms` with the star kept. Split out rather than inlined because the star
 * has to be read off the RAW word: `sanitizeTerm` turns `*` into a space (that
 * is the whole security model), so by the time a term exists the mark is gone.
 */
export function ftsTermRecords(q: string | null | undefined, cap = FTS_TERM_CAP): FtsTermRecord[] {
  if (!q) return []
  const terms: FtsTermRecord[] = []

  PHRASE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PHRASE_RE.exec(q)) !== null) {
    const phrase = sanitizeTerm(normalizeArabic(m[1] ?? m[2] ?? ""))
    // «عبارة»* — the star sits after the closing quote, which the capture
    // groups do not reach.
    if (phrase !== "") terms.push({ term: phrase, starred: q[m.index + m[0].length] === "*" })
  }

  const remainder = q.replace(PHRASE_RE, " ")
  for (const word of normalizeArabic(remainder).split(" ")) {
    const t = sanitizeTerm(word).replace(/\s+/g, "")
    if (t !== "") terms.push({ term: t, starred: STAR_TAIL_RE.test(word) })
  }

  return terms.slice(0, cap)
}

/** Anything that is not a letter, a digit or a space is not part of a term. */
function sanitizeTerm(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()
}

/**
 * Normalised text reduced to bare words — `normalizeArabic` plus the strip
 * `ftsTerms` applies per term, without the tokenising.
 *
 * `normalizeArabic` keeps punctuation (it folds letters and drops marks, and a
 * comma is neither), so «اعبد الله ، خير من حياتي» normalises with the comma
 * still in it and a prefix comparison against typed text — which arrives
 * without one — fails on a بيت that is otherwise a perfect match. 33 of the
 * 19,664 مطالع on ألف carry such a mark. Both sides of a prefix comparison go
 * through this, and it stays in `shared/arabic.ts` for the usual reason: a
 * second spelling of "strip what is not a word" is a bug (CLAUDE.md invariant).
 */
export function bareWords(s: string | null | undefined): string {
  return sanitizeTerm(normalizeArabic(s))
}

/**
 * How long a starred term must be before the star is honoured.
 *
 * A prefix query costs FTS5 the MERGED doclist of every term that starts with
 * it, and the merge happens before `LIMIT` and before `bm25()` can rank
 * anything — so the price is set by the prefix, not by the answer. Measured on
 * data/qarid.db (3.37M أبيات), ranked, `LIMIT 400`: «الذي»* 41 ms · «الحب»* 30 ms
 * · «قلبي»* 21 ms · «كانت»* 15 ms, all four ≤ 41 ms; but «الح»* 141 ms, «الذ»*
 * 58 ms, and at two letters «ال»* is **2,058 ms** — two seconds of a blocked
 * event loop (every SQLite call is synchronous, CLAUDE.md) for one keystroke.
 * Four characters is where the cliff ends, so a shorter starred word is
 * searched as the whole word it is: «ال*» finds «ال», not every ألف لام.
 */
export const PREFIX_MIN_LENGTH = 4

/**
 * How many terms of ONE query may carry a prefix star.
 *
 * `PREFIX_MIN_LENGTH` bounds what a single star costs; nothing bounded how
 * MANY of them a 200-character query could buy, and the price is strictly
 * additive because each star is its own doclist merge. Measured on
 * data/qarid.db: «الما»* 70 ms · plus «الحا»* 110 ms · plus «الوا»* 141 ms, and
 * twelve legal four-letter starred words — well inside `FTS_TERM_CAP` and the
 * 200-character cap — cost **594 ms** on an anonymous `GET /api/search`. Two is
 * what a reader actually types («ابن* المعت*»); every later star is dropped and
 * the word is searched whole, exactly as a too-short one is.
 */
export const STAR_TERM_CAP = 2

/** The token FTS5's `*` will actually expand: the LAST word of the term.
 *
 * A phrase term keeps its internal spaces («"طلب العلم"*»), and FTS5 applies
 * the prefix operator to the last token of the phrase only — so measuring the
 * floor against the whole term let `"يا ا"*` through at four code points and
 * scanned the one-letter prefix «ا»: 19.8 SECONDS on the real corpus through
 * one unauthenticated GET. The guard has to measure what the star expands.
 */
function starredToken(term: string): string {
  const i = term.lastIndexOf(" ")
  return i === -1 ? term : term.slice(i + 1)
}

export interface FtsQueryOptions {
  /**
   * Honour an explicit trailing `*` (v2.md §2's wildcard). OFF by default: a
   * caller opts in only where it has measured what a prefix scan costs it.
   */
  stars?: boolean
}

/**
 * `ftsQuery(q, mode)` — kalam's `fts_query`, port and contract both.
 *
 * The quoting trick is the whole security model: EVERY term is wrapped in
 * double quotes, so `AND`, `OR`, `NOT`, `NEAR`, `*`, `^`, `:` and `-` reach
 * SQLite as literal words instead of as syntax. A user typing `NEAR(a b)`
 * searches for the words NEAR, a and b; they do not get a MATCH syntax error
 * and they do not get to reinterpret the query.
 *
 * `{stars: true}` (v2.md §2) adds the ONE piece of syntax a reader may have:
 * a trailing `*` becomes FTS5's prefix operator, emitted OUTSIDE the quotes as
 * `"كتاب"*`. Everything else stays literal — the star is read off the raw word
 * by `ftsTermRecords`, never left in the term, so `a*b` is still the word
 * «ab» and a lone `*` is still nothing at all.
 *
 * Returns "" when nothing survives — design-server.md §2's "return [] without
 * touching SQLite". Callers MUST short-circuit on the empty string; handing an
 * empty MATCH expression to FTS5 is an error, not an empty result set.
 */
export function ftsQuery(
  q: string | null | undefined,
  mode: "and" | "or" = "and",
  opts: FtsQueryOptions = {},
): string {
  const terms = ftsTermRecords(q)
  if (terms.length === 0) return ""
  const stars = opts.stars === true
  let spent = 0
  const parts = terms.map((t) => {
    const honour =
      stars && t.starred && spent < STAR_TERM_CAP && [...starredToken(t.term)].length >= PREFIX_MIN_LENGTH
    if (!honour) return `"${t.term}"`
    spent += 1
    return `"${t.term}"*`
  })
  return parts.join(mode === "or" ? " OR " : " ")
}

// ─────────────────────────────────────────────────────────────────────────────
// Keys and hashes
// ─────────────────────────────────────────────────────────────────────────────

/** The stable identity of a بيت across favourites, duels and drill cards. */
export function baytKey(poemId: number | string, position: number): string {
  return `${poemId}:${position}`
}

export function parseBaytKey(key: string): { poemId: string; position: number } | null {
  const i = key.lastIndexOf(":")
  if (i <= 0) return null
  const position = Number(key.slice(i + 1))
  if (!Number.isInteger(position)) return null
  return { poemId: key.slice(0, i), position }
}

const FNV32_OFFSET = 2166136261
const FNV32_PRIME = 16777619
const FNV64_OFFSET = 0xcbf29ce484222325n
const FNV64_PRIME = 0x100000001b3n
const U64 = 0xffffffffffffffffn

const encoder = new TextEncoder()

/** FNV-1a over the UTF-8 bytes → unsigned 32-bit. Used for `bucket` and seeds. */
export function fnv1a32(s: string): number {
  const bytes = encoder.encode(s)
  let h = FNV32_OFFSET >>> 0
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!
    h = Math.imul(h, FNV32_PRIME) >>> 0
  }
  return h >>> 0
}

/**
 * FNV-1a 64 → UNSIGNED BigInt. `h_full` / `h_sadr` are the exact-match keys the
 * duel's verifier hits first, so they have to be wide enough that 3.86M أبيات
 * do not collide.
 */
export function fnv1a64(s: string): bigint {
  const bytes = encoder.encode(s)
  let h = FNV64_OFFSET
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i]!)) & U64
    h = (h * FNV64_PRIME) & U64
  }
  return h
}

/**
 * The same hash as a SIGNED 64-bit BigInt — the only form `node:sqlite` will
 * accept in an INTEGER column. Anything above 2^63−1 is rejected outright, so
 * every write of `h_full`/`h_sadr` and every lookup of them goes through here.
 */
export function fnv1a64Signed(s: string): bigint {
  return BigInt.asIntN(64, fnv1a64(s))
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The شهرة sort key: strip the honorifics a source glued onto the front, then
 * normalise, then drop a leading ال so المتنبي files under الميم and الأخطل
 * under الألف — which is where a reader looks for them.
 *
 * The server groups `poets.letter` by `firstLetterOf(sortName(name))` and the
 * client's letter rail does the same call. They must not drift, which is why
 * the client imports this rather than doing its own `slice(2)`.
 *
 * `poets.letter` AND `poets.sort_key` are both derived from this function at
 * ingest (`transform.ts`), so changing what it strips desyncs the artefact from
 * the code until the next rebuild. Never ship a change here without one.
 */
export function sortName(name: string | null | undefined): string {
  const bare = stripHonorifics(name)
  const n = normalizeArabic(bare)
  if (n === "") return ""
  if (n.startsWith("ال") && n.length > 3 && !startsWithHamzaAlef(bare) && !NOT_ARTICLE.has(firstWordOf(n))) {
    return n.slice(2)
  }
  return n
}

/**
 * Is the first letter of the RAW name a hamza-carrying ألف?
 *
 * `normalizeArabic` folds إ/أ/آ → ا before `sortName` ever sees the name, so
 * «إلياس أبو شبكة» arrives as «الياس ابو شبكة» and the blind prefix strip eats a
 * definite article that was never there — filing a canonical Mahjar شاعر under
 * الياء, where no reader will look. The definite article is ALWAYS a plain ألف
 * (or ٱ, the wasla, which is also not hamza-carrying), so the raw spelling
 * settles it whenever the source kept the hamza.
 */
function startsWithHamzaAlef(raw: string | null | undefined): boolean {
  for (const ch of raw ?? "") {
    if (!isArabicLetter(ch)) continue
    return ch === "أ" || ch === "إ" || ch === "آ"
  }
  return false
}

/**
 * Names whose «ال» is not the article and which the source spells with a plain
 * ألف, so `startsWithHamzaAlef` cannot see it. Matched as a WHOLE first word —
 * «الياسمين» keeps its article, «الياس فياض» does not.
 *
 * Four شعراء in the artefact carry this name; two spell it «إلياس» and are
 * recovered by the raw hamza, two spell it «الياس» and need naming here.
 */
const NOT_ARTICLE: ReadonlySet<string> = new Set(["الياس"])

function firstWordOf(norm: string): string {
  const space = norm.indexOf(" ")
  return space === -1 ? norm : norm.slice(0, space)
}

// ─────────────────────────────────────────────────────────────────────────────
// Honorifics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Titles the sources glue onto a شاعر's name, in `normalizeArabic` form — that
 * is the shape `stripLeadingHonorific` compares a token in, so ة/ه and أ/ا
 * spellings are already folded together and «الدكتورة» is spelt «الدكتوره».
 */
const HONORIFIC_WORDS: ReadonlySet<string> = new Set([
  "الدكتور", "الدكتوره", "دكتور", "دكتوره",
  "الاستاذ", "الاستاذه", "استاذ", "استاذه",
  "الشيخ", "الشيخه",
  "المهندس", "المهندسه", "مهندس",
  "القاضي", "القاضيه",
  "السيد", "السيده",
])

/**
 * Single letters that are an abbreviated title even when no dot follows: أ
 * (أستاذ), د (دكتور), م (مهندس), ق (قاضٍ), ش (شيخ). «الشيخة د خلدية آل خليفة»
 * is the corpus row that needs the no-dot case — its د stands alone between two
 * spaces. Stored folded, so أ arrives here as ا.
 */
const HONORIFIC_INITIALS: ReadonlySet<string> = new Set(["ا", "د", "م", "ق", "ش"])

/** What separates one name token from the next, dots and slashes included. */
const NAME_SEP_RE = /[\s.\/\\|,،؛:_\-–—]/
const NAME_SEP_RUN_RE = /^[\s.\/\\|,،؛:_\-–—]+/

/**
 * «أ.د/ مصطفى الشليح» → «مصطفى الشليح», so the شاعر files under الميم instead
 * of leading the ألف section (CLAUDE.md backlog: "poet honorifics break the
 * شعراء index"). «أ.عبدالله بن يحي علي البت» is the other shape the corpus
 * carries — the initial glued straight onto the name with no space at all.
 *
 * Two guards keep this from eating a شهرة, and both are load-bearing:
 *
 *   · A WORD honorific is stripped only when at least two name tokens survive
 *     it. «القاضي الفاضل», «السيد الحميري», «القاضي عياض», «القاضي التنوخي» and
 *     «الشيخ علوان» are not men with titles — the title IS the name they are
 *     known by, and filing them under ف/ح/ع/ت/ع would hide each one from the
 *     only reader who was looking. A title in front of a real multi-token name
 *     («الدكتور جاسم الفهيد», «الشيخ محمد متولي الشعراوي») is the other case,
 *     and the surviving token count is what separates the two.
 *   · Nothing is ever stripped down to a string with no Arabic letter left.
 *
 * An INITIAL needs no such guard: a lone letter, dotted or not, is never a
 * شهرة. Runs peel one token at a time («أ», then «د»), capped so that no
 * pathological name can spin.
 *
 * Operates on the RAW name, before `normalizeArabic`: `sortName`'s
 * `startsWithHamzaAlef` check has to read the true first letter of what is
 * LEFT, and folding first would already have thrown that hamza away.
 */
export function stripHonorifics(name: string | null | undefined): string {
  let s = (name ?? "").trim()
  for (let hop = 0; hop < 6; hop++) {
    const next = stripLeadingHonorific(s)
    if (next === null) return s
    s = next
  }
  return s
}

function stripLeadingHonorific(s: string): string | null {
  let i = 0
  while (i < s.length && NAME_SEP_RE.test(s[i]!)) i++
  let j = i
  while (j < s.length && !NAME_SEP_RE.test(s[j]!)) j++
  const token = s.slice(i, j)
  if (token === "") return null

  const letters = [...token].filter(isArabicLetter)
  if (letters.length === 0) return null

  const rest = s.slice(j).replace(NAME_SEP_RUN_RE, "").trim()
  if (!HAS_ARABIC_RE.test(rest)) return null

  if (letters.length === 1) {
    const after = s[j] ?? ""
    if (after === "." || after === "/" || HONORIFIC_INITIALS.has(foldLetters(letters[0]!))) return rest
    return null
  }

  if (!HONORIFIC_WORDS.has(normalizeArabic(token))) return null
  // the شهرة guard — «القاضي الفاضل» and «القاضي عياض» keep their title
  return rest.split(WS_RE).filter((t) => HAS_ARABIC_RE.test(t)).length >= 2 ? rest : null
}

/** The section a شاعر files under in the poets index — one of the 28, or null. */
export function shuhraLetter(name: string | null | undefined): string | null {
  return firstLetterOf(sortName(name))
}

// ─────────────────────────────────────────────────────────────────────────────
// Folded index — highlighting without losing the original text
// ─────────────────────────────────────────────────────────────────────────────

export interface FoldedIndex {
  /** The untouched input. Every offset below points into THIS string. */
  source: string
  /** The folded shadow: marks gone, letters folded, whitespace collapsed. */
  folded: string
  /** `starts[i]` — index in `source` of the character that produced `folded[i]`. */
  starts: number[]
  /** `ends[i]` — index in `source` just past that character. */
  ends: number[]
}

export interface FoldMatch {
  /** Offsets into the ORIGINAL string — usable to build a DOM Range. */
  start: number
  end: number
}

/**
 * Fold a string while REMEMBERING where every folded character came from.
 *
 * The trick is vellum-prod/client/books/search.ts's, and it exists because the
 * obvious thing does not work: normalise-then-indexOf finds the hit but the
 * offsets it reports point into the normalised string, which is not the string
 * on screen. Marks were deleted, whitespace was collapsed — the offsets no
 * longer name anything real, and you cannot turn the hit back into a highlight.
 *
 * So the fold is consulted, never materialised in place: `folded` is built
 * alongside two offset arrays, one entry per UTF-16 unit of `folded`, and a
 * match found in `folded` maps straight back onto the untouched original. That
 * is what lets the search view underline »الرحمن« inside «الرَّحْمَٰنِ» without
 * touching the tashkeel the reader asked to see.
 */
export function foldedIndex(source: string): FoldedIndex {
  const folded: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let pendingSpace = false
  let i = 0

  while (i < source.length) {
    const cp = source.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    const width = ch.length
    const at = i
    i += width

    if (TASHKEEL_RE_TEST.test(ch) || INVISIBLE_RE_TEST.test(ch)) continue

    if (WS_TEST.test(ch)) {
      if (folded.length > 0) pendingSpace = true
      continue
    }

    if (pendingSpace) {
      folded.push(" ")
      starts.push(at)
      ends.push(at)
      pendingSpace = false
    }

    const piece = foldChar(ch)
    for (let u = 0; u < piece.length; u++) {
      folded.push(piece[u]!)
      starts.push(at)
      ends.push(at + width)
    }
  }

  return { source, folded: folded.join(""), starts, ends }
}

// Non-global clones: `.test()` on a /g regex is stateful and would skip hits.
const TASHKEEL_RE_TEST = /[\u0640\u064B-\u065F\u0670\u06D6-\u06ED\u08E3-\u08FF]/
const INVISIBLE_RE_TEST = /[\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/
const WS_TEST = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/

function foldChar(ch: string): string {
  const mapped = STRING_FOLD[ch]
  if (mapped !== undefined) return mapped
  const lower = ch.toLowerCase()
  // İ → i + U+0307 is longer than its input; length must be preserved or the
  // offsets stop meaning anything, and a wrong highlight is worse than a
  // case-sensitive one for a character that appears in no Arabic diwan.
  return lower.length === ch.length ? lower : ch
}

/** The needle, folded the same way and with its whitespace collapsed. */
export function foldQuery(query: string): string {
  return foldedIndex(query).folded.trim()
}

/**
 * Every occurrence of `query` in `source`, reported in ORIGINAL offsets.
 * Matches never overlap — the scan resumes past the end of the previous hit.
 */
export function findFolded(
  source: string | FoldedIndex,
  query: string,
  limit = 500,
): FoldMatch[] {
  const idx = typeof source === "string" ? foldedIndex(source) : source
  const needle = foldQuery(query)
  if (needle === "" || idx.folded === "") return []

  const out: FoldMatch[] = []
  let from = 0
  while (out.length < limit) {
    const hit = idx.folded.indexOf(needle, from)
    if (hit < 0) break
    out.push({ start: idx.starts[hit]!, end: idx.ends[hit + needle.length - 1]! })
    from = hit + needle.length
  }
  return out
}
