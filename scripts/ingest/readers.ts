import fs from "node:fs"
import readline from "node:readline"
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet"
import { compressors } from "hyparquet-compressors"

/**
 * The 11 flat columns of arbml/ashaar we ever touch. The 12th, `poem
 * description`, is a 5-level nested DOM struct that is roughly half the
 * parquet; column-projecting these 11 keeps it off disk and out of RAM.
 * Order is the file's own schema order — sample/fixture JSONL keeps it.
 */
export const RAW_COLUMNS = [
  "poem title",
  "poem meter",
  "poem verses",
  "poem theme",
  "poem url",
  "poet name",
  "poet description",
  "poet url",
  "poet era",
  "poet location",
  "poem language type",
] as const

/**
 * One dataset row, verbatim. NOTHING is cleaned, trimmed or normalised here —
 * meter values genuinely carry trailing spaces and the profiler must see them.
 * Cleaning happens in transform.ts and nowhere else.
 */
export type RawPoem = {
  title: string | null
  meter: string | null
  verses: string[]
  theme: string | null
  poemUrl: string | null
  poetName: string | null
  poetDescription: string | null
  poetUrl: string | null
  poetEra: string | null
  poetLocation: string | null
  langType: string | null
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return typeof v === "string" ? v : String(v)
}

/** hyparquet hands LIST columns back as plain arrays; tolerate the raw
 *  `{list:[{element}]}` shape too in case a future writer emits it. */
function toVerses(v: unknown): string[] {
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) return v.map((x) => str(x) ?? "")
  if (typeof v === "object" && Array.isArray((v as { list?: unknown[] }).list)) {
    return (v as { list: unknown[] }).list.map((x) =>
      str(x && typeof x === "object" && "element" in x ? (x as { element: unknown }).element : x) ?? "",
    )
  }
  return [str(v) ?? ""]
}

/** raw column-keyed record (parquet row or JSONL line) → RawPoem */
export function fromRawRecord(rec: Record<string, unknown>): RawPoem {
  return {
    title: str(rec["poem title"]),
    meter: str(rec["poem meter"]),
    verses: toVerses(rec["poem verses"]),
    theme: str(rec["poem theme"]),
    poemUrl: str(rec["poem url"]),
    poetName: str(rec["poet name"]),
    poetDescription: str(rec["poet description"]),
    poetUrl: str(rec["poet url"]),
    poetEra: str(rec["poet era"]),
    poetLocation: str(rec["poet location"]),
    langType: str(rec["poem language type"]),
  }
}

/** RawPoem → raw column-keyed record, so sample/fixture JSONL round-trips */
export function toRawRecord(p: RawPoem): Record<string, unknown> {
  return {
    "poem title": p.title,
    "poem meter": p.meter,
    "poem verses": p.verses,
    "poem theme": p.theme,
    "poem url": p.poemUrl,
    "poet name": p.poetName,
    "poet description": p.poetDescription,
    "poet url": p.poetUrl,
    "poet era": p.poetEra,
    "poet location": p.poetLocation,
    "poem language type": p.langType,
  }
}

async function* readParquet(src: string): AsyncGenerator<RawPoem> {
  const file = await asyncBufferFromFile(src)
  const metadata = await parquetMetadataAsync(file)
  let rowStart = 0
  // Row-group at a time (1,000 rows each in these shards): bounded memory,
  // and every read is column-projected so `poem description` is never fetched.
  for (const group of metadata.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows)
    const rows = await parquetReadObjects({
      file,
      metadata,
      compressors,
      columns: RAW_COLUMNS as unknown as string[],
      rowStart,
      rowEnd,
      rowFormat: "object",
      utf8: true,
    })
    for (const row of rows) yield fromRawRecord(row)
    rowStart = rowEnd
  }
}

async function* readJsonl(src: string): AsyncGenerator<RawPoem> {
  const rl = readline.createInterface({
    input: fs.createReadStream(src, "utf8"),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      yield fromRawRecord(JSON.parse(line) as Record<string, unknown>)
    }
  } finally {
    rl.close()
  }
}

/**
 * Stream dataset rows from a `.parquet` shard or a `.jsonl` file (fixtures,
 * the 2,000-row sample, and the `uv run --with pyarrow` escape hatch all speak
 * JSONL with the same raw column names).
 */
export function readRecords(src: string): AsyncGenerator<RawPoem> {
  if (src.endsWith(".parquet")) return readParquet(src)
  if (src.endsWith(".jsonl") || src.endsWith(".ndjson")) return readJsonl(src)
  throw new Error(`readRecords: unsupported source ${src} (want .parquet or .jsonl)`)
}
