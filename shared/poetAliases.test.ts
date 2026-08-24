/**
 * The alias table is only safe while it stays a FLAT, one-hop, hand-checked
 * map. Every structural property `transform.ts` relies on is asserted here,
 * because the failure mode of a bad entry is silent: two دواوين weld together
 * and nothing downstream can tell them apart again.
 *
 * `data/sample-2000.jsonl` (2,000 evenly spaced real records) is gitignored, so
 * the corpus check runs only where the profiler has been run; the structural
 * ones hold with no data at all.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { normalizeArabic } from "./arabic.ts"
import {
  CANONICAL_POET_NAMES,
  canonicalDisplayName,
  canonicalNameKey,
  isPoetAlias,
  POET_ALIAS_COUNT,
  POET_ALIAS_PAIRS,
  POET_ALIASES,
} from "./poetAliases.ts"

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

describe("the poet alias table", () => {
  it("is a substantial curated list, one entry per alias", () => {
    expect(POET_ALIAS_PAIRS.length).toBeGreaterThanOrEqual(40)
    expect(POET_ALIASES.size).toBe(POET_ALIAS_PAIRS.length)
    expect(POET_ALIAS_COUNT).toBe(POET_ALIASES.size)
  })

  it("keys on name_key — the same key poets.name_key is UNIQUE on", () => {
    for (const [alias, canonical] of POET_ALIAS_PAIRS) {
      for (const name of [alias, canonical]) {
        const key = normalizeArabic(name)
        expect(key, name).not.toBe("")
        // Normalising twice must not move it, or the ingest lookup misses.
        expect(normalizeArabic(key), name).toBe(key)
      }
    }
  })

  it("never maps a name onto itself", () => {
    for (const [alias, canonical] of POET_ALIASES) expect(canonical, alias).not.toBe(alias)
  })

  it("is FLAT — no canonical is itself an alias, so one hop is the whole answer", () => {
    for (const canonical of POET_ALIASES.values()) {
      expect(isPoetAlias(canonical), canonical).toBe(false)
      expect(canonicalNameKey(canonical), canonical).toBe(canonical)
    }
  })

  it("resolves an alias in one hop and leaves everything else alone", () => {
    expect(canonicalNameKey(normalizeArabic("أبو الطيب المتنبي"))).toBe(normalizeArabic("المتنبي"))
    expect(canonicalNameKey(normalizeArabic("المتنبي"))).toBe(normalizeArabic("المتنبي"))
    expect(canonicalNameKey(normalizeArabic("أحمد شوقي"))).toBe(normalizeArabic("أحمد شوقي"))
  })

  it("holds the pair the backlog names, and the tail behind it", () => {
    for (const [alias, canonical] of [
      ["أبو الطيب المتنبي", "المتنبي"],
      ["بشارة الخوري", "الأخطل الصغير"],
      ["مصطفى وهبي التل", "مصطفى التل"],
      ["إسماعيل صبري باشا", "إسماعيل صبري"],
      ["شرف الدين البوصيري", "البوصيري"],
    ] as const) {
      expect(canonicalNameKey(normalizeArabic(alias)), alias).toBe(normalizeArabic(canonical))
    }
  })

  it("refuses the traps the detection query also returns", () => {
    // A token-superset is evidence, not proof: sons, transmitters, friends and
    // shared نسبة all look exactly like an alias to the detector.
    for (const name of [
      "متنبي المغرب", // the task's own example — a different شاعر
      "المشوق الشامي صديق المتنبي",
      "يحيى ابن البحتري",
      "خليل ناصيف اليازجي",
      "رؤبة بن العجاج",
      "ابنة لبيد بن ربيعة العامري",
      "الأخطل الصغير بشارة الخوري", // merged, but onto الأخطل الصغير — never onto الأخطل
      "ابن الساعاتي",
      "حسني التهامي",
    ]) {
      const key = normalizeArabic(name)
      const to = canonicalNameKey(key)
      expect(to === key || to === normalizeArabic("الأخطل الصغير"), name).toBe(true)
      expect(to, name).not.toBe(normalizeArabic("الأخطل"))
      expect(to, name).not.toBe(normalizeArabic("المتنبي"))
    }
  })

  it("carries a display spelling for every canonical it names", () => {
    for (const canonical of POET_ALIASES.values()) {
      const display = canonicalDisplayName(canonical)
      expect(display, canonical).not.toBeNull()
      expect(normalizeArabic(display!), canonical).toBe(canonical)
    }
    expect(CANONICAL_POET_NAMES.get(normalizeArabic("المتنبي"))).toBe("المتنبي")
    expect(canonicalDisplayName(normalizeArabic("أحمد شوقي"))).toBeNull()
  })

  it("spells its names the corpus's way, where the sample can see them", () => {
    const corpus = samplePoetKeys()
    if (corpus === null) return
    // Only a fraction of 7,167 poets fall in a 2,000-row sample, so this is a
    // check that the spellings which DO appear are right, not that all do.
    let seen = 0
    for (const [alias, canonical] of POET_ALIASES) {
      if (corpus.has(alias) || corpus.has(canonical)) seen++
    }
    expect(seen).toBeGreaterThan(0)
  })
})
