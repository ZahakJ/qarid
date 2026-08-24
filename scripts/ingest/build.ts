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

import { fnv1a32, normalizeArabic } from "../../shared/arabic.ts"
import { INGEST_TX_SIZE, SCHEMA_VERSION, SOURCE_DATASET, SOURCE_REVISION } from "../../shared/constants.ts"
import { ERAS } from "../../shared/eras.ts"
import { FAMOUS_POET_KEYS } from "../../shared/famousPoets.ts"
import { formatNumber } from "../../shared/format.ts"
import { HIJAI_LETTERS } from "../../shared/letters.ts"
import { METERS } from "../../shared/meters.ts"
import { THEMES } from "../../shared/themes.ts"
import { BUILD_PRAGMAS, COMBO_ANY, COMBO_NONE, DDL, INDEXES, SCRATCH_DDL, TIER_PREDICATES } from "./ddl.ts"
import { readRecords } from "./readers.ts"
import { transformPoem, type TransformedPoem } from "./transform.ts"

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
  letter: string
  sortKey: string
  eraVotes: Counter
  locationVotes: Counter
  description: string | null
  urlSlugs: Set<string>
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
    const pass1 = await runPass1(db, opts, lookups, say)
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
  unmapped: Counter
  peakRssMb: number
}

async function runPass1(
  db: DatabaseSync,
  opts: BuildOptions,
  lookups: Lookups,
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
      seen++
      const poem = transformPoem(raw)
      if (poem === null) {
        emptyPoems++
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
          letter: poem.poet.letter ?? "ا",
          sortKey: poem.poet.sortKey,
          eraVotes: new Map(),
          locationVotes: new Map(),
          description: null,
          urlSlugs: new Set(),
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

      // design-server.md §6: first-wins. A dropped duplicate contributes
      // nothing — not its أبيات, not its votes, not its tallies.
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

  return { poets, poems: poemId, baits: baitId, emptyPoems, duplicatePoems, unmapped, peakRssMb }
}

function idOrNull(map: Map<string, number>, slug: string | null): number | null {
  return slug === null ? null : (map.get(slug) ?? null)
}

/** Each poem the شاعر keeps casts one vote for era and location. */
function votePoet(poet: PoetAcc, poem: TransformedPoem): void {
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
  if (poem.poet.urlSlug !== null) poet.urlSlugs.add(poem.poet.urlSlug)
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
    unmappedMeters: Object.fromEntries(pass1.unmapped),
    bytes,
    elapsedMs: Date.now() - started,
    peakRssMb: Math.max(pass1.peakRssMb, rss),
  }
  say(
    `done in ${(report.elapsedMs / 1000).toFixed(1)}s · ${(bytes / 1024 / 1024).toFixed(1)} MB · ` +
      `${report.poems.toLocaleString("en")} poems / ${report.baits.toLocaleString("en")} أبيات / ` +
      `${report.gameBaits.toLocaleString("en")} playable · peak rss ${report.peakRssMb.toFixed(0)} MB`,
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
    const base = [...poet.urlSlugs].sort()[0] ?? fallbackFor(poet)
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
  if (FAMOUS_POET_KEYS.has(poet.nameKey) || poet.poemCount >= 300) return 3
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
  ]
  const ins = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
  for (const [k, v] of rows) ins.run(k, v)
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
    const label =
      max === null
        ? `${formatNumber(min)}+`
        : min === max
          ? formatNumber(min)
          : `${formatNumber(min)}–${formatNumber(max)}`
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

  for (const key of ["build_id", "built_at", "counts_json", "meta_json", "facets_json", "stats_json", "letters_json"]) {
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
