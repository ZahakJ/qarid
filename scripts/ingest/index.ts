/**
 * `scripts/ingest/index.ts` — the ingest CLI.
 *
 *   node scripts/ingest/index.ts fetch     # verify data/raw against the pinned sha256s
 *   node scripts/ingest/index.ts build     # data/raw/*.parquet  → data/qarid.db   (15–30 min)
 *   node scripts/ingest/index.ts fixture   # test/fixtures/*.jsonl → data/fixture.db (< 1 s)
 *   node scripts/ingest/index.ts stats     # what an already-built artefact contains
 *
 * `build` and `fixture` are the same `buildDatabase` over different sources —
 * design-server.md §6 is explicit that the fixture must go through the REAL
 * ingest path, so a bug that only shows up on the corpus cannot hide behind a
 * bespoke test builder.
 */

import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { SOURCE_REVISION } from "../../shared/constants.ts"
import { buildDatabase, DEFAULT_OUT, DEFAULT_SOURCES } from "./build.ts"
import { fetchSources } from "./fetch.ts"

export const FIXTURE_SOURCE = "test/fixtures/ashaar-sample.jsonl"
export const FIXTURE_OUT = "data/fixture.db"

const USAGE = `قريض ingest

  fetch                       verify (and if necessary download) data/raw/*.parquet
  build [src...] [out]        build the corpus artefact   (default: ${DEFAULT_SOURCES.join(" ")} → ${DEFAULT_OUT})
  fixture [src] [out]         build the test artefact     (default: ${FIXTURE_SOURCE} → ${FIXTURE_OUT})
  stats [db]                  summarise a built artefact  (default: ${DEFAULT_OUT})
`

export async function main(argv: readonly string[]): Promise<number> {
  const [command = "", ...rest] = argv

  switch (command) {
    case "fetch": {
      const results = await fetchSources({ dir: "data/raw" })
      for (const r of results) console.log(`${r.outcome.padEnd(10)} ${r.path}`)
      return 0
    }

    case "build": {
      const { sources, out } = splitArgs(rest, DEFAULT_SOURCES, DEFAULT_OUT)
      for (const src of sources) {
        if (!fs.existsSync(src)) {
          console.error(`ingest: no such source ${src} — run \`node scripts/ingest/index.ts fetch\` first`)
          return 1
        }
      }
      const report = await buildDatabase({ sources, out, sourceRevision: SOURCE_REVISION })
      console.log(JSON.stringify(report, null, 2))
      return 0
    }

    case "fixture": {
      const { sources, out } = splitArgs(rest, [FIXTURE_SOURCE], FIXTURE_OUT)
      const report = await buildDatabase({ sources, out, sourceRevision: `fixture@${SOURCE_REVISION.slice(0, 7)}` })
      console.log(JSON.stringify(report, null, 2))
      return 0
    }

    case "stats": {
      const dbPath = rest[0] ?? DEFAULT_OUT
      if (!fs.existsSync(dbPath)) {
        console.error(`ingest: no artefact at ${dbPath}`)
        return 1
      }
      printStats(dbPath)
      return 0
    }

    default:
      console.log(USAGE)
      return command === "" || command === "help" || command === "--help" ? 0 : 1
  }
}

/** `[a.jsonl b.jsonl out.db]` → sources + out; a lone argument is the SOURCE. */
function splitArgs(
  args: readonly string[],
  defaultSources: readonly string[],
  defaultOut: string,
): { sources: string[]; out: string } {
  if (args.length === 0) return { sources: [...defaultSources], out: defaultOut }
  if (args.length === 1) return { sources: [args[0]!], out: defaultOut }
  return { sources: args.slice(0, -1), out: args[args.length - 1]! }
}

function printStats(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const meta = new Map<string, string>()
    for (const row of db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>) {
      meta.set(row.key, row.value)
    }
    const bytes = fs.statSync(dbPath).size
    console.log(`${path.resolve(dbPath)}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
    console.log(`build_id        ${meta.get("build_id") ?? "?"}`)
    console.log(`built_at        ${meta.get("built_at") ?? "?"}`)
    console.log(`schema_version  ${meta.get("schema_version") ?? "?"}`)
    console.log(`source_revision ${meta.get("source_revision") || "(none)"}`)
    console.log(`counts          ${meta.get("counts_json") ?? "{}"}`)

    for (const [label, sql] of [
      ["poems", "SELECT COUNT(*) AS n FROM poems"],
      ["baits", "SELECT COUNT(*) AS n FROM baits"],
      ["poets", "SELECT COUNT(*) AS n FROM poets"],
      ["game_baits", "SELECT COUNT(*) AS n FROM game_baits"],
      ["combo_counts", "SELECT COUNT(*) AS n FROM combo_counts"],
      ["with tashkeel", "SELECT COUNT(*) AS n FROM poems WHERE has_tashkeel = 1"],
      ["partial baits", "SELECT COUNT(*) AS n FROM baits WHERE is_partial = 1"],
    ] as const) {
      const row = db.prepare(sql).get() as { n: number | bigint }
      console.log(`${label.padEnd(15)} ${Number(row.n).toLocaleString("en")}`)
    }
  } finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2))
}
