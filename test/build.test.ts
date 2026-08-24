/**
 * `test/build.test.ts` — the ingest, end to end, over the checked-in fixture.
 *
 * Everything here runs against an artefact produced by the REAL
 * `scripts/ingest/build.ts` (via `test/fixtureDb.ts`), so a regression in the
 * pipeline fails here before it can reach `data/qarid.db`.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { assertArtefact, type BuildReport } from "../scripts/ingest/build.ts"
import { TIER_PREDICATES } from "../scripts/ingest/ddl.ts"
import { ftsQuery } from "../shared/arabic.ts"
import { PLAYABLE } from "../shared/constants.ts"
import { ERAS } from "../shared/eras.ts"
import { HIJAI_LETTERS } from "../shared/letters.ts"
import { METERS } from "../shared/meters.ts"
import { THEMES } from "../shared/themes.ts"
import { bareLength } from "../scripts/ingest/transform.ts"
import { buildFixtureDb, FIXTURE_BUILT_AT, REPO_ROOT } from "./fixtureDb.ts"

const SCRATCH = path.join(REPO_ROOT, "data", "test-build")
const DB_A = path.join(SCRATCH, "a.db")
const DB_B = path.join(SCRATCH, "b.db")

let report: BuildReport
let db: DatabaseSync

const all = <T>(sql: string, ...params: Array<string | number>): T[] =>
  db.prepare(sql).all(...params) as T[]
const one = <T>(sql: string, ...params: Array<string | number>): T | undefined =>
  db.prepare(sql).get(...params) as T | undefined
const count = (sql: string, ...params: Array<string | number>): number =>
  Number((one<{ n: number | bigint }>(sql, ...params) ?? { n: 0 }).n)

beforeAll(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(SCRATCH, { recursive: true })
  report = await buildFixtureDb(DB_A)
  db = new DatabaseSync(DB_A, { readOnly: true })
}, 60_000)

afterAll(() => {
  db?.close()
  fs.rmSync(SCRATCH, { recursive: true, force: true })
})

// ═════════════════════════════════════════════════════════════════════════════
// The build report
// ═════════════════════════════════════════════════════════════════════════════

describe("the fixture build", () => {
  it("produces a file and a self-consistent report", () => {
    expect(fs.existsSync(DB_A)).toBe(true)
    expect(report.bytes).toBe(fs.statSync(DB_A).size)
    expect(report.poems).toBeGreaterThanOrEqual(35)
    expect(report.baits).toBeGreaterThan(200)
    expect(report.poets).toBeGreaterThanOrEqual(30)
    expect(report.gameBaits).toBeGreaterThan(100)
  })

  it("leaves NO unmapped metre — design-server.md §6's hard assert", () => {
    expect(report.unmappedMeters).toEqual({})
  })

  it("drops the rows that carry no verse and counts them", () => {
    // two synthesized rows: one with `verses: []`, one whose verses are all junk
    expect(report.emptyPoems).toBe(2)
    expect(count("SELECT COUNT(*) n FROM poems WHERE bait_count < 1")).toBe(0)
  })

  it("re-runs every ingest assertion against the finished artefact", () => {
    expect(() => assertArtefact(db)).not.toThrow()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Row counts and referential integrity
// ═════════════════════════════════════════════════════════════════════════════

describe("row counts", () => {
  it("seeds the three lookup tables from the shared vocabularies", () => {
    expect(count("SELECT COUNT(*) n FROM eras")).toBe(ERAS.length)
    expect(count("SELECT COUNT(*) n FROM themes")).toBe(THEMES.length)
    expect(count("SELECT COUNT(*) n FROM meters")).toBe(METERS.length)
    expect(one<{ slug: string }>("SELECT slug FROM eras WHERE id = 1")!.slug).toBe(ERAS[0]!.slug)
  })

  it("matches the report and poems.bait_count", () => {
    expect(count("SELECT COUNT(*) n FROM poems")).toBe(report.poems)
    expect(count("SELECT COUNT(*) n FROM baits")).toBe(report.baits)
    expect(count("SELECT COUNT(*) n FROM poets")).toBe(report.poets)
    expect(count("SELECT SUM(bait_count) n FROM poems")).toBe(report.baits)
  })

  it("indexes every بيت, poem and شاعر for FTS", () => {
    expect(count("SELECT COUNT(*) n FROM baits_fts")).toBe(report.baits)
    expect(count("SELECT COUNT(*) n FROM poems_fts")).toBe(report.poems)
    expect(count("SELECT COUNT(*) n FROM poets_fts")).toBe(report.poets)
    // the index holds NORMALISED text, so a query must go through ftsQuery too
    const hit = all<{ rowid: number }>("SELECT rowid FROM baits_fts WHERE baits_fts MATCH ?", ftsQuery("الدهر"))
    expect(hit.length).toBeGreaterThan(0)
    // …and an AND of two terms narrows to the one بيت that carries both
    expect(
      all("SELECT rowid FROM baits_fts WHERE baits_fts MATCH ?", ftsQuery("صبا نجد")).length,
    ).toBe(1)
  })

  it("has no orphans in either direction", () => {
    expect(count("SELECT COUNT(*) n FROM poems p LEFT JOIN poets o ON o.id=p.poet_id WHERE o.id IS NULL")).toBe(0)
    expect(count("SELECT COUNT(*) n FROM baits b LEFT JOIN poems p ON p.id=b.poem_id WHERE p.id IS NULL")).toBe(0)
    expect(count("SELECT COUNT(*) n FROM game_baits g LEFT JOIN baits b ON b.id=g.bait_id WHERE b.id IS NULL")).toBe(0)
  })

  it("gives every poem a public_id — the aldiwan id when there is one, else q<id>", () => {
    expect(count("SELECT COUNT(*) n FROM poems WHERE public_id IS NULL OR public_id = ''")).toBe(0)
    expect(count("SELECT COUNT(*) n FROM poems")).toBe(count("SELECT COUNT(DISTINCT public_id) n FROM poems"))
    const aldiwan = one<{ public_id: string }>("SELECT public_id FROM poems WHERE aldiwan_id = 16182")
    expect(aldiwan!.public_id).toBe("16182")
    // CLAUDE.md finding 1: the q<id> fallback is the COMMON case, not the exception
    expect(count("SELECT COUNT(*) n FROM poems WHERE aldiwan_id IS NULL AND public_id NOT LIKE 'q%'")).toBe(0)
  })

  it("keeps every letter column inside the 28 حروف الهجاء", () => {
    const letters = new Set<string>(HIJAI_LETTERS)
    const seen = all<{ k: string }>(
      `SELECT DISTINCT k FROM (SELECT first_letter k FROM baits UNION SELECT rawiyy FROM baits
        UNION SELECT last_letter FROM baits UNION SELECT rhyme FROM poems
        UNION SELECT first_letter FROM poems UNION SELECT letter FROM poets) WHERE k IS NOT NULL`,
    )
    expect(seen.length).toBeGreaterThan(5)
    for (const row of seen) expect(letters.has(row.k)).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// game_baits — amendment 3's playability predicate
// ═════════════════════════════════════════════════════════════════════════════

describe("game_baits eligibility", () => {
  it("holds only complete أبيات with both chain letters", () => {
    expect(
      count(
        `SELECT COUNT(*) n FROM game_baits g JOIN baits b ON b.id = g.bait_id
         WHERE b.is_partial <> 0 OR b.ajuz IS NULL OR b.rawiyy IS NULL OR b.first_letter IS NULL`,
      ),
    ).toBe(0)
  })

  it("holds only أبيات on a بحر — never free, prose, muwashah, folk or unknown", () => {
    expect(
      count(
        `SELECT COUNT(*) n FROM game_baits g JOIN poems p ON p.id = g.poem_id
         LEFT JOIN meters m ON m.id = p.meter_id WHERE m.kind IS NOT 'bahr'`,
      ),
    ).toBe(0)
    // …and the fixture really does contain all six kinds, so that filter bites
    const kinds = all<{ kind: string }>(
      "SELECT DISTINCT m.kind FROM poems p JOIN meters m ON m.id = p.meter_id",
    ).map((r) => r.kind)
    expect(kinds.sort()).toEqual(["bahr", "folk", "free", "muwashah", "prose", "unknown"])
  })

  it("excludes عامي poems (amendment 3)", () => {
    expect(count("SELECT COUNT(*) n FROM poems WHERE lang_type = 'عامي'")).toBeGreaterThan(0)
    expect(
      count("SELECT COUNT(*) n FROM game_baits g JOIN poems p ON p.id=g.poem_id WHERE p.lang_type = 'عامي'"),
    ).toBe(0)
  })

  it("respects the 12–80 char bounds and the 0.5–2.0 length ratio", () => {
    const rows = all<{ sadr: string; ajuz: string }>(
      "SELECT b.sadr, b.ajuz FROM game_baits g JOIN baits b ON b.id = g.bait_id",
    )
    expect(rows.length).toBe(report.gameBaits)
    for (const r of rows) {
      const a = bareLength(r.sadr)
      const z = bareLength(r.ajuz)
      expect(a).toBeGreaterThanOrEqual(PLAYABLE.minHemistichChars)
      expect(a).toBeLessThanOrEqual(PLAYABLE.maxHemistichChars)
      expect(z).toBeGreaterThanOrEqual(PLAYABLE.minHemistichChars)
      expect(z).toBeLessThanOrEqual(PLAYABLE.maxHemistichChars)
      expect(a / z).toBeGreaterThanOrEqual(PLAYABLE.minLenRatio)
      expect(a / z).toBeLessThanOrEqual(PLAYABLE.maxLenRatio)
    }
  })

  it("really does reject some أبيات — the predicate is not a no-op", () => {
    const bahr = count(
      "SELECT COUNT(*) n FROM baits b JOIN poems p ON p.id=b.poem_id JOIN meters m ON m.id=p.meter_id WHERE m.kind='bahr'",
    )
    expect(report.gameBaits).toBeLessThan(bahr)
    expect(report.gameBaits).toBeLessThan(report.baits)
  })

  it("buckets every row deterministically into 0…999 with a wide tiebreak", () => {
    const rows = all<{ bucket: number; rand: number; opens_conj: number }>(
      "SELECT bucket, rand, opens_conj FROM game_baits",
    )
    for (const r of rows) {
      expect(r.bucket).toBeGreaterThanOrEqual(0)
      expect(r.bucket).toBeLessThan(1000)
      expect(r.rand % 1000).toBe(r.bucket)
      expect([0, 1]).toContain(r.opens_conj)
    }
    expect(new Set(rows.map((r) => r.bucket)).size).toBeGreaterThan(20)
  })

  it("copies fame, era and metre off the poem so the sampler never joins", () => {
    expect(
      count(
        `SELECT COUNT(*) n FROM game_baits g JOIN poems p ON p.id = g.poem_id JOIN poets o ON o.id = p.poet_id
         WHERE g.fame <> o.fame OR g.meter_id IS NOT p.meter_id OR g.era_id IS NOT p.era_id`,
      ),
    ).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// combo_counts — amendment 2
// ═════════════════════════════════════════════════════════════════════════════

describe("combo_counts", () => {
  it("materialises all four tiers", () => {
    const tiers = all<{ tier: string }>("SELECT DISTINCT tier FROM combo_counts ORDER BY tier").map((r) => r.tier)
    expect(tiers).toEqual(["brutal", "easy", "hard", "normal"])
  })

  it("its «any era / any metre» row equals the live count for that tier", () => {
    // TIER_PREDICATES is the source of truth; a literal copy here would go on
    // agreeing with itself after a tier is retuned.
    for (const [tier, sql] of TIER_PREDICATES) {
      const stored = all<{ first_letter: string; n: number }>(
        "SELECT first_letter, n FROM combo_counts WHERE tier = ? AND era_id = -1 AND meter_id = -1",
        tier,
      )
      const live = all<{ first_letter: string; n: number }>(
        `SELECT first_letter, COUNT(*) n FROM game_baits gb WHERE ${sql} GROUP BY 1`,
      )
      const asMap = (rows: Array<{ first_letter: string; n: number }>) =>
        Object.fromEntries(rows.map((r) => [r.first_letter, Number(r.n)]))
      expect(asMap(stored)).toEqual(asMap(live))
    }
  })

  it("never stores a zero or a NULL key — a missing row IS the zero", () => {
    expect(count("SELECT COUNT(*) n FROM combo_counts WHERE n <= 0")).toBe(0)
    expect(
      count("SELECT COUNT(*) n FROM combo_counts WHERE first_letter IS NULL OR era_id IS NULL OR meter_id IS NULL"),
    ).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// poems.rhyme, era backfill, dedup
// ═════════════════════════════════════════════════════════════════════════════

describe("poems.rhyme is the modal روي", () => {
  it("agrees with a recomputed mode for every poem that has one", () => {
    const rows = all<{ id: number; rhyme: string | null }>("SELECT id, rhyme FROM poems")
    let checked = 0
    for (const p of rows) {
      const votes = all<{ rawiyy: string; n: number }>(
        "SELECT rawiyy, COUNT(*) n FROM baits WHERE poem_id = ? AND rawiyy IS NOT NULL GROUP BY 1 ORDER BY n DESC",
        p.id,
      )
      if (votes.length === 0) {
        expect(p.rhyme).toBeNull()
        continue
      }
      const top = Number(votes[0]!.n)
      expect(votes.filter((v) => Number(v.n) === top).map((v) => v.rawiyy)).toContain(p.rhyme)
      checked++
    }
    expect(checked).toBeGreaterThan(30)
  })

  it("breaks a tie towards بيت ١", () => {
    // every poem whose modal روي is tied must have taken بيت ١'s letter
    const tied = all<{ id: number; rhyme: string }>(
      `SELECT p.id, p.rhyme FROM poems p WHERE p.rhyme IS NOT NULL AND (
         SELECT COUNT(*) FROM (SELECT COUNT(*) c FROM baits WHERE poem_id = p.id AND rawiyy IS NOT NULL
           GROUP BY rawiyy ORDER BY c DESC LIMIT 2) x GROUP BY c HAVING COUNT(*) = 2) IS NOT NULL`,
    )
    for (const p of tied) {
      const first = one<{ rawiyy: string | null }>(
        "SELECT rawiyy FROM baits WHERE poem_id = ? AND rawiyy IS NOT NULL ORDER BY position LIMIT 1",
        p.id,
      )
      expect(p.rhyme).toBe(first!.rawiyy)
    }
  })

  it("gives every poem a first_letter taken from بيت ١'s صدر", () => {
    expect(
      count(
        `SELECT COUNT(*) n FROM poems p JOIN baits b ON b.poem_id = p.id AND b.position = 1
         WHERE p.first_letter IS NOT b.first_letter OR p.preview_sadr IS NOT b.sadr OR p.preview_ajuz IS NOT b.ajuz`,
      ),
    ).toBe(0)
  })
})

describe("era backfill", () => {
  it("gives a poem with no `poet era` its شاعر's modal era", () => {
    // حاتم الطائي appears twice in the fixture: once with العصر الجاهلي, once with null
    const poet = one<{ id: number; era_id: number }>("SELECT id, era_id FROM poets WHERE name = 'حاتم الطائي'")
    expect(poet).toBeDefined()
    const jahili = one<{ id: number }>("SELECT id FROM eras WHERE slug = 'jahili'")!
    expect(poet!.era_id).toBe(jahili.id)
    const poems = all<{ era_id: number }>("SELECT era_id FROM poems WHERE poet_id = ?", poet!.id)
    expect(poems.length).toBe(2)
    for (const p of poems) expect(p.era_id).toBe(jahili.id)
  })

  it("leaves a poem null when its شاعر has no era anywhere", () => {
    expect(
      count(
        "SELECT COUNT(*) n FROM poems p JOIN poets o ON o.id = p.poet_id WHERE p.era_id IS NULL AND o.era_id IS NOT NULL",
      ),
    ).toBe(0)
    expect(count("SELECT COUNT(*) n FROM poems WHERE era_id IS NULL")).toBeGreaterThan(0)
  })
})

describe("dedup — the best copy wins", () => {
  it("keeps one row per (شاعر, مطلع), whatever the eight sources call it", () => {
    // The key is `nameKey|matla` (transform.ts `dedupKeyOf`) and pass 0 picks
    // which copy of it survives, so «جدارية» under three titles is one قصيدة.
    expect(count("SELECT COUNT(*) n FROM poems")).toBe(count("SELECT COUNT(DISTINCT dedup_key) n FROM poems"))
    const withMatla = count(
      `SELECT COUNT(*) n FROM (SELECT p.poet_id, b.sadr FROM poems p JOIN baits b ON b.poem_id = p.id AND b.position = 1
        GROUP BY p.poet_id, b.sadr HAVING COUNT(*) > 1)`,
    )
    expect(withMatla).toBe(0)
  })

  it("drops the second copy of a poem and everything that came with it", () => {
    expect(report.duplicatePoems).toBe(1)
    // the fixture's duplicate carries a poetsgate url; the original is aldiwan's
    expect(count("SELECT COUNT(*) n FROM poems WHERE url LIKE '%ViewPoem.aspx?id=999001%'")).toBe(0)
    const kept = one<{ url: string; theme_id: number | null }>(
      "SELECT url, theme_id FROM poems WHERE aldiwan_id = 16384",
    )
    expect(kept!.url).toContain("aldiwan.net")
    expect(count("SELECT COUNT(*) n FROM poems")).toBe(count("SELECT COUNT(DISTINCT dedup_key) n FROM poems"))
  })

  it("merges two spellings of one شاعر's name onto one row", () => {
    // «عنترة بن شداد» and «عنتره بن شداد» share a name_key
    const rows = all<{ id: number; name: string; poem_count: number }>(
      "SELECT id, name, poem_count FROM poets WHERE name LIKE 'عنتر%'",
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.poem_count)).toBe(2)
  })

  it("keeps poet slugs unique and non-empty", () => {
    expect(count("SELECT COUNT(*) n FROM poets")).toBe(count("SELECT COUNT(DISTINCT slug) n FROM poets"))
    expect(count("SELECT COUNT(*) n FROM poets WHERE slug IS NULL OR slug = ''")).toBe(0)
    expect(one<{ slug: string }>("SELECT slug FROM poets WHERE name = 'المتنبي'")!.slug).toMatch(/^[a-z0-9-]+$/)
  })

  it("applies the fame ladder", () => {
    expect(all<{ fame: number }>("SELECT DISTINCT fame FROM poets").length).toBeGreaterThan(1)
    expect(count("SELECT COUNT(*) n FROM poets WHERE fame < 0 OR fame > 3")).toBe(0)
    // a name in shared/famousPoets.ts is fame 3 whatever its poem count
    expect(one<{ fame: number }>("SELECT fame FROM poets WHERE name = 'المتنبي'")!.fame).toBe(3)
    // a شاعر with a description but few poems is fame 2
    expect(one<{ fame: number }>("SELECT fame FROM poets WHERE name = 'الامير منجك باشا'")!.fame).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// meta
// ═════════════════════════════════════════════════════════════════════════════

describe("meta", () => {
  const meta = (key: string) => one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)!.value

  it("records the build identity", () => {
    expect(meta("build_id")).toBe(report.buildId)
    expect(meta("built_at")).toBe(FIXTURE_BUILT_AT)
    expect(meta("schema_version")).toBe("1")
    expect(meta("source_dataset")).toBe("arbml/ashaar")
  })

  it("carries counts_json that matches the tables", () => {
    expect(JSON.parse(meta("counts_json"))).toEqual({
      poems: report.poems,
      baits: report.baits,
      poets: report.poets,
      gameBaits: report.gameBaits,
    })
  })

  it("carries facets_json with EVERY value, zeros included", () => {
    const f = JSON.parse(meta("facets_json")) as {
      eras: unknown[]
      meters: unknown[]
      themes: unknown[]
      rhymes: Array<{ letter: string; count: number }>
      firstLetters: unknown[]
    }
    expect(f.eras).toHaveLength(ERAS.length)
    expect(f.meters).toHaveLength(METERS.length)
    expect(f.themes).toHaveLength(THEMES.length)
    expect(f.rhymes).toHaveLength(28)
    expect(f.firstLetters).toHaveLength(28)
    expect(f.rhymes.map((r) => r.letter)).toEqual([...HIJAI_LETTERS])
    expect(f.rhymes.some((r) => r.count === 0)).toBe(true)
  })

  it("carries stats_json with the histograms /api/stats serves", () => {
    const s = JSON.parse(meta("stats_json")) as {
      poemLengths: Array<{ label: string; count: number }>
      topPoets: Array<{ slug: string; fame: number }>
      counts: { poems: number }
    }
    expect(s.counts.poems).toBe(report.poems)
    expect(s.poemLengths.length).toBeGreaterThan(4)
    expect(s.poemLengths.reduce((a, b) => a + b.count, 0)).toBe(report.poems)
    expect(s.topPoets.length).toBeGreaterThan(0)
    expect(s.topPoets[0]!.fame).toBe(3)
  })

  it("carries the high-frequency term set server/search.ts refuses to rank", () => {
    const terms = JSON.parse(meta("high_df_terms")) as unknown
    expect(Array.isArray(terms)).toBe(true)
    // A 47-poem fixture has nothing near HIGH_DF_MIN, which is itself the
    // assertion: the guard is off unless the corpus earns it.
    expect(terms).toEqual([])
  })

  it("carries amendment 10's per-letter supply and demand over the game pool", () => {
    const letters = JSON.parse(meta("letters_json")) as Array<{
      letter: string
      startsWith: number
      endsWith: number
    }>
    expect(letters).toHaveLength(28)
    expect(letters.map((l) => l.letter)).toEqual([...HIJAI_LETTERS])
    expect(letters.reduce((a, l) => a + l.startsWith, 0)).toBe(report.gameBaits)
    expect(letters.reduce((a, l) => a + l.endsWith, 0)).toBe(report.gameBaits)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Shipped pragmas
// ═════════════════════════════════════════════════════════════════════════════

describe("the shipped artefact", () => {
  it("ships with an 8 KiB page size and a DELETE journal", () => {
    expect(Number(one<{ page_size: number }>("PRAGMA page_size")!.page_size)).toBe(8192)
    expect(String(one<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode)).toBe("delete")
  })

  it("has been ANALYZEd, so the planner has statistics", () => {
    expect(count("SELECT COUNT(*) n FROM sqlite_stat1")).toBeGreaterThan(0)
  })

  it("carries every index design-server.md §5 names", () => {
    const idx = new Set(
      all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").map(
        (r) => r.name,
      ),
    )
    for (const name of [
      "poets_letter", "poets_era", "poets_fame",
      "poems_poet", "poems_filter", "poems_meter", "poems_rhyme", "poems_theme", "poems_first",
      "baits_poem_pos", "baits_hfull", "baits_hsadr",
      "gb_pick", "gb_facet", "gb_rand", "gb_chain", "gb_poem", "gb_bias",
    ]) {
      expect(idx.has(name), `missing index ${name}`).toBe(true)
    }
  })

  it("drops the _playable scratch table", () => {
    expect(count("SELECT COUNT(*) n FROM sqlite_master WHERE name = '_playable'")).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Idempotency — amendment 17
// ═════════════════════════════════════════════════════════════════════════════

describe("idempotency (amendment 17)", () => {
  const TABLES = [
    "meta", "eras", "themes", "meters", "poets", "poems", "baits", "game_baits", "combo_counts",
  ] as const

  function dump(file: string): Record<string, string> {
    const d = new DatabaseSync(file, { readOnly: true })
    try {
      const out: Record<string, string> = {}
      for (const t of TABLES) {
        const stmt = d.prepare(`SELECT * FROM ${t}`)
        // h_full/h_sadr are signed 64-bit — wider than a JS number, so node:sqlite
        // must be told to hand them back as BigInt rather than throw
        stmt.setReadBigInts(true)
        const rows = stmt.all() as Array<Record<string, unknown>>
        // the artefact holds signed 64-bit hashes, which JSON cannot serialise raw
        out[t] = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))
      }
      return out
    } finally {
      d.close()
    }
  }

  it("ingests the fixture twice into identical row sets", async () => {
    const second = await buildFixtureDb(DB_B)
    expect(second.buildId).toBe(report.buildId)
    expect({ ...second, out: "", elapsedMs: 0, peakRssMb: 0 }).toEqual({
      ...report,
      out: "",
      elapsedMs: 0,
      peakRssMb: 0,
    })

    const a = dump(DB_A)
    const b = dump(DB_B)
    for (const t of TABLES) {
      expect(b[t], `table ${t} differs between builds`).toBe(a[t])
    }
  }, 60_000)

  it("is byte-identical, because bucket/rand come from (dedup_key, position)", () => {
    const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex")
    expect(sha(DB_B)).toBe(sha(DB_A))
  })
})
