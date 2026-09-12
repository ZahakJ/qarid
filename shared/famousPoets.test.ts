/**
 * The fame list only works if its spellings are the corpus's spellings. A
 * curated name that matches nothing fails silently — the poet it was meant to
 * promote quietly stays at fame 0 and never appears in the مبتدئ pool — so the
 * overlap is measured here rather than assumed.
 *
 * `data/sample-2000.jsonl` (2,000 evenly spaced real records) is gitignored, so
 * the strong check runs only when the profiler has been run. The structural
 * checks below hold with no data at all.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { normalizeArabic } from "./arabic.ts"
import { FAMOUS_POET_KEYS, FAMOUS_POET_NAMES, isFamousPoet } from "./famousPoets.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = path.join(HERE, "..", "data", "sample-2000.jsonl")

function samplePoetKeys(): Set<string> | null {
  if (!fs.existsSync(SAMPLE)) return null
  const keys = new Set<string>()
  for (const line of fs.readFileSync(SAMPLE, "utf8").split("\n")) {
    if (line.trim() === "") continue
    const rec = JSON.parse(line) as Record<string, unknown>
    const name = rec["poet name"]
    if (typeof name === "string") keys.add(normalizeArabic(name))
  }
  return keys
}

describe("the famous-poets canon", () => {
  it("is a substantial list with no duplicate identities", () => {
    expect(FAMOUS_POET_NAMES.length).toBeGreaterThanOrEqual(120)
    expect(FAMOUS_POET_KEYS.size).toBe(FAMOUS_POET_NAMES.length)
  })

  it("keys on name_key — the same key poets.name_key is UNIQUE on", () => {
    for (const name of FAMOUS_POET_NAMES) {
      const key = normalizeArabic(name)
      expect(key, name).not.toBe("")
      expect(FAMOUS_POET_KEYS.has(key), name).toBe(true)
      // Normalising twice must not move it, or the build-time lookup misses.
      expect(normalizeArabic(key), name).toBe(key)
    }
  })

  it("holds the poets a reader would name first", () => {
    for (const n of [
      "المتنبي", "أبو تمام", "البحتري", "أبو العلاء المعري", "امرؤ القيس",
      "الفرزدق", "جرير", "الخنساء", "ابن زيدون", "أحمد شوقي", "نزار قباني",
      "محمود درويش", "بدر شاكر السياب", "نازك الملائكة",
    ]) {
      expect(isFamousPoet(n), n).toBe(true)
    }
  })

  it("matches across orthography — «أبو نواس» and «ابو نواس» are one شاعر", () => {
    // The corpus files 25 poems under the first spelling and 1,172 under the
    // second; name_key is what makes them the same row and the same fame.
    expect(isFamousPoet("أبو نواس")).toBe(true)
    expect(isFamousPoet("ابو نواس")).toBe(true)
    expect(isFamousPoet("  أبو   نواس  ")).toBe(true)
  })

  it("does not claim someone it has never heard of", () => {
    expect(isFamousPoet("فلان الفلاني")).toBe(false)
    expect(isFamousPoet("")).toBe(false)
    expect(isFamousPoet(null)).toBe(false)
  })

  it("overlaps the real corpus by far more than the 40-name floor", () => {
    const inSample = samplePoetKeys()
    if (inSample === null) return // profiler not run in this checkout
    const hits = [...FAMOUS_POET_KEYS].filter((k) => inSample.has(k))
    expect(hits.length).toBeGreaterThanOrEqual(40)
  })

  it("has no entry that the corpus sample contradicts outright", () => {
    const inSample = samplePoetKeys()
    if (inSample === null) return
    // A 2,000-poem sample cannot contain all ~170; it should contain most.
    const hits = [...FAMOUS_POET_KEYS].filter((k) => inSample.has(k))
    expect(hits.length / FAMOUS_POET_KEYS.size).toBeGreaterThan(0.6)
  })
})
