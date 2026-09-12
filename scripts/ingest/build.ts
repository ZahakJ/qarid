/**
 * `build.ts` — the impure half of the ingest (design-server.md §6).
 *
 * Two passes over the corpus, one SQLite file out:
 *
 *   Pass 1 streams every row through `transform.ts` and writes `poems`,
 *   `baits`, `baits_fts` and the `_playable` scratch table, one transaction per
 *   `INGEST_TX_SIZE` poems. Poets are accumulated in a Map (7,167 of them) and
 *   are NOT written yet — their era, location, description, slug and tallies
 *   are all votes that only close when the last row has been read.
 *
 *   Pass 2 writes the poets, backfills `poems.era_id` from them, builds the
 *   three FTS indexes, materialises `game_baits` (amendment 3's playability
 *   predicate) and `combo_counts` (amendment 2), precomputes `stats_json` /
 *   `facets_json` / the per-letter supply-and-demand counts (amendment 10),
 *   creates every index, optimises FTS, ANALYZEs, VACUUMs, and asserts.
 *
 * Determinism (amendment 17): poem ids, bait ids and poet ids are assigned by
 * this file from counters in read order, and `bucket` / `rand` come from
 * `transform.ts`'s hash of (dedup_key, position) rather than from any of those
 * ids. Two builds over the same input therefore produce identical row sets —
 * `test/build.test.ts` asserts it by dumping both.
 *
 * Performance budget: 254,630 poems / 3.86M أبيات in ≤ 30 min under 2 GB RSS.
 * Every insert is a cached prepared statement, nothing is awaited per row, and
 * no array wider than one poem is ever held.
 */

import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { fnv1a32, normalizeArabic, shuhraLetter, sortName } from "../../shared/arabic.ts"
import { INGEST_TX_SIZE, SCHEMA_VERSION, SOURCE_DATASET, SOURCE_REVISION } from "../../shared/constants.ts"
import { ERAS } from "../../shared/eras.ts"
import { FAMOUS_POET_KEYS } from "../../shared/famousPoets.ts"
import { histogramLabel } from "../../shared/format.ts"
import { HIJAI_LETTERS } from "../../shared/letters.ts"
import { METERS } from "../../shared/meters.ts"
import { canonicalDisplayName } from "../../shared/poetAliases.ts"
import { THEMES } from "../../shared/themes.ts"
import { BUILD_PRAGMAS, COMBO_ANY, COMBO_NONE, DDL, INDEXES, SCRATCH_DDL, TIER_PREDICATES } from "./ddl.ts"
import { readRecords } from "./readers.ts"
import {
  dedupCandidateOf,
  dedupKeyOfRaw,
  pickDedupWinner,
  transformPoem,
  type DedupCandidate,
  type TransformedPoem,
} from "./transform.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Options and report
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** `.parquet` shards or `.jsonl` fixtures, read in order. */
  sources: readonly string[]
  /** Destination file; deleted first, journal siblings included. */
  out: string
  /** Recorded in `meta.source_revision`. */
  sourceRevision?: string
  /** Pinned so two builds of the same input are byte-identical (amendment 17). */
  builtAt?: string
  /** `false` in tests — the fixture build should not narrate. */
  log?: boolean
}

export interface BuildReport {
  out: string
  buildId: string
  poems: number
  baits: number
  poets: number
  gameBaits: number
  comboRows: number
  /** rows dropped because `cleanText` left them with no verse at all */
  emptyPoems: number
  /** rows dropped by `ON CONFLICT DO NOTHING` — the duplicate corpus entries */
  duplicatePoems: number
  /**
   * How many شاعر rows `shared/poetAliases.ts` folded away: one per alias
   * spelling the corpus actually carried, so it is ≤ `POET_ALIAS_COUNT` and 0
   * on a corpus that happens to hold none of them.
   */
  mergedPoets: number
  /** must be empty: design-server.md §6's "0 unmapped metres" assert */
  unmappedMeters: Record<string, number>
  bytes: number
  elapsedMs: number
  peakRssMb: number
}

type Counter = Map<string, number>

interface PoetAcc {
  id: number
  name: string
  nameKey: string
  /**
   * Is `name` the canonical spelling — i.e. does it normalize back to
   * `nameKey`? A شاعر first met through an alias («أبو الطيب المتنبي») starts
   * `false` and is upgraded the moment a row spells him «المتنبي», taking that
   * row's letter, sort key and slug with it.
   */
  canonicalName: boolean
  letter: string
  sortKey: string
  eraVotes: Counter
  locationVotes: Counter
  description: string | null
  /** aldiwan slugs seen on rows spelling the شاعر his CANONICAL way. */
  urlSlugs: Set<string>
  /** aldiwan slugs seen only on an alias row — the fallback, never the winner. */
  aliasUrlSlugs: Set<string>
  /**
   * Every `name_key` folded into this row, the canonical one included. `fameOf`
   * reads it so a merge takes the MAX fame of the pair: «الأسود بن يعفر
   * النهشلي» is in the canon and «الأسود النهشلي», the row that keeps the slug,
   * is not — without this the merge would demote him out of the مبتدئ tier.
   */
  sourceKeys: Set<string>
  sourceUrl: string | null
  poemCount: number
  baitCount: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function buildDatabase(opts: BuildOptions): Promise<BuildReport> {
  const started = Date.now()
  const log = opts.log ?? true
  const say = (msg: string) => {
    if (log) console.log(`[ingest] ${msg}`)
  }

  removeArtefact(opts.out)
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true })

  // Poets are written in Pass 2 (their era/slug/tallies are votes that only
  // close on the last row), so `poems.poet_id` points at a row that does not
  // exist yet for the whole of Pass 1. Referential integrity is asserted at the
  // end instead — `assertArtefact` counts orphan poems and orphan أبيات — and
  // the shipped artefact is read-only, so nothing can violate it later.
  const db = new DatabaseSync(opts.out, { enableForeignKeyConstraints: false })
  try {
    for (const pragma of BUILD_PRAGMAS) db.exec(pragma)
    db.exec(DDL)
    db.exec(SCRATCH_DDL)

    const lookups = seedLookups(db)
    const winners = await runPass0(opts, say)
    const pass1 = await runPass1(db, opts, lookups, winners, say)
    if (pass1.poems !== winners.size) {
      throw new Error(`ingest: pass 1 kept ${pass1.poems} poems for ${winners.size} distinct قصائد`)
    }
    const pass2 = runPass2(db, opts, lookups, pass1, started, say)

    return pass2
  } finally {
    db.close()
  }
}

function removeArtefact(out: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    fs.rmSync(`${out}${suffix}`, { force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup tables
// ─────────────────────────────────────────────────────────────────────────────

interface Lookups {
  eraId: Map<string, number>
  themeId: Map<string, number>
  meterId: Map<string, number>
}

/** `eras` / `themes` / `meters` are seeded from the shared tables, in sort order. */
function seedLookups(db: DatabaseSync): Lookups {
  const eraId = new Map<string, number>()
  const themeId = new Map<string, number>()
  const meterId = new Map<string, number>()

  const insEra = db.prepare("INSERT INTO eras (id, name, slug, sort, kind) VALUES (?, ?, ?, ?, ?)")
  ERAS.forEach((e, i) => {
    insEra.run(i + 1, e.name, e.slug, e.sort, e.kind)
    eraId.set(e.slug, i + 1)
  })

  const insTheme = db.prepare("INSERT INTO themes (id, name, slug, display, sort, kind) VALUES (?, ?, ?, ?, ?, ?)")
  THEMES.forEach((t, i) => {
    insTheme.run(i + 1, t.name, t.slug, t.display, t.sort, t.kind)
    themeId.set(t.slug, i + 1)
  })

  const insMeter = db.prepare("INSERT INTO meters (id, name, slug, tafila, sort, kind) VALUES (?, ?, ?, ?, ?, ?)")
  METERS.forEach((m, i) => {
    insMeter.run(i + 1, m.name, m.slug, m.tafila, m.sort, m.kind)
    meterId.set(m.slug, i + 1)
  })

  return { eraId, themeId, meterId }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 1 — stream
// ─────────────────────────────────────────────────────────────────────────────

interface Pass1Result {
  poets: Map<string, PoetAcc>
  poems: number
  baits: number
  emptyPoems: number
  duplicatePoems: number
  /**
   * Every alias `name_key` the corpus actually spelled, counted on the way past
   * `transform.ts` and BEFORE the dedup skip: an alias whose every قصيدة loses
   * pass 0 to the canonical's copy of the same قصيدة still cost a `poets` row
   * before the merge, so it still counts as one folded away.
   */
  aliasKeys: Set<string>
  unmapped: Counter
  peakRssMb: number
}

/**
 * Pass 0 — which copy of each قصيدة pass 1 is allowed to keep.
 *
 * The corpus indexes the same قصيدة more than once (8 source hosts, 5,652
 * (شاعر, مطلع) groups with more than one row) and dedup is a UNIQUE index over
 * a streamed insert, i.e. first-wins — so without this pass the artefact keeps
 * whichever copy the parquet reached first: 3,762 duplicate rows survived on
 * the previous build because the title was in the key, and keying without the
 * title but without choosing would have dropped 21,110 أبيات by keeping
 * truncated copies. So the ordinal of the BEST copy of every key is decided
 * first (`pickDedupWinner`), and pass 1 keeps exactly those rows.
 *
 * The cost is one extra read of the sources: `readRecords` is column-projected
 * (CLAUDE.md invariant — never the `poem description` column), and this pass
 * cleans one hemistich and one poet name per row rather than transforming
 * anything — plus, on the 4% of rows over `RHYME_SCAN_MIN` hemistichs, the
 * `rawiyyOf` sweep the compilation rule reads. Measured on the 254,630-row
 * corpus: the whole build is 169 s against 155 s for the same build with a
 * one-number rank.
 */
async function runPass0(opts: BuildOptions, say: (m: string) => void): Promise<Map<string, number>> {
  // The whole GROUP, not a running best: `pickDedupWinner`'s compilation rule
  // measures a candidate against the longest بحر-labelled copy of the same
  // مطلع, and that copy can arrive after it. One `DedupCandidate` is five
  // scalars, so holding all 254,630 costs ~40 MB and nothing is re-read.
  const groups = new Map<string, DedupCandidate[]>()
  let ordinal = -1
  for (const src of opts.sources) {
    say(`pass 0: ${src}`)
    for await (const raw of readRecords(src)) {
      ordinal++
      const key = dedupKeyOfRaw(raw)
      if (key === null) continue
      const cand = dedupCandidateOf(raw, ordinal)
      const held = groups.get(key)
      if (held === undefined) groups.set(key, [cand])
      else held.push(cand)
    }
  }
  const winners = new Map<string, number>()
  for (const [key, group] of groups) winners.set(key, pickDedupWinner(group))
  say(`pass 0 done: ${(ordinal + 1).toLocaleString("en")} rows, ${winners.size.toLocaleString("en")} distinct قصائد`)
  return winners
}

async function runPass1(
  db: DatabaseSync,
  opts: BuildOptions,
  lookups: Lookups,
  winners: Map<string, number>,
  say: (m: string) => void,
): Promise<Pass1Result> {
  const insPoem = db.prepare(
    `INSERT INTO poems (id, public_id, aldiwan_id, poet_id, title, title_key, meter_id, meter_variant, theme_id,
                        era_id, lang_type, bait_count, rhyme, rhyme_share, first_letter, has_tashkeel, preview_sadr, preview_ajuz,
                        dedup_key, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
  const insBait = db.prepare(
    `INSERT INTO baits (id, poem_id, position, sadr, ajuz, first_letter, rawiyy, last_letter, h_full, h_sadr, is_partial)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insFts = db.prepare("INSERT INTO baits_fts (rowid, norm) VALUES (?, ?)")
  const insPlayable = db.prepare("INSERT INTO _playable (bait_id, bucket, rand, opens_conj) VALUES (?, ?, ?, ?)")

  const poets = new Map<string, PoetAcc>()
  const unmapped: Counter = new Map()
  const aliasKeys = new Set<string>()

  let poemId = 0
  let baitId = 0
  let poetId = 0
  let seen = 0
  let emptyPoems = 0
  let duplicatePoems = 0
  let peakRssMb = 0
  let inTx = false

  const begin = () => {
    if (!inTx) {
      db.exec("BEGIN")
      inTx = true
    }
  }
  const commit = () => {
    if (inTx) {
      db.exec("COMMIT")
      inTx = false
    }
  }

  for (const src of opts.sources) {
    say(`pass 1: ${src}`)
    for await (const raw of readRecords(src)) {
      const ordinal = seen++
      const poem = transformPoem(raw)
      if (poem === null) {
        emptyPoems++
        continue
      }
      // Counted here, not in `votePoet`: this row may still lose dedup below,
      // and it would have been its own `poets` row before the alias table.
      if (!poem.poet.isCanonicalName) aliasKeys.add(normalizeArabic(poem.poet.name))
      // Not the copy pass 0 chose — a duplicate قصيدة under another title, or a
      // shorter reading of it. `dedupKey` is the same string pass 0 keyed on
      // (`dedupKeyOf`), so the two passes cannot disagree about what a قصيدة is.
      if (winners.get(poem.dedupKey) !== ordinal) {
        duplicatePoems++
        continue
      }
      if (poem.meterUnmapped !== null) {
        unmapped.set(poem.meterUnmapped, (unmapped.get(poem.meterUnmapped) ?? 0) + 1)
      }

      begin()

      // The شاعر is identified by name_key and materialised only in Pass 2 —
      // but the id is handed out now, because `poems.poet_id` needs it.
      let poet = poets.get(poem.poet.nameKey)
      const poetIsNew = poet === undefined
      if (poet === undefined) {
        poet = {
          id: ++poetId,
          name: poem.poet.name,
          nameKey: poem.poet.nameKey,
          canonicalName: poem.poet.isCanonicalName,
          letter: poem.poet.letter ?? "ا",
          sortKey: poem.poet.sortKey,
          eraVotes: new Map(),
          locationVotes: new Map(),
          description: null,
          urlSlugs: new Set(),
          aliasUrlSlugs: new Set(),
          sourceKeys: new Set(),
          sourceUrl: null,
          poemCount: 0,
          baitCount: 0,
        }
        poets.set(poem.poet.nameKey, poet)
      }

      const nextId = poemId + 1
      const publicId = poem.aldiwanId === null ? `q${nextId}` : String(poem.aldiwanId)
      const res = insPoem.run(
        nextId,
        publicId,
        poem.aldiwanId,
        poet.id,
        poem.title,
        poem.titleKey,
        idOrNull(lookups.meterId, poem.meterSlug),
        poem.meterVariant,
        idOrNull(lookups.themeId, poem.themeSlug),
        idOrNull(lookups.eraId, poem.eraSlug),
        poem.langType,
        poem.baitCount,
        poem.rhyme,
        poem.rhymeShare,
        poem.firstLetter,
        poem.hasTashkeel ? 1 : 0,
        poem.previewSadr,
        poem.previewAjuz,
        poem.dedupKey,
        poem.url,
      )

      // Unreachable now that pass 0 hands out one ordinal per key — kept as
      // the safety net that made design-server.md §6's "first-wins" true, and
      // as the thing that would catch a drift between the two passes' keys.
      if (Number(res.changes) === 0) {
        duplicatePoems++
        // A شاعر first met on a duplicate row must not survive as a ghost with
        // zero poems — hand the id back so poet ids stay contiguous.
        if (poetIsNew) {
          poets.delete(poem.poet.nameKey)
          poetId--
        }
        continue
      }
      poemId = nextId

      votePoet(poet, poem)
      poet.poemCount++
      poet.baitCount += poem.baitCount

      for (const b of poem.baits) {
        const id = ++baitId
        insBait.run(
          id,
          poemId,
          b.position,
          b.sadr,
          b.ajuz,
          b.firstLetter,
          b.rawiyy,
          b.lastLetter,
          b.hFull,
          b.hSadr,
          b.isPartial ? 1 : 0,
        )
        insFts.run(id, b.norm)
        if (b.playable) insPlayable.run(id, b.bucket, b.rand, b.opensConj ? 1 : 0)
      }

      if (poemId % INGEST_TX_SIZE === 0) {
        commit()
        const rss = process.memoryUsage.rss() / 1024 / 1024
        if (rss > peakRssMb) peakRssMb = rss
        say(
          `  ${poemId.toLocaleString("en")} poems · ${baitId.toLocaleString("en")} أبيات · ` +
            `${poets.size.toLocaleString("en")} poets · rss ${rss.toFixed(0)} MB`,
        )
      }
    }
  }
  commit()

  const rss = process.memoryUsage.rss() / 1024 / 1024
  if (rss > peakRssMb) peakRssMb = rss
  say(`pass 1 done: ${seen.toLocaleString("en")} rows read, ${poemId.toLocaleString("en")} poems kept`)

  return { poets, poems: poemId, baits: baitId, emptyPoems, duplicatePoems, aliasKeys, unmapped, peakRssMb }
}

function idOrNull(map: Map<string, number>, slug: string | null): number | null {
  return slug === null ? null : (map.get(slug) ?? null)
}

/**
 * Each poem the شاعر keeps casts one vote for era and location — and, when the
 * alias table folded two spellings together, one vote for which of them the
 * card should read.
 *
 * The canonical spelling wins outright and brings its letter, sort key and
 * slug with it (CLAUDE.md's alias backlog: "slug = canonical's"), because
 * `nameKey` is the canonical key and a card reading «أبو الطيب المتنبي» over
 * `poets.name_key = 'المتنبي'` would be the same duplicate wearing one row.
 * Description and fame are maxima and are handled below and in `fameOf`.
 */
function votePoet(poet: PoetAcc, poem: TransformedPoem): void {
  poet.sourceKeys.add(normalizeArabic(poem.poet.name))
  if (!poet.canonicalName && poem.poet.isCanonicalName) {
    poet.name = poem.poet.name
    poet.letter = poem.poet.letter ?? "ا"
    poet.sortKey = poem.poet.sortKey
    poet.canonicalName = true
  }
  if (poem.poet.eraSlug !== null) {
    poet.eraVotes.set(poem.poet.eraSlug, (poet.eraVotes.get(poem.poet.eraSlug) ?? 0) + 1)
  }
  if (poem.poet.location !== null) {
    poet.locationVotes.set(poem.poet.location, (poet.locationVotes.get(poem.poet.location) ?? 0) + 1)
  }
  if (poem.poet.description !== null) {
    // longest wins — the scrape truncates some copies of the same bio
    if (poet.description === null || poem.poet.description.length > poet.description.length) {
      poet.description = poem.poet.description
    }
  }
  if (poem.poet.urlSlug !== null) {
    // An alias row's aldiwan slug is kept apart so it can only ever be the
    // fallback: «المتنبي» must stay `mutanabi` even though the merge brought a
    // second aldiwan page in with it.
    ;(poem.poet.isCanonicalName ? poet.urlSlugs : poet.aliasUrlSlugs).add(poem.poet.urlSlug)
  }
  if (poet.sourceUrl === null && poem.poet.sourceUrl !== null) poet.sourceUrl = poem.poet.sourceUrl
}

/** Modal vote; ties break on the lexicographically smallest key, so it is stable. */
function modal(votes: Counter): string | null {
  let best: string | null = null
  let bestN = 0
  for (const [k, n] of votes) {
    if (n > bestN || (n === bestN && best !== null && k < best)) {
      best = k
      bestN = n
    }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2 — aggregate
// ─────────────────────────────────────────────────────────────────────────────

function runPass2(
  db: DatabaseSync,
  opts: BuildOptions,
  lookups: Lookups,
  pass1: Pass1Result,
  started: number,
  say: (m: string) => void,
): BuildReport {
  say("pass 2: poets")
  db.exec("BEGIN")
  writePoets(db, lookups, pass1.poets)
  db.exec("COMMIT")

  say("pass 2: era backfill")
  // design-server.md §6 — a poem whose row carried no `poet era` inherits the
  // شاعر's modal era, which is the whole reason the votes were accumulated.
  db.exec(
    `UPDATE poems SET era_id = (SELECT p.era_id FROM poets p WHERE p.id = poems.poet_id)
     WHERE era_id IS NULL`,
  )

  say("pass 2: poems_fts")
  db.exec(
    `INSERT INTO poems_fts (rowid, norm_title, norm_poet)
     SELECT p.id, p.title_key, po.name_key FROM poems p JOIN poets po ON po.id = p.poet_id`,
  )

  say("pass 2: game_baits")
  // amendment 3's predicate, finished: `_playable` holds the per-بيت half
  // (lengths, ratio, letters resolve, no junk), and these two joins add the
  // poem-level half — kind='bahr' only, never عامي.
  db.exec(
    `INSERT INTO game_baits (bait_id, first_letter, rawiyy, poem_id, era_id, meter_id, fame, position, bucket, rand, opens_conj)
     SELECT b.id, b.first_letter, b.rawiyy, b.poem_id, p.era_id, p.meter_id, po.fame, b.position, pl.bucket, pl.rand, pl.opens_conj
     FROM _playable pl
     JOIN baits b ON b.id = pl.bait_id
     JOIN poems p ON p.id = b.poem_id
     JOIN poets po ON po.id = p.poet_id
     JOIN meters m ON m.id = p.meter_id
     WHERE m.kind = 'bahr' AND (p.lang_type IS NULL OR p.lang_type <> 'عامي')`,
  )
  db.exec("DROP TABLE _playable")

  say("pass 2: combo_counts")
  const comboRows = writeComboCounts(db)

  // Indexes last: building each b-tree once over the finished table is several
  // times cheaper than maintaining eleven of them across 3.86M inserts.
  say("pass 2: indexes")
  db.exec(INDEXES)

  say("pass 2: meta")
  const counts = {
    poems: scalar(db, "SELECT COUNT(*) AS n FROM poems"),
    baits: scalar(db, "SELECT COUNT(*) AS n FROM baits"),
    poets: scalar(db, "SELECT COUNT(*) AS n FROM poets"),
    gameBaits: scalar(db, "SELECT COUNT(*) AS n FROM game_baits"),
  }
  const buildId = makeBuildId(opts, counts)
  const builtAt = opts.builtAt ?? new Date().toISOString()
  writeMeta(db, opts, buildId, builtAt, counts)

  say("pass 2: optimize + analyze + vacuum")
  for (const table of ["baits_fts", "poems_fts", "poets_fts"]) {
    db.exec(`INSERT INTO ${table}(${table}) VALUES('optimize')`)
  }
  db.exec("ANALYZE")
  db.exec("PRAGMA journal_mode = DELETE")
  // VACUUM rebuilds the whole artefact through a TEMPORARY database, and
  // `temp_store = MEMORY` (set for the bulk load) would put all ~1.6 GB of that
  // copy in RAM — straight past the 2 GB budget. Hand the temp file back to the
  // filesystem for this one statement.
  db.exec("PRAGMA temp_store = FILE")
  db.exec("VACUUM")
  db.exec("PRAGMA temp_store = MEMORY")

  assertArtefact(db, pass1)

  const bytes = fs.statSync(opts.out).size
  const rss = process.memoryUsage.rss() / 1024 / 1024
  const report: BuildReport = {
    out: opts.out,
    buildId,
    poems: counts.poems,
    baits: counts.baits,
    poets: counts.poets,
    gameBaits: counts.gameBaits,
    comboRows,
    emptyPoems: pass1.emptyPoems,
    duplicatePoems: pass1.duplicatePoems,
    mergedPoets: pass1.aliasKeys.size,
    unmappedMeters: Object.fromEntries(pass1.unmapped),
    bytes,
    elapsedMs: Date.now() - started,
    peakRssMb: Math.max(pass1.peakRssMb, rss),
  }
  say(
    `done in ${(report.elapsedMs / 1000).toFixed(1)}s · ${(bytes / 1024 / 1024).toFixed(1)} MB · ` +
      `${report.poems.toLocaleString("en")} poems / ${report.baits.toLocaleString("en")} أبيات / ` +
      `${report.gameBaits.toLocaleString("en")} playable · ${report.mergedPoets} شاعر merged · ` +
      `peak rss ${report.peakRssMb.toFixed(0)} MB`,
  )
  return report
}

function writePoets(db: DatabaseSync, lookups: Lookups, poets: Map<string, PoetAcc>): void {
  const ins = db.prepare(
    `INSERT INTO poets (id, name, name_key, slug, letter, sort_key, era_id, location, description, fame, poem_count, bait_count, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insFts = db.prepare("INSERT INTO poets_fts (rowid, norm_name, norm_desc) VALUES (?, ?, ?)")

  // CLAUDE.md spike finding 3: 772 names carry more than one poet url, so the
  // slug is chosen — aldiwan's ascii slug when there is one (they sort first
  // because they are the only ones `poetSlugFrom` returns), else the شاعر's own
  // name, and a numeric suffix breaks the rare remaining collision.
  const taken = new Set<string>()
  const ordered = [...poets.values()].sort((a, b) => a.id - b.id)

  for (const poet of ordered) {
    // A شاعر the corpus only ever spelled the alias way — no row could supply
    // the canonical display name, so the alias table does.
    if (!poet.canonicalName) {
      const canonical = canonicalDisplayName(poet.nameKey)
      if (canonical !== null) {
        poet.name = canonical
        poet.letter = shuhraLetter(canonical) ?? "ا"
        poet.sortKey = sortName(canonical)
        poet.canonicalName = true
      }
    }

    const base =
      [...poet.urlSlugs].sort()[0] ?? [...poet.aliasUrlSlugs].sort()[0] ?? fallbackFor(poet)
    let slug = base
    let n = 1
    while (taken.has(slug)) slug = `${base}-${++n}`
    taken.add(slug)

    const eraSlug = modal(poet.eraVotes)
    ins.run(
      poet.id,
      poet.name,
      poet.nameKey,
      slug,
      poet.letter,
      poet.sortKey,
      eraSlug === null ? null : (lookups.eraId.get(eraSlug) ?? null),
      modal(poet.locationVotes),
      poet.description,
      fameOf(poet),
      poet.poemCount,
      poet.baitCount,
      poet.sourceUrl,
    )
    insFts.run(poet.id, poet.nameKey, poet.description === null ? "" : normalizeArabic(poet.description))
  }
}

function fallbackFor(poet: PoetAcc): string {
  const slug = poet.nameKey.replace(/[/\\?#]/g, "").trim().replace(/\s+/g, "-").slice(0, 120)
  return slug === "" ? `shaer-${poet.id}` : slug
}

/** design-server.md §6's fame ladder, in order — the first rung that fires wins. */
function fameOf(poet: PoetAcc): number {
  // Curated canon only at the top rung: raw poem count promoted obscure prolific
  // modern poets (3,000+ poems) into the «مبتدئ» duel tier, which must quote
  // abyat a player could plausibly know.
  // The MAX over every spelling the alias table folded in — `sourceKeys` always
  // holds `nameKey` itself, so an unmerged شاعر behaves exactly as before.
  for (const key of poet.sourceKeys) if (FAMOUS_POET_KEYS.has(key)) return 3
  if (FAMOUS_POET_KEYS.has(poet.nameKey)) return 3
  if (poet.poemCount >= 60 || poet.description !== null) return 2
  if (poet.poemCount >= 5) return 1
  return 0
}

/**
 * amendment 2 — `combo_counts(first_letter, era_id, meter_id, tier, n)`.
 *
 * Four tiers × {this era, ANY era} × {this metre, ANY metre}, so the setup
 * screen's live counter and `/api/game/reply`'s exhausted-combination check are
 * both a single point lookup no matter which filters the player set. `era_id`
 * uses `0` for "this بيت has no era" and `-1` for "any"; a WITHOUT ROWID
 * primary key cannot hold NULLs, which is why the sentinels exist.
 */
function writeComboCounts(db: DatabaseSync): number {
  for (const [tier, predicate] of TIER_PREDICATES) {
    db.exec(
      `INSERT INTO combo_counts (first_letter, era_id, meter_id, tier, n)
       SELECT gb.first_letter,
              CASE es.sel WHEN 1 THEN ${COMBO_ANY} ELSE COALESCE(gb.era_id, ${COMBO_NONE}) END,
              CASE ms.sel WHEN 1 THEN ${COMBO_ANY} ELSE COALESCE(gb.meter_id, ${COMBO_NONE}) END,
              '${tier}',
              COUNT(*)
       FROM game_baits gb,
            (SELECT 0 AS sel UNION ALL SELECT 1) es,
            (SELECT 0 AS sel UNION ALL SELECT 1) ms
       WHERE ${predicate}
       GROUP BY 1, 2, 3`,
    )
  }
  return scalar(db, "SELECT COUNT(*) AS n FROM combo_counts")
}

// ─────────────────────────────────────────────────────────────────────────────
// meta — everything the read-only server would otherwise have to compute
// ─────────────────────────────────────────────────────────────────────────────

interface Counts {
  poems: number
  baits: number
  poets: number
  gameBaits: number
}

/**
 * Deterministic by construction: the same input produces the same id, which is
 * what lets amendment 17's idempotency test compare `meta` too.
 */
function makeBuildId(opts: BuildOptions, counts: Counts): string {
  const seed = [
    SCHEMA_VERSION,
    opts.sourceRevision ?? "",
    counts.poems,
    counts.baits,
    counts.poets,
    counts.gameBaits,
  ].join(":")
  return fnv1a32(seed).toString(16).padStart(8, "0")
}

function writeMeta(db: DatabaseSync, opts: BuildOptions, buildId: string, builtAt: string, counts: Counts): void {
  const letters = letterInfo(db)
  const eras = eraInfo(db)
  const meters = meterInfo(db)
  const themes = themeInfo(db)
  const rhymes = letterFacet(db, "rhyme")
  const firstLetters = letterFacet(db, "first_letter")
  const langTypes = langFacet(db)

  const metaJson = {
    buildId,
    builtAt,
    schemaVersion: SCHEMA_VERSION,
    sourceRevision: opts.sourceRevision ?? null,
    counts,
    meters,
    eras,
    themes,
    letters,
  }

  const facetsJson = {
    total: counts.poems,
    eras: eras.map((e) => ({ slug: e.slug, name: e.name, count: e.poemCount })),
    meters: meters.map((m) => ({ slug: m.slug, name: m.name, count: m.poemCount })),
    themes: themes.map((t) => ({ slug: t.slug, name: t.name, count: t.poemCount })),
    rhymes,
    firstLetters,
    langTypes,
  }

  const statsJson = {
    buildId,
    counts,
    eras: eras.map((e) => ({
      slug: e.slug,
      name: e.name,
      sort: e.sort,
      poems: e.poemCount,
      poets: e.poetCount,
      baits: e.baitCount,
    })),
    meters: meters.map((m) => ({
      slug: m.slug,
      name: m.name,
      kind: m.kind,
      poems: m.poemCount,
      baits: m.baitCount,
    })),
    themes: themes.map((t) => ({ slug: t.slug, name: t.name, count: t.poemCount })),
    rhymes,
    firstLetters,
    langTypes,
    poemLengths: poemLengthHistogram(db),
    topPoets: topPoets(db),
  }

  const rows: Array<readonly [string, string]> = [
    ["schema_version", String(SCHEMA_VERSION)],
    ["build_id", buildId],
    ["built_at", builtAt],
    ["source_dataset", SOURCE_DATASET],
    ["source_revision", opts.sourceRevision ?? ""],
    ["source_files", JSON.stringify(opts.sources.map((s) => path.basename(s)))],
    ["counts_json", JSON.stringify(counts)],
    ["meta_json", JSON.stringify(metaJson)],
    ["facets_json", JSON.stringify(facetsJson)],
    ["stats_json", JSON.stringify(statsJson)],
    ["letters_json", JSON.stringify(letters)],
    ["high_df_terms", JSON.stringify(highDfTerms(db))],
  ]
  const ins = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
  for (const [k, v] of rows) ins.run(k, v)
}

/**
 * A term appearing in this many أبيات or more is one `server/search.ts` will not
 * rank. 50,000 is where `ORDER BY bm25()` costs ~18 ms on the real corpus: the
 * ranked scan is linear in document frequency («من», 757,141 أبيات, 287 ms;
 * «الحب», 26,846, 16 ms) because SQLite must score every posting before it can
 * order them, and `SEARCH_SCAN_CAP` caps only what comes back.
 */
export const HIGH_DF_MIN = 50_000

/**
 * The terms above that threshold, read straight out of the FTS index with
 * `fts5vocab` — the same tokenizer that built it, so no normalizer can drift.
 * 38 terms on the real corpus (من في ما علي ان لا يا قد …), none on a fixture.
 * The vocab table is `temp.`: the artefact's own schema stays design-server.md
 * §5's.
 */
function highDfTerms(db: DatabaseSync): string[] {
  db.exec("CREATE VIRTUAL TABLE temp.baits_vocab USING fts5vocab(main, baits_fts, row)")
  const rows = db
    .prepare("SELECT term FROM temp.baits_vocab WHERE doc >= ? ORDER BY doc DESC")
    .all(HIGH_DF_MIN) as Array<{ term: string }>
  db.exec("DROP TABLE temp.baits_vocab")
  return rows.map((r) => String(r.term))
}

/**
 * amendment 10 — supply and demand per letter, over the GAME pool: how many
 * playable أبيات start on it (what you can answer with) versus how many end on
 * it (how often it is demanded of you). The arsenal's weakness score is built
 * from exactly these two numbers, and shipping them in `meta` means the letter
 * grid needs no facets call.
 */
function letterInfo(db: DatabaseSync): Array<{ letter: string; startsWith: number; endsWith: number }> {
  const starts = countBy(db, "SELECT first_letter AS k, COUNT(*) AS n FROM game_baits GROUP BY 1")
  const ends = countBy(db, "SELECT rawiyy AS k, COUNT(*) AS n FROM game_baits GROUP BY 1")
  return HIJAI_LETTERS.map((letter) => ({
    letter,
    startsWith: starts.get(letter) ?? 0,
    endsWith: ends.get(letter) ?? 0,
  }))
}

function eraInfo(db: DatabaseSync) {
  const poems = countBy(db, "SELECT era_id AS k, COUNT(*) AS n FROM poems WHERE era_id IS NOT NULL GROUP BY 1")
  const baits = countBy(db, "SELECT era_id AS k, SUM(bait_count) AS n FROM poems WHERE era_id IS NOT NULL GROUP BY 1")
  const poets = countBy(db, "SELECT era_id AS k, COUNT(*) AS n FROM poets WHERE era_id IS NOT NULL GROUP BY 1")
  return ERAS.map((e, i) => ({
    slug: e.slug,
    name: e.name,
    sort: e.sort,
    kind: e.kind,
    poemCount: poems.get(String(i + 1)) ?? 0,
    poetCount: poets.get(String(i + 1)) ?? 0,
    baitCount: baits.get(String(i + 1)) ?? 0,
  }))
}

function meterInfo(db: DatabaseSync) {
  const poems = countBy(db, "SELECT meter_id AS k, COUNT(*) AS n FROM poems WHERE meter_id IS NOT NULL GROUP BY 1")
  const baits = countBy(db, "SELECT meter_id AS k, SUM(bait_count) AS n FROM poems WHERE meter_id IS NOT NULL GROUP BY 1")
  return METERS.map((m, i) => ({
    slug: m.slug,
    name: m.name,
    tafila: m.tafila,
    kind: m.kind,
    sort: m.sort,
    poemCount: poems.get(String(i + 1)) ?? 0,
    baitCount: baits.get(String(i + 1)) ?? 0,
  }))
}

function themeInfo(db: DatabaseSync) {
  const poems = countBy(db, "SELECT theme_id AS k, COUNT(*) AS n FROM poems WHERE theme_id IS NOT NULL GROUP BY 1")
  return THEMES.map((t, i) => ({
    slug: t.slug,
    name: t.name,
    display: t.display,
    sort: t.sort,
    kind: t.kind,
    poemCount: poems.get(String(i + 1)) ?? 0,
  }))
}

/** All 28, zeros included — `/api/facets` must never hide a letter (§7). */
function letterFacet(db: DatabaseSync, column: "rhyme" | "first_letter") {
  const counts = countBy(db, `SELECT ${column} AS k, COUNT(*) AS n FROM poems WHERE ${column} IS NOT NULL GROUP BY 1`)
  return HIJAI_LETTERS.map((letter) => ({ letter, count: counts.get(letter) ?? 0 }))
}

function langFacet(db: DatabaseSync) {
  const counts = countBy(db, "SELECT lang_type AS k, COUNT(*) AS n FROM poems WHERE lang_type IS NOT NULL GROUP BY 1")
  return (["فصيح", "عامي"] as const).map((value) => ({ value, count: counts.get(value) ?? 0 }))
}

const LENGTH_BINS: ReadonlyArray<readonly [number, number | null]> = [
  [1, 1],
  [2, 3],
  [4, 7],
  [8, 15],
  [16, 31],
  [32, 63],
  [64, 127],
  [128, null],
]

function poemLengthHistogram(db: DatabaseSync) {
  return LENGTH_BINS.map(([min, max]) => {
    const n =
      max === null
        ? scalar(db, `SELECT COUNT(*) AS n FROM poems WHERE bait_count >= ${min}`)
        : scalar(db, `SELECT COUNT(*) AS n FROM poems WHERE bait_count BETWEEN ${min} AND ${max}`)
    const label = histogramLabel({ min, max })
    return { min, max, label, count: n }
  })
}

function topPoets(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT po.slug, po.name, po.letter, po.location, po.description, po.fame, po.poem_count, po.bait_count,
              e.slug AS era_slug, e.name AS era_name
       FROM poets po LEFT JOIN eras e ON e.id = po.era_id
       ORDER BY po.fame DESC, po.poem_count DESC, po.id ASC LIMIT 20`,
    )
    .all() as Array<Record<string, string | number | null>>
  return rows.map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    letter: String(r.letter),
    era: r.era_slug === null ? null : { slug: String(r.era_slug), name: String(r.era_name) },
    location: r.location === null ? null : String(r.location),
    description: r.description === null ? null : String(r.description),
    fame: Number(r.fame),
    poemCount: Number(r.poem_count),
    baitCount: Number(r.bait_count),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Small query helpers
// ─────────────────────────────────────────────────────────────────────────────

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { n: number | bigint | null } | undefined
  return Number(row?.n ?? 0)
}

/** `SELECT k, n …` → Map keyed by `String(k)`. */
function countBy(db: DatabaseSync, sql: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of db.prepare(sql).all() as Array<{ k: string | number | null; n: number | bigint }>) {
    if (row.k === null) continue
    out.set(String(row.k), Number(row.n))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Asserts (design-server.md §6)
// ─────────────────────────────────────────────────────────────────────────────

class BuildAssertionError extends Error {}

export function assertArtefact(db: DatabaseSync, pass1?: Pick<Pass1Result, "unmapped">): void {
  const fail = (msg: string) => {
    throw new BuildAssertionError(`ingest assertion failed: ${msg}`)
  }

  if (pass1 !== undefined && pass1.unmapped.size > 0) {
    fail(`${pass1.unmapped.size} unmapped metre value(s): ${[...pass1.unmapped.keys()].join(", ")}`)
  }

  const zeroBait = scalar(db, "SELECT COUNT(*) AS n FROM poems WHERE bait_count < 1")
  if (zeroBait > 0) fail(`${zeroBait} poem(s) with no أبيات`)

  const orphanPoems = scalar(
    db,
    "SELECT COUNT(*) AS n FROM poems p LEFT JOIN poets po ON po.id = p.poet_id WHERE po.id IS NULL",
  )
  if (orphanPoems > 0) fail(`${orphanPoems} poem(s) without a شاعر`)

  const orphanBaits = scalar(
    db,
    "SELECT COUNT(*) AS n FROM baits b LEFT JOIN poems p ON p.id = b.poem_id WHERE p.id IS NULL",
  )
  if (orphanBaits > 0) fail(`${orphanBaits} بيت without a poem`)

  const declared = scalar(db, "SELECT COALESCE(SUM(bait_count), 0) AS n FROM poems")
  const actual = scalar(db, "SELECT COUNT(*) AS n FROM baits")
  if (declared !== actual) fail(`poems.bait_count sums to ${declared} but baits holds ${actual}`)

  const indexed = scalar(db, "SELECT COUNT(*) AS n FROM baits_fts")
  if (indexed !== actual) fail(`baits_fts holds ${indexed} rows for ${actual} أبيات`)

  const poemsIndexed = scalar(db, "SELECT COUNT(*) AS n FROM poems_fts")
  const poemRows = scalar(db, "SELECT COUNT(*) AS n FROM poems")
  if (poemsIndexed !== poemRows) fail(`poems_fts holds ${poemsIndexed} rows for ${poemRows} poems`)

  const poetsIndexed = scalar(db, "SELECT COUNT(*) AS n FROM poets_fts")
  const poetRows = scalar(db, "SELECT COUNT(*) AS n FROM poets")
  if (poetsIndexed !== poetRows) fail(`poets_fts holds ${poetsIndexed} rows for ${poetRows} poets`)

  const letters = new Set<string>(HIJAI_LETTERS)
  const strayLetters = db
    .prepare(
      `SELECT DISTINCT k FROM (
         SELECT first_letter AS k FROM game_baits UNION SELECT rawiyy FROM game_baits
         UNION SELECT letter FROM poets)
       WHERE k IS NOT NULL`,
    )
    .all() as Array<{ k: string }>
  for (const row of strayLetters) {
    if (!letters.has(row.k)) fail(`letter column holds «${row.k}», which is not one of the 28`)
  }

  const badGame = scalar(
    db,
    `SELECT COUNT(*) AS n FROM game_baits gb JOIN baits b ON b.id = gb.bait_id
     WHERE b.is_partial <> 0 OR b.ajuz IS NULL OR b.rawiyy IS NULL OR b.first_letter IS NULL`,
  )
  if (badGame > 0) fail(`${badGame} game_baits row(s) violate the eligibility predicate`)

  const badMeter = scalar(
    db,
    `SELECT COUNT(*) AS n FROM game_baits gb JOIN poems p ON p.id = gb.poem_id
     LEFT JOIN meters m ON m.id = p.meter_id WHERE m.kind IS NOT 'bahr'`,
  )
  if (badMeter > 0) fail(`${badMeter} game_baits row(s) are not on a بحر`)

  for (const key of ["build_id", "built_at", "counts_json", "meta_json", "facets_json", "stats_json", "letters_json", "high_df_terms"]) {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
    if (row === undefined || row.value === "") fail(`meta.${key} is missing`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI shim — `node scripts/ingest/build.ts <src...> <out>` still works
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SOURCES = [
  "data/raw/train-00000-of-00002.parquet",
  "data/raw/train-00001-of-00002.parquet",
]
export const DEFAULT_OUT = "data/qarid.db"

if (process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  const out = args.length > 1 ? args[args.length - 1]! : DEFAULT_OUT
  const sources = args.length > 1 ? args.slice(0, -1) : args.length === 1 ? [args[0]!] : DEFAULT_SOURCES
  await buildDatabase({ sources, out, sourceRevision: SOURCE_REVISION })
}
