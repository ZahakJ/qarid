/**
 * The card's three decisions that are not pixels — the only parts a canvas-less
 * runner can hold to account, and the ones that would actually go wrong.
 */
import { describe, expect, it } from "vitest"

import { CARD_MESSAGE, fileStem, fitSize, sameLine } from "./renderCard.ts"

/** A ctx stub: width is proportional to the size in the font string, as a real
 *  face is. Only `font` and `measureText` are touched by `fitSize`. */
function stubCtx(perChar = 0.5) {
  const ctx = {
    font: "",
    measureText(text: string) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 16)
      return { width: text.length * size * perChar } as TextMetrics
    },
  }
  return ctx as unknown as CanvasRenderingContext2D
}

describe("fitSize", () => {
  it("returns the starting size when the text already fits", () => {
    expect(fitSize(stubCtx(), "قِفا نَبكِ", "Amiri", 1000, 62, 26)).toBe(62)
  })

  it("shrinks — never squeezes — until the text fits the measure", () => {
    const text = "الخيل والليل والبيداء تعرفني والسيف والرمح والقرطاس والقلم"
    const max = 900
    const size = fitSize(stubCtx(), text, "Amiri", max, 62, 26)
    expect(size).toBeLessThan(62)
    const ctx = stubCtx()
    ctx.font = `400 ${size}px Amiri`
    expect(ctx.measureText(text).width).toBeLessThanOrEqual(max)
  })

  it("stops at the floor rather than shrinking a long بيت to nothing", () => {
    expect(fitSize(stubCtx(), "ا".repeat(400), "Amiri", 50, 62, 20)).toBe(20)
  })
})

describe("sameLine", () => {
  it("sees through tashkeel, hamza spelling and spacing", () => {
    expect(sameLine("الخيل والليل والبيداء تعرفني", "ألخَيْلُ وَاللّيْلُ وَالبَيْداءُ تَعرِفُني")).toBe(true)
    expect(sameLine("قفا نبك", "قِفا نَبكِ مِن ذِكرى حَبيبٍ")).toBe(true)
  })

  it("keeps a real title that is not the بيت", () => {
    expect(sameLine("على قدر أهل العزم", "الخيل والليل والبيداء تعرفني")).toBe(false)
    expect(sameLine("", "الخيل والليل")).toBe(false)
  })
})

describe("fileStem", () => {
  it("keeps Arabic, drops punctuation, and never runs away", () => {
    const stem = fileStem({ sadr: "ألخَيْلُ وَاللّيْلُ … وَالبَيْداءُ!", poet: "المتنبي" })
    expect(stem.startsWith("qarid-المتنبي-")).toBe(true)
    expect(stem).not.toMatch(/[…!]/)
    expect(stem.length).toBeLessThanOrEqual(54)
  })
})

describe("CARD_MESSAGE", () => {
  it("has one Arabic line for every delivery channel", () => {
    for (const [k, v] of Object.entries(CARD_MESSAGE)) {
      expect(v, k).toMatch(/[؀-ۿ]/)
      expect(v, k).not.toMatch(/[A-Za-z]/)
    }
  })
})
