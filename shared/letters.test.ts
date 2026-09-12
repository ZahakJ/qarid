import { describe, expect, it } from "vitest"

import { foldLetter } from "./arabic.ts"
import {
  HIJAI_LETTERS,
  LETTER_GROUPS,
  LETTER_NAMES,
  LETTER_ROWS,
  RARE_RAWIYY,
  RARE_RAWIYY_WIDE,
  compareLetters,
  hijaiIndex,
  isHijaiLetter,
  isRareRawiyy,
} from "./letters.ts"

describe("the alphabet", () => {
  it("is 28 letters, هجائي order, no duplicates", () => {
    expect(HIJAI_LETTERS).toHaveLength(28)
    expect(new Set(HIJAI_LETTERS).size).toBe(28)
    expect(HIJAI_LETTERS.join("")).toBe("ابتثجحخدذرزسشصضطظعغفقكلمنهوي")
  })

  it("is closed under foldLetter — every letter folds to itself", () => {
    for (const l of HIJAI_LETTERS) expect(foldLetter(l), l).toBe(l)
  })

  it("indexes and compares in هجائي order", () => {
    expect(hijaiIndex("ا")).toBe(0)
    expect(hijaiIndex("ي")).toBe(27)
    expect(hijaiIndex("ة")).toBe(-1)
    expect(compareLetters("ا", "ي")).toBeLessThan(0)
    expect(compareLetters("ه", "و")).toBeLessThan(0)
    expect(compareLetters("م", "م")).toBe(0)
  })

  it("narrows with isHijaiLetter", () => {
    expect(isHijaiLetter("ص")).toBe(true)
    expect(isHijaiLetter("ة")).toBe(false)
    expect(isHijaiLetter("")).toBe(false)
  })

  it("names every letter", () => {
    for (const l of HIJAI_LETTERS) expect(LETTER_NAMES[l], l).toBeTruthy()
    expect(Object.keys(LETTER_NAMES)).toHaveLength(28)
  })
})

describe("display groups", () => {
  it("is a 7×4 grid that reassembles into the alphabet", () => {
    expect(LETTER_ROWS).toHaveLength(4)
    for (const row of LETTER_ROWS) expect(row).toHaveLength(7)
    expect(LETTER_ROWS.flat().join("")).toBe(HIJAI_LETTERS.join(""))
  })

  it("labels each group by its own endpoints", () => {
    expect(LETTER_GROUPS).toHaveLength(4)
    expect(LETTER_GROUPS[0]!.label).toBe("ا — خ")
    expect(LETTER_GROUPS[3]!.label).toBe("ك — ي")
  })
})

describe("rare rawiyy sets", () => {
  it("holds design-server.md §8's seven, all real letters", () => {
    expect(RARE_RAWIYY.join("")).toBe("ظذغزثضص")
    for (const l of RARE_RAWIYY) expect(isHijaiLetter(l), l).toBe(true)
  })

  it("widens to amendment 5's nine for the tailBias lever", () => {
    expect(RARE_RAWIYY_WIDE).toHaveLength(9)
    expect(RARE_RAWIYY_WIDE).toEqual([...RARE_RAWIYY, "ط", "خ"])
  })

  it("answers membership for both widths", () => {
    expect(isRareRawiyy("ظ")).toBe(true)
    expect(isRareRawiyy("خ")).toBe(false)
    expect(isRareRawiyy("خ", true)).toBe(true)
    expect(isRareRawiyy("ر", true)).toBe(false)
  })
})
