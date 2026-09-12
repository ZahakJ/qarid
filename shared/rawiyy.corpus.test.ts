/**
 * design-server.md §11(c) — the spike that decides whether the whole game is
 * playable: does `rawiyyOf` agree with itself across the أبيات of one قصيدة?
 *
 * A قصيدة عمودية is monorhyme by definition, so every عجز in it must yield the
 * same روي. Measuring the modal letter's share per poem measures the peel rules
 * directly, against real text, at a scale no hand-written golden table reaches.
 *
 * Measured over `data/sample-2000.jsonl` (2,000 evenly spaced real records) on
 * 2026-08-23, with the three peel refinements in arabic.ts:
 *
 *   | pool (≥4 أبيات)              | poems | mean modal agreement |
 *   |------------------------------|-------|----------------------|
 *   | metre resolves to a بحر      |   668 |            **95.4%** |
 *   | metre column is null         |   679 |                74.9% |
 *   | موشح / شعر حر / نثر          |    30 |                42.6% |
 *   | everything                   | 1,395 |                84.3% |
 *
 * The بحر pool is the one that matters: `game_baits` only admits poems whose
 * metre is one of the sixteen (design-server.md §5), so 95.4% is the number the
 * duel actually runs on. The موشح and free-verse figures are not failures —
 * those forms are not monorhyme, which is exactly why §3 keeps them out of the
 * pool. The null-metre bucket is a mixture of both.
 *
 * The sample is a gitignored profiling artefact, so this suite no-ops in a
 * fresh checkout. Regenerate it with `node scripts/ingest/profile.ts`.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { cleanText, rawiyyOf } from "./arabic.ts"
import { normalizeMeter } from "./meters.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = path.join(HERE, "..", "data", "sample-2000.jsonl")
const HAVE_SAMPLE = fs.existsSync(SAMPLE)

interface Poem {
  meterKind: string
  ajuz: string[]
}

function readPoems(): Poem[] {
  const out: Poem[] = []
  for (const line of fs.readFileSync(SAMPLE, "utf8").split("\n")) {
    if (line.trim() === "") continue
    const rec = JSON.parse(line) as Record<string, unknown>
    const verses = Array.isArray(rec["poem verses"]) ? (rec["poem verses"] as unknown[]) : []
    // Same pairing transform.ts uses: clean, drop blanks, pair (2i, 2i+1).
    const hemis = verses.map((v) => cleanText(typeof v === "string" ? v : "")).filter((h) => h !== "")
    const ajuz: string[] = []
    for (let i = 0; i + 1 < hemis.length; i += 2) ajuz.push(hemis[i + 1]!)
    if (ajuz.length < 4) continue
    const rawMeter = typeof rec["poem meter"] === "string" ? (rec["poem meter"] as string) : null
    out.push({ meterKind: rawMeter === null ? "null" : normalizeMeter(rawMeter).kind, ajuz })
  }
  return out
}

/** The modal روي's share of one poem's أبيات, or null when none resolves. */
function agreement(ajuz: string[]): number | null {
  const tally = new Map<string, number>()
  for (const a of ajuz) {
    const r = rawiyyOf(a).rawiyy
    if (r !== null) tally.set(r, (tally.get(r) ?? 0) + 1)
  }
  let best = 0
  for (const n of tally.values()) if (n > best) best = n
  return best === 0 ? null : best / ajuz.length
}

describe.skipIf(!HAVE_SAMPLE)("rawiyyOf agreement over the real corpus", () => {
  const poems = HAVE_SAMPLE ? readPoems() : []

  it("has a sample worth measuring", () => {
    expect(poems.length).toBeGreaterThan(500)
  })

  it("agrees with itself ≥90% of the time on the game pool", () => {
    const scores = poems
      .filter((p) => p.meterKind === "bahr")
      .map((p) => agreement(p.ajuz))
      .filter((s): s is number => s !== null)

    expect(scores.length).toBeGreaterThan(200) // §11(c) asked for 200 real عجز
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    expect(mean).toBeGreaterThanOrEqual(0.9)
  })

  it("gets most قصائد on a بحر exactly right, bayt for bayt", () => {
    const scores = poems
      .filter((p) => p.meterKind === "bahr")
      .map((p) => agreement(p.ajuz))
      .filter((s): s is number => s !== null)
    const perfect = scores.filter((s) => s === 1).length / scores.length
    expect(perfect).toBeGreaterThanOrEqual(0.75)
  })

  it("does not fall over on the non-monorhyme forms it is not built for", () => {
    // موشح, شعر حر and نثر genuinely change rhyme; this only pins that they
    // still resolve to SOME letter rather than throwing or returning null.
    const others = poems.filter((p) => ["muwashah", "free", "prose"].includes(p.meterKind))
    for (const p of others) expect(agreement(p.ajuz), p.ajuz[0]).not.toBeNull()
  })

  it("resolves a روي for essentially every عجز in the corpus", () => {
    let total = 0
    let resolved = 0
    for (const p of poems) {
      for (const a of p.ajuz) {
        total++
        if (rawiyyOf(a).rawiyy !== null) resolved++
      }
    }
    expect(resolved / total).toBeGreaterThan(0.99)
  })
})
