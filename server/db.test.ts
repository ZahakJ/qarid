import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { openDb, openDbIfPresent, type Db } from "./db.ts"

const TMP = path.join(import.meta.dirname, "..", "data", "test-db")
const DB_PATH = path.join(TMP, "probe.db")
let db: Db

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  const w = new DatabaseSync(DB_PATH)
  w.exec("PRAGMA page_size = 8192")
  w.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  w.exec("INSERT INTO meta VALUES ('schema_version','1'),('build_id','probe')")
  // FTS5 is the whole point of the Phase-0 spike — assert it survives a
  // read-only reopen, bm25 and snippet included.
  w.exec("CREATE VIRTUAL TABLE baits_fts USING fts5(norm, tokenize='unicode61')")
  const ins = w.prepare("INSERT INTO baits_fts(rowid, norm) VALUES (?, ?)")
  ins.run(1, "وما نيل المطالب بالتمني ولكن تؤخذ الدنيا غلابا")
  ins.run(2, "على قدر أهل العزم تأتي العزائم وتأتي على قدر الكرام المكارم")
  w.close()
  db = openDb(DB_PATH)
})

afterAll(() => {
  db?.close()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe("openDb", () => {
  it("reads rows", () => {
    const row = db.q("SELECT value FROM meta WHERE key = ?").get("build_id") as { value: string }
    expect(row.value).toBe("probe")
  })

  it("refuses writes (readOnly + query_only)", () => {
    expect(() => db.raw.exec("INSERT INTO meta VALUES ('x','y')")).toThrow()
    expect(() => db.raw.exec("DROP TABLE meta")).toThrow()
  })

  it("applies the read pragmas", () => {
    const qo = db.q("PRAGMA query_only").get() as { query_only: number }
    expect(qo.query_only).toBe(1)
    const ts = db.q("PRAGMA temp_store").get() as { temp_store: number }
    expect(ts.temp_store).toBe(2) // MEMORY
  })

  it("caches prepared statements by sql text", () => {
    const sql = "SELECT value FROM meta WHERE key = ?"
    expect(db.q(sql)).toBe(db.q(sql))
    expect(db.q(sql)).not.toBe(db.q("SELECT key FROM meta WHERE key = ?"))
  })

  it("serves FTS5 MATCH, bm25 and snippet from the read-only handle", () => {
    const hits = db.q("SELECT rowid FROM baits_fts WHERE baits_fts MATCH ?").all('"المطالب"') as Array<{ rowid: number }>
    expect(hits.map((h) => h.rowid)).toEqual([1])

    const ranked = db
      .q("SELECT rowid, bm25(baits_fts) AS score FROM baits_fts WHERE baits_fts MATCH ? ORDER BY score")
      .all('"قدر"') as Array<{ rowid: number; score: number }>
    expect(ranked).toHaveLength(1)
    expect(ranked[0]!.score).toBeLessThan(0)

    const snip = db
      .q("SELECT snippet(baits_fts, 0, '»', '«', '…', 8) AS s FROM baits_fts WHERE baits_fts MATCH ?")
      .all('"العزم"') as Array<{ s: string }>
    expect(snip[0]!.s).toContain("»العزم«")

    // phrase query, which is what ftsQuery emits for quoted input
    const phrase = db.q("SELECT rowid FROM baits_fts WHERE baits_fts MATCH ?").all('"أهل العزم"') as Array<{ rowid: number }>
    expect(phrase.map((h) => h.rowid)).toEqual([2])
  })
})

describe("openDbIfPresent", () => {
  it("returns null instead of throwing when the corpus is missing", () => {
    expect(openDbIfPresent(path.join(TMP, "absent.db"))).toBeNull()
  })

  it("opens a present database", () => {
    const d = openDbIfPresent(DB_PATH)
    expect(d).not.toBeNull()
    d!.close()
  })
})
