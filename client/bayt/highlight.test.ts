/**
 * Search highlighting must never cut a letter away from its حركة.
 *
 * `findFolded` answers in ORIGINAL offsets, but the fold DELETES marks, so the
 * end offset of a match points just past the base letter and any trailing
 * تشكيل falls outside it. Rendered, that puts the fatha in a text node of its
 * own, detached from its ل and drifting off the letter it belongs to.
 * `client/bayt/rawiyy.ts::splitRawiyy` solves the same problem for the روي
 * underline; `markRanges` now does it for the <mark>.
 */
import { describe, expect, it } from "vitest"
import { markRanges, markedTerms } from "./highlight.tsx"

describe("markRanges", () => {
  it("carries the trailing حركة inside the match", () => {
    const text = "يا لَيلَ دانِ"
    const [hit] = markRanges(text, ["ليل"])
    expect(hit).toBeDefined()
    expect(text.slice(hit!.start, hit!.end)).toBe("لَيلَ")
    // nothing left over to float away
    expect(text[hit!.end]).toBe(" ")
  })

  it("carries a shadda AND the حركة on it", () => {
    const text = "وَالسَّيفُ"
    const [hit] = markRanges(text, ["والسيف"])
    expect(text.slice(hit!.start, hit!.end)).toBe(text)
  })

  it("still matches unvocalised text exactly", () => {
    expect(markRanges("الخيل والليل", ["الخيل"])).toEqual([{ start: 0, end: 5 }])
  })

  it("drops overlaps rather than nesting two underlines", () => {
    const ranges = markRanges("الخيلُ والخيلُ", ["الخيل", "خيل"])
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.start).toBeGreaterThanOrEqual(ranges[i - 1]!.end)
  })

  it("markedTerms pulls the »…« words out longest-first", () => {
    expect(markedTerms("»الخيل« و»ليل«")).toEqual(["الخيل", "ليل"])
    expect(markedTerms(null)).toEqual([])
  })
})
