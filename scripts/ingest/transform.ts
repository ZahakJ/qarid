/**
 * `transform.ts` — the pure half of the ingest (design-server.md §6).
 *
 * One `RawPoem` in, one `TransformedPoem` (or `null`, when the row carries no
 * verse at all) out. Nothing here touches SQLite, the filesystem, the clock or
 * a random number generator: `build.ts` owns all of that, and this file owns
 * every decision about what a row MEANS. That split is what makes
 * `transform.test.ts` able to assert the corpus's edge cases without a database
 * and what makes amendment 17's idempotency guarantee hold — the same row
 * always produces the same output, including its `bucket`.
 *
 * Every normalisation is delegated: `shared/arabic.ts` is the ONLY normalizer,
 * `shared/meters.ts` / `eras.ts` / `themes.ts` own their vocabularies. A second
 * copy of any of them here would be a bug (CLAUDE.md invariant #1).
 */

import {
  cleanText,
  fnv1a32,
  fnv1a64Signed,
  firstLetterOf,
  normalizeArabic,
  opensConj,
  rawiyyOf,
  shuhraLetter,
  sortName,
  stripTashkeel,
} from "../../shared/arabic.ts"
import { BUCKETS, PLAYABLE, TASHKEEL_THRESHOLD } from "../../shared/constants.ts"
import { normalizeEra } from "../../shared/eras.ts"
import { normalizeMeter } from "../../shared/meters.ts"
import { canonicalNameKey } from "../../shared/poetAliases.ts"
import { normalizeLangType, normalizeLocation, normalizeTheme } from "../../shared/themes.ts"
import type { RawPoem } from "./readers.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface TransformedBait {
  /** 1-based, and the second half of `baytKey` / of the bucket hash. */
  position: number
  sadr: string
  /** `null` on the trailing odd hemistich — `is_partial` says the same thing. */
  ajuz: string | null
  firstLetter: string | null
  /** الروي, peeled (facets, chain in 'rhyme' mode). */
  rawiyy: string | null
  /** the literal final letter, unpeeled (chain in 'literal' mode, amendment 1). */
  lastLetter: string | null
  /** fnv1a64 of `normalize(sadr + " " + ajuz)`, SIGNED — node:sqlite rejects u64. */
  hFull: bigint | null
  hSadr: bigint
  isPartial: boolean
  /** amendment 5's ranking hint: does the صدر open on a bare واو/فاء? */
  opensConj: boolean
  /** what `baits_fts.norm` holds — the normalised full بيت. */
  norm: string
  /** amendment 4: derived from (dedup_key, position), never from the rowid. */
  bucket: number
  /** amendment 4's companion — a wide deterministic tiebreak inside a bucket. */
  rand: number
  /** amendment 3's playability predicate, bait-level half. */
  playable: boolean
}

export interface TransformedPoet {
  /** display name, parenthetical suffix removed */
  name: string
  /**
   * identity: `canonicalNameKey(normalizeArabic(name))`. UNIQUE in `poets`.
   *
   * The alias hop is why this is not simply `normalizeArabic(name)`: every row
   * that says «أبو الطيب المتنبي» is stored under «المتنبي», so the poems, the
   * أبيات, `game_baits` and `combo_counts` all hang off the one شاعر row.
   */
  nameKey: string
  /**
   * Does `name` normalize back to `nameKey`? `false` on a row the alias table
   * moved, and that is exactly the row whose display name, letter, sort key and
   * slug must NOT win in `build.ts` — «المتنبي» is what the card should read.
   */
  isCanonicalName: boolean
  /** ascii slug lifted from an aldiwan `cat-poet-…` url, else `null`. */
  urlSlug: string | null
  /** deterministic Arabic slug from `nameKey`, used when `urlSlug` is null. */
  fallbackSlug: string
  letter: string | null
  sortKey: string
  eraSlug: string | null
  location: string | null
  description: string | null
  sourceUrl: string | null
}

export interface TransformedPoem {
  title: string
  titleKey: string
  meterSlug: string | null
  meterVariant: string | null
  /** carried out so `build.ts` can assert design-server.md §6's "0 unmapped". */
  meterUnmapped: string | null
  themeSlug: string | null
  /** the poem's OWN era (from `poet era`); `null` rows are backfilled in Pass 2. */
  eraSlug: string | null
  langType: "فصيح" | "عامي" | null
  baitCount: number
  /** modal روي over the poem's complete أبيات; ties break to بيت 1 (§6). */
  rhyme: string | null
  /** how many أبيات actually carry `rhyme` — a monorhyme confidence signal. */
  rhymeShare: number
  firstLetter: string | null
  hasTashkeel: boolean
  previewSadr: string | null
  previewAjuz: string | null
  dedupKey: string
  aldiwanId: number | null
  url: string | null
  /** `poems_fts.norm_title` */
  normTitle: string
  poet: TransformedPoet
  baits: TransformedBait[]
}

export const UNTITLED = "بلا عنوان"

// ─────────────────────────────────────────────────────────────────────────────
// URL keys
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `https://www.aldiwan.net/poem16182.html` → 16182.
 *
 * Only aldiwan.net yields one: CLAUDE.md's spike finding 1 measured 8 hosts on
 * `poem url`, and only 27% of rows are aldiwan's. The other 73% fall back to
 * `q<rowid>` for their `public_id`, so this returning `null` is the COMMON case.
 */
export function aldiwanIdFrom(url: string | null | undefined): number | null {
  if (!url) return null
  const m = /(?:^|\/\/|\/)(?:www\.)?aldiwan\.net\/poem(\d+)\.html/.exec(url)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * `https://www.aldiwan.net/cat-poet-almtnby` → `almtnby` (design-server.md §0).
 *
 * Every other host either has no poet page at all (91,936 rows — spike finding
 * 2) or keys it by an opaque numeric id that would make a worse slug than the
 * poet's own name, so this deliberately answers `null` for them and
 * `fallbackPoetSlug` takes over.
 */
export function poetSlugFrom(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /(?:^|\/\/|\/)(?:www\.)?aldiwan\.net\/cat-poet-([^/?#]+)/.exec(url)
  if (m === null) return null
  const slug = decodeURIComponent(m[1]!).replace(/\.html?$/i, "").trim().toLowerCase()
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(slug)) return null
  return slug
}

/**
 * The slug for a شاعر with no aldiwan page: the normalised name with its spaces
 * hyphenated. `PoetSlugSchema` is explicitly NOT ascii-constrained for exactly
 * this reason — «احمد-شوقي» is a better URL for a reader than «poet-4471».
 */
export function fallbackPoetSlug(nameKey: string): string {
  const slug = nameKey
    .replace(/[/\\?#]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 120)
  return slug === "" ? "shaer" : slug
}

/** «بشارة الخوري (الأخطل الصغير )» → «بشارة الخوري». */
export function stripParenthetical(name: string): string {
  return name.replace(/[([{（][^)\]}）]*[)\]}）]?/g, " ")
}

// ─────────────────────────────────────────────────────────────────────────────
// Tashkeel
// ─────────────────────────────────────────────────────────────────────────────

const ARABIC_CHAR_RE = /[\u0621-\u064A\u0671\u064B-\u0655\u0670\u06D6-\u06ED]/g
const MARK_CHAR_RE = /[\u064B-\u0655\u0670\u06D6-\u06ED]/g

/**
 * `has_tashkeel` (design-server.md §5): 1 when ≥3% of the poem's Arabic
 * characters are marks. A ratio, not a count, because a 5,000-بيت ديوان with
 * three stray fathas is not vocalised and a two-بيت مقطوعة with full شكل is.
 */
export function tashkeelRatio(texts: readonly string[]): number {
  let arabic = 0
  let marks = 0
  for (const t of texts) {
    arabic += (t.match(ARABIC_CHAR_RE) ?? []).length
    marks += (t.match(MARK_CHAR_RE) ?? []).length
  }
  return arabic === 0 ? 0 : marks / arabic
}

// ─────────────────────────────────────────────────────────────────────────────
// Playability (amendment 3)
// ─────────────────────────────────────────────────────────────────────────────

/** Latin letters, any digits (both scripts), and the scraper's junk runs. */
const NOT_VERSE_RE = /[A-Za-z0-9\u0660-\u0669\u06F0-\u06F9]/
const PLACEHOLDER_RUN_RE = /([.\-*_=~…،؛?!ـ])\1{2,}/

/** The length a playability check measures: marks and tatweel off, spaces collapsed. */
export function bareLength(s: string): number {
  return stripTashkeel(s).replace(/\s+/g, " ").trim().length
}

/**
 * amendment 3's predicate, the half that only needs the بيت itself. Stricter
 * than design-server.md §5's `length ≥ 8`: both halves must be 12–80 characters
 * once tashkeel is off, their length ratio must sit inside 0.5–2.0 (a tadwir
 * split — one long line arbitrarily cut — shows up as a wild ratio), both chain
 * letters must resolve, and neither half may carry Latin text, digits or a run
 * of scraper junk like «***».
 *
 * The poem-level half (lang ≠ عامي, metre kind = bahr) lives in `build.ts`'s
 * Pass 2, where it is one SQL join instead of a per-row check.
 */
export function isPlayableBait(bait: {
  sadr: string
  ajuz: string | null
  firstLetter: string | null
  rawiyy: string | null
  lastLetter: string | null
  isPartial: boolean
}): boolean {
  if (bait.isPartial || bait.ajuz === null) return false
  if (bait.firstLetter === null || bait.rawiyy === null || bait.lastLetter === null) return false

  const a = bareLength(bait.sadr)
  const b = bareLength(bait.ajuz)
  if (a < PLAYABLE.minHemistichChars || a > PLAYABLE.maxHemistichChars) return false
  if (b < PLAYABLE.minHemistichChars || b > PLAYABLE.maxHemistichChars) return false

  const ratio = a / b
  if (ratio < PLAYABLE.minLenRatio || ratio > PLAYABLE.maxLenRatio) return false

  for (const half of [bait.sadr, bait.ajuz]) {
    if (NOT_VERSE_RE.test(half)) return false
    if (PLACEHOLDER_RUN_RE.test(half)) return false
  }
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// The transform
// ─────────────────────────────────────────────────────────────────────────────

export const UNKNOWN_POET = "شاعر مجهول"

/**
 * The identity of a قصيدة: شاعر + مطلع, and deliberately NOT its title.
 *
 * The title used to be in this key and it is why 6,264 duplicate قصائد (2.5% of
 * the artefact) survived dedup: the eight source hosts title the same قصيدة
 * differently, so «جدارية» / «جدارية..محمود درويش» / «جدارية محمود درويش» were
 * three rows and «إلى متى؟» / «إلى متى ؟» two — and because a famous قصيدة is
 * exactly the one two sources both carry, they sorted to the TOP of «الأشهر»
 * and landed adjacent on the first screen of both التصفح and البحث. Measured on
 * the previous artefact: 5,652 (شاعر, مطلع) groups holding more than one row.
 *
 * Nothing about the copy is in the key — not its length, not its tashkeel —
 * because the key decides WHICH rows are the same قصيدة and `build.ts`'s pass 0
 * decides which of them survives (`pickDedupWinner`). Putting length in the key
 * instead would leave every truncated copy standing as its own قصيدة, which is
 * the same duplicate on the screen wearing a different excuse.
 */
export function dedupKeyOf(nameKey: string, hemistichs: readonly string[]): string {
  return `${nameKey}|${normalizeArabic(hemistichs[0] ?? "")}`
}

/**
 * The same key, computed from a RAW row without transforming it — `build.ts`
 * pass 0 needs it for all 254,630 rows and can afford exactly this much work.
 * `null` when the row has no verse that survives `cleanText`, which is also the
 * condition under which `transformPoem` returns `null`, so the two agree by
 * construction.
 */
export function dedupKeyOfRaw(raw: RawPoem): string | null {
  const rawName = cleanText(stripParenthetical(raw.poetName ?? ""))
  const nameKey = canonicalNameKey(normalizeArabic(rawName === "" ? UNKNOWN_POET : rawName))
  for (const v of raw.verses) {
    const c = cleanText(v)
    if (c !== "") return dedupKeyOf(nameKey, [c])
  }
  return null
}

/**
 * One raw row reduced to everything the dedup decision reads, and nothing else
 * — `build.ts` pass 0 holds one of these per row of the corpus, so it is five
 * scalars and not one string.
 *
 * `at` is the row's ordinal in source order, which is both the identity pass 1
 * checks and the tie-break that makes two builds of the same input identical
 * (amendment 17).
 */
export interface DedupCandidate {
  at: number
  hemistichs: number
  /** A NAMED بحر — `kind:'bahr'`, i.e. exactly the gate `game_baits` applies. */
  bahr: boolean
  /** `tashkeelRatio` of the مطلع — marks per Arabic character, 0…1. */
  tashkeel: number
  aldiwan: boolean
  /**
   * The share of complete أبيات carrying the modal روي — 1 for anything short
   * enough that the compilation rule can never reach it (see `RHYME_SCAN_MIN`).
   */
  rhymeShare: number
}

/**
 * The compilation rule, in three numbers. A METERLESS copy this much longer
 * than the longest بحر-labelled copy of the same مطلع, this long in absolute
 * terms, and holding this little of one روي, is not a fuller reading of the
 * قصيدة — it is the شاعر's ديوان scraped as ONE row.
 *
 * All three are load-bearing, and the corpus is what set them
 * (`scripts/ingest/dedupAudit.ts`; the whole flip list was read by hand). The
 * three real blobs and the three long قصائد they must not take with them:
 *
 * |                                   | ratio | share | verdict |
 * |---|---|---|---|
 * | المتنبي, dctabudhabi 1,810 hemistichs | 19.7× | 0.23 | blob |
 * | خليل مطران, poetsgate 1,378           | 76.6× | 0.87 | blob |
 * | عماد الدين الأصبهاني, adab 360        | 20.0× | 0.08 | blob |
 * | ابن الفارض, التائية الكبرى 1,520      |  3.9× | 0.55 | REAL |
 * | سعيد بن خلفان, سلوك 442               | 17.0× | 1.00 | REAL |
 * | علي محمود طه, «ميلاد شاعر» 222        |  8.2× | low  | REAL |
 *
 * No single column separates those two halves — ratio alone would truncate
 * التائية الكبرى to a 387-hemistich copy and the سلوك to 13 أبيات, and share
 * alone would take التائية too. The RATIO spares التائية, the SHARE spares the
 * سلوك (a قصيدة holds one روي; a scraped ديوان does not), and the absolute
 * FLOOR spares «ميلاد شاعر», which is a real poem in sections and therefore
 * looks exactly like a small compilation. At 5× / 240 / 0.9 the rule fires on
 * three groups in the whole corpus and every one of them is a blob.
 */
export const SUSPECT_RATIO = 5
export const SUSPECT_FLOOR = 240
export const SUSPECT_RHYME_SHARE = 0.9

/**
 * Below this many hemistichs `rhymeShare` is not computed at all (it comes back
 * 1, i.e. never suspect). `SUSPECT_FLOOR` is far above it, so the rule cannot
 * notice — and pass 0 pays `rawiyyOf` on 4% of the corpus instead of all of it.
 */
export const RHYME_SCAN_MIN = 40

/**
 * What pass 0 records for one raw row. Only the FIRST verse is measured for
 * tashkeel — this runs on every one of the 254,630 raw rows, and a scraper that
 * kept the marks kept them throughout.
 */
export function dedupCandidateOf(raw: RawPoem, at: number): DedupCandidate {
  return {
    at,
    hemistichs: raw.verses.length,
    bahr: normalizeMeter(raw.meter).kind === "bahr",
    tashkeel: tashkeelRatio([raw.verses[0] ?? ""]),
    aldiwan: (raw.poemUrl ?? "").includes("aldiwan.net"),
    rhymeShare: raw.verses.length > RHYME_SCAN_MIN ? rawRhymeShare(raw.verses) : 1,
  }
}

/**
 * `modalRawiyy`'s share, computed off RAW verses — the same pairing
 * `transformPoem` does (clean, drop the empties, عجز is every second one), so
 * pass 0 and pass 1 cannot disagree about what a poem's قافية is.
 */
function rawRhymeShare(verses: readonly string[]): number {
  const hemis: string[] = []
  for (const v of verses) {
    const c = cleanText(v)
    if (c !== "") hemis.push(c)
  }
  const baits: { rawiyy: string | null }[] = []
  for (let i = 1; i < hemis.length; i += 2) baits.push({ rawiyy: rawiyyOf(hemis[i]!).rawiyy })
  return modalRawiyy(baits).share
}

/**
 * Which copy of a قصيدة the artefact keeps — the ordinal of the winner.
 *
 * Length first, and that is the half that matters: 3,924 of the duplicate
 * groups hold copies of DIFFERENT lengths (one source truncated the قصيدة, or
 * merged two hemistichs into one), and first-wins over a stream would keep
 * whichever copy the parquet happened to reach first — 21,110 أبيات dropped
 * with the copies it discarded. Longest wins, so the ديوان is the fullest
 * reading of every قصيدة it holds.
 *
 * With ONE exception, and it is why this reads the whole GROUP rather than
 * scoring a row: a candidate with no named بحر, in a group that HAS a
 * بحر-labelled copy, more than `SUSPECT_RATIO`× that copy's length, over
 * `SUSPECT_FLOOR` hemistichs and holding less than `SUSPECT_RHYME_SHARE` of one
 * روي, is a COMPILATION SUSPECT — a whole ديوان indexed as one poem — and ranks
 * below every real copy. Length alone made it win, it
 * carried no بحر, and the `m.kind='bahr'` gate on `game_baits` then made every
 * بيت inside it unservable: «على قدر أهل العزم تأتي العزائم», the most famous
 * ع-بيت in the language, was invisible to the duel, to the assist rail and to
 * the pool counts while the 1,810-hemistich dctabudhabi blob held the key.
 *
 * Then the flags, in the order the artefact reads them: a named بحر, tashkeel
 * density, aldiwan.net (the cleanest text of the eight hosts). بحر sits ABOVE
 * tashkeel — one decides whether the بيت can be played at all, the other only
 * how it is set.
 */
export function pickDedupWinner(
  group: readonly DedupCandidate[],
  opts: { ratio?: number; floor?: number; rhymeShare?: number } = {},
): number {
  const ratio = opts.ratio ?? SUSPECT_RATIO
  const floor = opts.floor ?? SUSPECT_FLOOR
  const share = opts.rhymeShare ?? SUSPECT_RHYME_SHARE
  // The LONGEST بحر-labelled copy, so a candidate has to dwarf the best reading
  // the group can prove is a poem before it is called a compilation.
  let labelled = -1
  for (const c of group) if (c.bahr && c.hemistichs > labelled) labelled = c.hemistichs
  const suspect = (c: DedupCandidate): boolean =>
    !c.bahr &&
    labelled >= 0 &&
    c.hemistichs > ratio * labelled &&
    c.hemistichs > floor &&
    c.rhymeShare < share

  let best = group[0]!
  let bestSuspect = suspect(best)
  for (let i = 1; i < group.length; i++) {
    const c = group[i]!
    const s = suspect(c)
    // Every comparison is `>` and never `>=`: a tie keeps the EARLIER row, and
    // that is what makes two builds of the same input identical.
    const wins =
      s !== bestSuspect
        ? bestSuspect
        : c.hemistichs !== best.hemistichs
          ? c.hemistichs > best.hemistichs
          : c.bahr !== best.bahr
            ? c.bahr
            : c.tashkeel !== best.tashkeel
              ? c.tashkeel > best.tashkeel
              : c.aldiwan && !best.aldiwan
    if (wins) {
      best = c
      bestSuspect = s
    }
  }
  return best.at
}

/**
 * One dataset row → everything `build.ts` needs to write, or `null` when the
 * row has no verse that survives `cleanText` (design-server.md §6: zero-bait
 * poems are dropped, and Pass 2 asserts there are none in the artefact).
 */
export function transformPoem(raw: RawPoem): TransformedPoem | null {
  // ── hemistichs ──────────────────────────────────────────────────────────
  const hemis: string[] = []
  for (const v of raw.verses) {
    const c = cleanText(v)
    if (c !== "") hemis.push(c)
  }
  if (hemis.length === 0) return null

  // ── identity ────────────────────────────────────────────────────────────
  const title = cleanText(raw.title) || UNTITLED
  const rawName = cleanText(stripParenthetical(raw.poetName ?? ""))
  const name = rawName === "" ? UNKNOWN_POET : rawName
  // The alias hop happens HERE, before anything is keyed on the شاعر — the
  // dedup key included, which is how «الخيل» stops showing the same مطلع twice
  // under two spellings of the same man (CLAUDE.md backlog, poet alias merge).
  const nameKey = canonicalNameKey(normalizeArabic(name))
  const dedupKey = dedupKeyOf(nameKey, hemis)

  // ── metre / theme / era / language ──────────────────────────────────────
  const meter = normalizeMeter(raw.meter)
  const theme = normalizeTheme(raw.theme)
  const era = normalizeEra(raw.poetEra)
  // «عامي» in the metre column is the dialect marker leaking one column left;
  // shared/meters.ts hands it back as `langHint` and it wins over the column.
  const langType = meter.langHint ?? normalizeLangType(raw.langType)
  const meterUnmapped =
    meter.meterSlug === null && meter.langHint === null && cleanText(raw.meter) !== ""
      ? cleanText(raw.meter)
      : null

  // ── أبيات ───────────────────────────────────────────────────────────────
  const baits: TransformedBait[] = []
  for (let i = 0; i < hemis.length; i += 2) {
    const position = baits.length + 1
    const sadr = hemis[i]!
    const ajuz = i + 1 < hemis.length ? hemis[i + 1]! : null
    const isPartial = ajuz === null
    const { rawiyy, lastLetter } = ajuz === null ? { rawiyy: null, lastLetter: null } : rawiyyOf(ajuz)
    const norm = ajuz === null ? normalizeArabic(sadr) : normalizeArabic(`${sadr} ${ajuz}`)
    // amendment 4: the sampling key is a hash of (dedup_key, position), so a
    // rebuild — with different autoincrement ids — serves the same بيت اليوم.
    const h = fnv1a32(`${dedupKey}:${position}`)
    const core = {
      position,
      sadr,
      ajuz,
      firstLetter: firstLetterOf(sadr),
      rawiyy,
      lastLetter,
      isPartial,
    }
    baits.push({
      ...core,
      hFull: ajuz === null ? null : fnv1a64Signed(norm),
      hSadr: fnv1a64Signed(normalizeArabic(sadr)),
      opensConj: opensConj(sadr),
      norm,
      bucket: h % BUCKETS,
      rand: h,
      playable: isPlayableBait(core),
    })
  }

  // ── poem-level derivations ──────────────────────────────────────────────
  const { rhyme, share } = modalRawiyy(baits)
  const first = baits[0]!

  return {
    title,
    titleKey: normalizeArabic(title),
    meterSlug: meter.meterSlug,
    meterVariant: meter.variant,
    meterUnmapped,
    themeSlug: theme?.slug ?? null,
    eraSlug: era?.slug ?? null,
    langType,
    baitCount: baits.length,
    rhyme,
    rhymeShare: share,
    firstLetter: first.firstLetter,
    hasTashkeel: tashkeelRatio(hemis) >= TASHKEEL_THRESHOLD,
    previewSadr: first.sadr,
    previewAjuz: first.ajuz,
    dedupKey,
    aldiwanId: aldiwanIdFrom(raw.poemUrl),
    url: cleanUrl(raw.poemUrl),
    normTitle: normalizeArabic(title),
    poet: {
      name,
      nameKey,
      isCanonicalName: normalizeArabic(name) === nameKey,
      urlSlug: poetSlugFrom(raw.poetUrl),
      fallbackSlug: fallbackPoetSlug(nameKey),
      letter: shuhraLetter(name),
      sortKey: sortName(name),
      eraSlug: era?.slug ?? null,
      location: normalizeLocation(raw.poetLocation),
      description: cleanDescription(raw.poetDescription),
      sourceUrl: cleanUrl(raw.poetUrl),
    },
    baits,
  }
}

/**
 * `poems.rhyme` = the روي most of the poem's complete أبيات share; a tie is
 * broken in favour of بيت 1, which is the قافية a reader would name.
 *
 * The share comes back with it because it is NOT a data error when it is low:
 * موشحات, شعر حر and مزدوجات are genuinely not monorhyme (84.3% agreement over
 * the whole corpus vs ~90% over the game pool — the arabic agent measured it),
 * and `game_baits`' `meters.kind='bahr'` filter is what removes those forms.
 */
export function modalRawiyy(
  baits: readonly { rawiyy: string | null }[],
): { rhyme: string | null; share: number } {
  const votes = new Map<string, number>()
  let total = 0
  for (const b of baits) {
    if (b.rawiyy === null) continue
    total++
    votes.set(b.rawiyy, (votes.get(b.rawiyy) ?? 0) + 1)
  }
  if (total === 0) return { rhyme: null, share: 0 }

  const firstRawiyy = baits.find((b) => b.rawiyy !== null)?.rawiyy ?? null
  let best: string | null = null
  let bestN = 0
  for (const [letter, n] of votes) {
    if (n > bestN || (n === bestN && letter === firstRawiyy)) {
      best = letter
      bestN = n
    }
  }
  return { rhyme: best, share: bestN / total }
}

/** A url is stored for attribution only; it is never parsed at runtime. */
function cleanUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const t = url.trim()
  return t === "" ? null : t.slice(0, 500)
}

/**
 * `poet description` is a scraped bio: real newlines, occasional runs of
 * nothing. Collapse it to one line and cap it — only 791 poets carry one, and a
 * poet page shows an excerpt, never a wall.
 */
function cleanDescription(desc: string | null | undefined): string | null {
  if (!desc) return null
  const t = desc.replace(/\s+/g, " ").trim()
  if (t === "" || t === "-") return null
  return t.slice(0, 2000)
}
