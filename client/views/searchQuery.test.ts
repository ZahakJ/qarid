/**
 * The عبارة / كلمات / أي كلمة control is the easiest thing on #/search to get
 * subtly wrong, because the three options do three DIFFERENT kinds of thing:
 * one leaves a parameter off, one sets it, and one edits the query text. These
 * tests pin which is which.
 */
import { describe, expect, it } from "vitest"
import { SEARCH_MODES, modeOfQuery, modeParam, queryFor, unquote } from "./searchQuery.ts"

describe("modeParam", () => {
  it("leaves `mode` unset for كلمات, so the server's AND→OR fallback stays armed", () => {
    expect(modeParam("words")).toBeUndefined()
  })

  it("leaves it unset for عبارة too — a phrase is quoting, not a mode", () => {
    expect(modeParam("phrase")).toBeUndefined()
  })

  it("pins mode=or for أي كلمة", () => {
    expect(modeParam("any")).toBe("or")
  })

  it("offers exactly the three modes design-ux.md §3 names", () => {
    expect(SEARCH_MODES.map((m) => m.value)).toEqual(["words", "phrase", "any"])
    expect(SEARCH_MODES.map((m) => m.label)).toEqual(["كلّ الكلمات", "عبارة", "أي كلمة"])
  })
})

describe("queryFor / unquote", () => {
  it("quotes for عبارة and leaves the words bare otherwise", () => {
    expect(queryFor("الخيل والليل", "phrase")).toBe('"الخيل والليل"')
    expect(queryFor("الخيل والليل", "words")).toBe("الخيل والليل")
    expect(queryFor("الخيل والليل", "any")).toBe("الخيل والليل")
  })

  it("does not double-quote a query that is already a phrase", () => {
    expect(queryFor('"الخيل والليل"', "phrase")).toBe('"الخيل والليل"')
    expect(queryFor("«الخيل والليل»", "phrase")).toBe('"الخيل والليل"')
  })

  it("unquotes when the reader switches back to كلمات", () => {
    expect(queryFor('"الخيل والليل"', "words")).toBe("الخيل والليل")
    expect(queryFor("«الخيل والليل»", "any")).toBe("الخيل والليل")
  })

  it("round-trips: whatever queryFor writes, modeOfQuery reads back", () => {
    for (const raw of ["الخيل", "الخيل والليل", '"الخيل"', "«الخيل والليل والبيداء»"]) {
      expect(modeOfQuery(queryFor(raw, "phrase"))).toBe("phrase")
      expect(modeOfQuery(queryFor(raw, "words"))).toBe("words")
      // أي كلمة is not in the URL at all, so it reads back as كلمات
      expect(modeOfQuery(queryFor(raw, "any"))).toBe("words")
    }
  })

  it("treats an empty query as empty in every mode, quotes included", () => {
    for (const empty of ["", "   ", '""', "«»"]) {
      expect(queryFor(empty, "phrase")).toBe("")
      expect(queryFor(empty, "words")).toBe("")
      expect(modeOfQuery(empty)).toBe("words")
    }
  })

  it("leaves an inner quote alone — only a fully wrapped query is a phrase", () => {
    expect(modeOfQuery('قال "الخيل" والليل')).toBe("words")
    expect(unquote('قال "الخيل" والليل')).toBe('قال "الخيل" والليل')
  })

  it("trims the query it sends", () => {
    expect(queryFor("  الخيل  ", "words")).toBe("الخيل")
    expect(queryFor('  " الخيل "  ', "phrase")).toBe('"الخيل"')
  })
})
