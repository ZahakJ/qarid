/**
 * The شعراء index's row maths.
 *
 * Two things are pinned here, and both of them shipped broken once:
 *
 *  • THE FOLD. A section never continues on the previous section's row, and a
 *    heading always takes a row of its own — that is what makes the window
 *    maths a pure function of ONE height.
 *  • THE HEIGHT CONTRACT. `ROW_POET` in the module and `--row-poet` in
 *    client/styles/poets.css are the same number written twice. When they
 *    drift, the card's own tracks no longer add up to the row and the last
 *    line of a ترجمة is sliced in half by `overflow: hidden` (measured at v1.1,
 *    where the row was 156px and the content wanted 172).
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { PoetSummary } from "../../shared/schema.ts"
import { enterIndex, gridRows, MAX_STAGGER, ROW_POET, ROW_POET_NARROW } from "./poetsGrid.ts"

function poet(name: string, letter: string): PoetSummary {
  return {
    slug: name,
    name,
    letter: letter as PoetSummary["letter"],
    era: null,
    location: null,
    description: null,
    fame: 0,
    poemCount: 1,
    baitCount: 1,
  }
}

const ALIF = [poet("a1", "ا"), poet("a2", "ا"), poet("a3", "ا"), poet("a4", "ا")]
const BA = [poet("b1", "ب"), poet("b2", "ب")]

describe("gridRows", () => {
  it("folds cards into rows of `cols`", () => {
    const rows = gridRows(ALIF, 3, false)
    expect(rows.map((r) => (r.kind === "poets" ? r.poets.length : "head"))).toEqual([3, 1])
  })

  it("inserts a heading whenever the letter changes", () => {
    const rows = gridRows([...ALIF, ...BA], 3, true)
    expect(rows.map((r) => (r.kind === "head" ? `head:${r.letter}` : `poets:${r.poets.length}`))).toEqual([
      "head:ا",
      "poets:3",
      "poets:1",
      "head:ب",
      "poets:2",
    ])
  })

  it("never continues a section on the previous section's row", () => {
    // ا has four poets and the grid is three wide: the fourth sits alone and ب
    // starts a new row under its own heading, not beside a poet from الألف.
    for (const row of gridRows([...ALIF, ...BA], 3, true)) {
      if (row.kind !== "poets") continue
      expect(new Set(row.poets.map((p) => p.letter)).size).toBe(1)
    }
  })

  it("emits no headings when the list is a ranking", () => {
    const rows = gridRows([...ALIF, ...BA], 3, false)
    expect(rows.every((r) => r.kind === "poets")).toBe(true)
    expect(rows.flatMap((r) => (r.kind === "poets" ? r.poets : []))).toHaveLength(6)
  })

  it("keeps every poet, in order, whatever the width", () => {
    for (const cols of [1, 2, 3, 4, 7]) {
      const flat = gridRows([...ALIF, ...BA], cols, true).flatMap((r) => (r.kind === "poets" ? r.poets : []))
      expect(flat.map((p) => p.slug)).toEqual([...ALIF, ...BA].map((p) => p.slug))
    }
  })

  it("degrades a nonsense width to one column instead of looping forever", () => {
    expect(gridRows(ALIF, 0, false)).toHaveLength(4)
    expect(gridRows(ALIF, -3, false)).toHaveLength(4)
    expect(gridRows(ALIF, 2.7, false)).toHaveLength(2)
  })

  it("is empty for an empty list", () => {
    expect(gridRows([], 3, true)).toEqual([])
  })
})

describe("enterIndex", () => {
  it("staggers at most eight steps (v2.md §6)", () => {
    expect(enterIndex(0, 0)).toBe(0)
    expect(enterIndex(7, 0)).toBe(MAX_STAGGER - 1)
    expect(enterIndex(40, 0)).toBe(MAX_STAGGER - 1)
  })

  it("does not stagger a row built mid-scroll", () => {
    // the window has moved: these rows are created outside the viewport and a
    // delay would either be invisible or arrive late under the reader's eye
    expect(enterIndex(0, 12)).toBe(0)
    expect(enterIndex(5, 12)).toBe(0)
  })
})

describe("the row-height contract", () => {
  const css = readFileSync(fileURLToPath(new URL("../styles/poets.css", import.meta.url)), "utf8")

  const declared = (name: string): number[] =>
    [...css.matchAll(new RegExp(`--${name}:\\s*(\\d+)px`, "g"))].map((m) => Number(m[1]))

  it("declares --row-poet twice: the wide value, then the narrow one", () => {
    expect(declared("row-poet")).toEqual([ROW_POET, ROW_POET_NARROW])
  })

  it("keeps the narrow row from being taller than the wide one by accident", () => {
    // one column at ≤860px, so the card needs LESS height, never more
    expect(ROW_POET_NARROW).toBeLessThanOrEqual(ROW_POET)
  })

  it("leaves room for the card's own tracks", () => {
    // name (2 lines of Aref Ruqaa at 1.7 × 16px) + meta + two lines of ترجمة,
    // two 8px gaps, 16px padding either side, and the row's own 12px gap
    const content = Math.ceil(2 * 1.7 * 16) + 28 + Math.ceil(2 * 1.6 * 13) + 2 * 8
    expect(ROW_POET).toBeGreaterThanOrEqual(content + 2 * 16 + 12)
  })
})
