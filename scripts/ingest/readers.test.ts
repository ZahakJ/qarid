import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { readRecords, fromRawRecord, toRawRecord, RAW_COLUMNS, type RawPoem } from "./readers.ts"

const ROOT = path.join(import.meta.dirname, "..", "..")
const SHARD0 = path.join(ROOT, "data", "raw", "train-00000-of-00002.parquet")
const TMP = path.join(ROOT, "data", "test-readers")

const hasShard = fs.existsSync(SHARD0)

beforeAll(() => fs.mkdirSync(TMP, { recursive: true }))
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

describe("RAW_COLUMNS", () => {
  it("is exactly the 11 flat columns and never names the nested one", () => {
    expect(RAW_COLUMNS).toHaveLength(11)
    expect(RAW_COLUMNS).not.toContain("poem description")
    expect(RAW_COLUMNS).toContain("poet description")
  })
})

describe("fromRawRecord / toRawRecord", () => {
  it("round-trips a full record through the raw column names", () => {
    const raw = {
      "poem title": "أصبح الملك",
      "poem meter": "بحر الخفيف ",
      "poem verses": ["صدر", "عجز"],
      "poem theme": "قصيدة دينية",
      "poem url": "https://www.aldiwan.net/poem16182.html",
      "poet name": "منجك باشا",
      "poet description": "شاعر دمشقي",
      "poet url": "https://www.aldiwan.net/cat-poet-x",
      "poet era": "العصر العثماني",
      "poet location": null,
      "poem language type": "فصيح",
    }
    const p = fromRawRecord(raw)
    expect(p.title).toBe("أصبح الملك")
    // trailing space is data, not noise — the profiler has to see it
    expect(p.meter).toBe("بحر الخفيف ")
    expect(p.verses).toEqual(["صدر", "عجز"])
    expect(p.poetLocation).toBeNull()
    expect(toRawRecord(p)).toEqual(raw)
  })

  it("treats missing and null columns as null, never undefined", () => {
    const p = fromRawRecord({})
    expect(p.meter).toBeNull()
    expect(p.theme).toBeNull()
    expect(p.poetEra).toBeNull()
    expect(p.verses).toEqual([])
  })

  it("accepts the raw parquet LIST shape for verses", () => {
    const p = fromRawRecord({ "poem verses": { list: [{ element: "أ" }, { element: "ب" }] } })
    expect(p.verses).toEqual(["أ", "ب"])
  })
})

describe("readRecords over .jsonl", () => {
  it("yields one RawPoem per non-blank line", async () => {
    const file = path.join(TMP, "two.jsonl")
    const rows: RawPoem[] = [
      { title: "أ", meter: "الطويل", verses: ["a", "b"], theme: null, poemUrl: null, poetName: "ش", poetDescription: null, poetUrl: null, poetEra: null, poetLocation: null, langType: "فصيح" },
      { title: "ب", meter: null, verses: [], theme: "قصيدة مدح", poemUrl: null, poetName: "ع", poetDescription: null, poetUrl: null, poetEra: "العصر العباسي", poetLocation: null, langType: null },
    ]
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(toRawRecord(r))).join("\n") + "\n\n")
    const got: RawPoem[] = []
    for await (const r of readRecords(file)) got.push(r)
    expect(got).toEqual(rows)
  })

  it("rejects an unsupported extension", () => {
    expect(() => readRecords("/nope/x.csv")).toThrow(/unsupported source/)
  })
})

describe.skipIf(!hasShard)("readRecords over .parquet", () => {
  it("streams the first row group with only the 11 flat columns", async () => {
    const seen: RawPoem[] = []
    for await (const r of readRecords(SHARD0)) {
      seen.push(r)
      if (seen.length >= 1000) break // one row group; the shard has 128
    }
    expect(seen).toHaveLength(1000)
    const first = seen[0]!
    expect(first.title).toBe("أصبح الملك للذي فطر الخلق")
    expect(first.meter).toBe("بحر الخفيف")
    expect(first.poemUrl).toBe("https://www.aldiwan.net/poem16182.html")
    expect(first.poetUrl).toBe("https://www.aldiwan.net/cat-poet-alamir-mnczyk-pasha")
    expect(first.poetEra).toBe("العصر العثماني")
    expect(Array.isArray(first.verses)).toBe(true)
    expect(first.verses.length).toBeGreaterThan(3)
    expect(first.verses[0]).toContain("أَصبَحَ")
    // the nested `poem description` column must never surface
    expect(Object.keys(first)).not.toContain("poem description")
    expect(Object.keys(first).sort()).toEqual(
      ["langType", "meter", "poemUrl", "poetDescription", "poetEra", "poetLocation", "poetName", "poetUrl", "theme", "title", "verses"],
    )
    // every yielded row is a real record, not a hole
    for (const r of seen) expect(typeof r.verses.length).toBe("number")
  }, 60_000)
})
