/**
 * The setup screen's live chain example (v2.md §1) — it must never print a
 * letter the duel would not demand, and it must never offer an example that
 * cannot show the difference between the two modes.
 */
import { describe, expect, it } from "vitest"
import { rawiyyOf } from "../../shared/arabic.ts"
import type { BaitDto } from "../../shared/schema.ts"
import { exampleFrom, FALLBACK_EXAMPLE, lastWordOf } from "./chainExample.ts"

const baitOf = (sadr: string, ajuz: string | null): BaitDto =>
  ({
    id: 1,
    baytKey: "q1:1",
    position: 1,
    sadr,
    ajuz,
    rawiyy: null,
    lastLetter: null,
    firstLetter: null,
    isPartial: ajuz === null,
    poem: { id: "q1", title: null, poemId: 1 },
    poet: { slug: "mutanabi", name: "المتنبي" },
    meter: null,
    era: null,
  }) as unknown as BaitDto

describe("the fallback example", () => {
  it("actually peels — an example where both modes agree teaches nothing", () => {
    expect(FALLBACK_EXAMPLE.peeled).toBe(true)
    expect(FALLBACK_EXAMPLE.rawiyy).not.toBe(FALLBACK_EXAMPLE.lastLetter)
  })

  it("prints the letters `rawiyyOf` derives, never letters of its own", () => {
    const { rawiyy, lastLetter } = rawiyyOf(FALLBACK_EXAMPLE.ajuz)
    expect(FALLBACK_EXAMPLE.rawiyy).toBe(rawiyy)
    expect(FALLBACK_EXAMPLE.lastLetter).toBe(lastLetter)
    // المتنبي's «الزُلالا»: ألف الإطلاق peels off, the روي is ل
    expect(FALLBACK_EXAMPLE.rawiyy).toBe("ل")
    expect(FALLBACK_EXAMPLE.lastLetter).toBe("ا")
  })

  it("points at the last word of the عجز, tashkeel intact", () => {
    expect(FALLBACK_EXAMPLE.word).toBe("الزُلالا")
  })
})

describe("lastWordOf", () => {
  it("collapses the whitespace the corpus arrives with", () => {
    expect(lastWordOf("  يَجِد   مُرّاً بِهِ الماءَ الزُلالا  ")).toBe("الزُلالا")
    expect(lastWordOf("")).toBe("")
  })
})

describe("exampleFrom — a corpus بيت, when it can teach", () => {
  it("takes a بيت whose روي is peeled off its final letter", () => {
    const found = exampleFrom(baitOf("وَمَن يَكُ ذا فَمٍ مُرٍّ مَريضٍ", "يَجِد مُرّاً بِهِ الماءَ الزُلالا"))
    expect(found?.rawiyy).toBe("ل")
    expect(found?.lastLetter).toBe("ا")
    expect(found?.poet).toBe("المتنبي")
  })

  it("refuses a بيت whose two letters are the same", () => {
    // «الحالُ» ends on ل and its روي IS ل — nothing to show.
    expect(exampleFrom(baitOf("لا خَيلَ عِندَكَ", "فَلَيُسعِدِ النُطقُ إِن لَم تُسعِدِ الحالُ"))).toBeNull()
  })

  it("refuses a بيت the source left without an عجز", () => {
    expect(exampleFrom(baitOf("وَمَن يَكُ ذا فَمٍ مُرٍّ مَريضٍ", null))).toBeNull()
    expect(exampleFrom(baitOf("وَمَن يَكُ ذا فَمٍ", "   "))).toBeNull()
    expect(exampleFrom(null)).toBeNull()
  })
})
