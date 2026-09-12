/**
 * The 7×4 letter grid's one rule: DISABLED AT ZERO, never hidden.
 *
 * A grid that drops letters as you filter stops being a map of the alphabet —
 * the reader can no longer tell «there is no قصيدة on ظ under this عصر» from
 * «ظ is not a letter this product knows about». That is also the reason
 * /api/facets returns zeros at all (FacetsResponseSchema), so this test is the
 * client half of a contract whose server half is asserted in server/app.test.ts.
 */
import { describe, expect, it } from "vitest"
import { countMap, gridIsEmpty, letterCellRows, letterCells } from "./letterGrid.ts"
import { HIJAI_LETTERS, LETTER_ROWS } from "../../shared/letters.ts"
import type { LetterFacet } from "../../shared/schema.ts"

/** Every letter present, all at `n` — the shape /api/facets actually sends. */
function all(n: number): LetterFacet[] {
  return HIJAI_LETTERS.map((letter) => ({ letter, count: n }))
}

function facets(counts: Record<string, number>): LetterFacet[] {
  return HIJAI_LETTERS.map((letter) => ({ letter, count: counts[letter] ?? 0 }))
}

describe("letterCells", () => {
  it("always returns all 28 letters in هجائي order", () => {
    for (const input of [null, undefined, [], all(0), all(5), facets({ م: 3 })]) {
      const cells = letterCells(input)
      expect(cells).toHaveLength(28)
      expect(cells.map((c) => c.letter)).toEqual([...HIJAI_LETTERS])
    }
  })

  it("disables a letter at zero instead of dropping it", () => {
    const cells = letterCells(facets({ م: 12, ن: 4 }))
    const byLetter = new Map(cells.map((c) => [c.letter, c]))

    expect(byLetter.get("م")!.disabled).toBe(false)
    expect(byLetter.get("م")!.count).toBe(12)
    expect(byLetter.get("ظ")!.disabled).toBe(true)
    expect(byLetter.get("ظ")!.count).toBe(0)
    // and it is still THERE
    expect(cells.filter((c) => c.disabled)).toHaveLength(26)
  })

  it("leaves every cell enabled and countless while the facets are in flight", () => {
    // `null` means "not asked yet" — greying the whole alphabet out under a
    // pending request reads as «لا شيء هنا» (design-ux.md §6).
    const cells = letterCells(null)
    expect(cells.every((c) => c.disabled === false)).toBe(true)
    expect(cells.every((c) => c.count === 0)).toBe(true)
  })

  it("never disables the ACTIVE letter, whatever its count says", () => {
    // The reader must always be able to take the filter back off — and a
    // filtered facet response legitimately reports 0 for a value it is not
    // itself counting.
    const cells = letterCells(all(0), "ظ")
    const active = cells.find((c) => c.letter === "ظ")!
    expect(active.active).toBe(true)
    expect(active.disabled).toBe(false)
    expect(cells.filter((c) => c.disabled)).toHaveLength(27)
  })

  it("marks exactly one cell active, and none when nothing is applied", () => {
    expect(letterCells(all(1), "ل").filter((c) => c.active)).toHaveLength(1)
    expect(letterCells(all(1)).some((c) => c.active)).toBe(false)
    expect(letterCells(all(1), null).some((c) => c.active)).toBe(false)
    // a value that is not one of the 28 marks nothing rather than throwing
    expect(letterCells(all(1), "x").some((c) => c.active)).toBe(false)
  })

  it("carries the Arabic name of each letter for the accessible label", () => {
    const cells = letterCells(all(1))
    expect(cells.find((c) => c.letter === "ا")!.name).toBe("ألف")
    expect(cells.every((c) => c.name.length > 0)).toBe(true)
  })

  it("treats a partial facet list as zeros for the letters it omits", () => {
    const cells = letterCells([{ letter: "م", count: 7 }])
    expect(cells.find((c) => c.letter === "م")!.count).toBe(7)
    expect(cells.find((c) => c.letter === "ب")!.count).toBe(0)
    expect(cells.find((c) => c.letter === "ب")!.disabled).toBe(true)
  })
})

describe("letterCellRows", () => {
  it("is four rows of seven, matching LETTER_ROWS exactly", () => {
    const rows = letterCellRows(all(2))
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(row).toHaveLength(7)
    expect(rows.map((r) => r.map((c) => c.letter))).toEqual(LETTER_ROWS.map((r) => [...r]))
  })

  it("carries the same cells the flat list does", () => {
    const flat = letterCells(facets({ ر: 9 }), "ر")
    const grid = letterCellRows(facets({ ر: 9 }), "ر").flat()
    expect(new Set(grid.map((c) => c.letter))).toEqual(new Set(flat.map((c) => c.letter)))
    expect(grid.find((c) => c.letter === "ر")).toEqual(flat.find((c) => c.letter === "ر"))
  })
})

describe("countMap / gridIsEmpty", () => {
  it("reads a facet list into a letter→count map", () => {
    const m = countMap([{ letter: "م", count: 3 }])
    expect(m.get("م")).toBe(3)
    expect(m.get("ن")).toBeUndefined()
    expect(countMap(null).size).toBe(0)
    expect(countMap(undefined).size).toBe(0)
  })

  it("says a grid is empty only when a KNOWN set of counts is all zero", () => {
    expect(gridIsEmpty(all(0))).toBe(true)
    expect(gridIsEmpty(facets({ م: 1 }))).toBe(false)
    // not asked yet is not the same as empty
    expect(gridIsEmpty(null)).toBe(false)
    expect(gridIsEmpty(undefined)).toBe(false)
  })
})
