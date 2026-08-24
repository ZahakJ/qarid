import { describe, expect, it } from "vitest"
import { stripTashkeel } from "../../shared/arabic.ts"
import { copyableBayt, formatBaits } from "../../shared/format.ts"
import { COPY_MODES, HEMISTICH_SEP, RLM, baytLine, formatBayt, formatBaytWithPoet, formatPoem } from "./copy.ts"
import { displayText, displayTextOrNull } from "./tashkeel.ts"

const SADR = "وَما نَيلُ المَطالِبِ بِالتَمَنّي"
const AJUZ = "وَلَكِن تُؤخَذُ الدُنيا غِلابا"
const FATHA = "\u064E" // فتحة

describe("RLM", () => {
  it("is exactly U+200F", () => {
    expect(RLM).toBe("\u200F")
    expect(RLM).toHaveLength(1)
  })
})

describe("delegation to shared/format.ts", () => {
  it("does not carry a second copy of the RLM + « … » join", () => {
    // The share card and the daily-chain block build the same string from
    // shared/format.ts. If these two ever diverge, a copied بيت and a shared
    // بيت stop matching, which is exactly the drift shared/ exists to prevent.
    expect(formatBayt(SADR, AJUZ)).toBe(copyableBayt(SADR, AJUZ))
    expect(formatBayt(SADR, null)).toBe(copyableBayt(SADR, null))
    // and the counted noun the poem page prints comes from there too
    expect(formatBaits(2)).toBe("بيتان")
  })
})

describe("baytLine", () => {
  it("joins the two hemistichs with « … » on ONE line", () => {
    const line = baytLine(SADR, AJUZ)
    expect(line).toBe(`${SADR}${HEMISTICH_SEP}${AJUZ}`)
    expect(line).not.toContain("\n")
    expect(line).toContain("…")
  })

  it("is just the صدر for a partial بيت (odd hemistich count)", () => {
    expect(baytLine(SADR, null)).toBe(SADR)
    expect(baytLine(SADR)).toBe(SADR)
    expect(baytLine(SADR, "")).toBe(SADR)
  })

  it("trims stray edge whitespace but leaves the text alone", () => {
    expect(baytLine(`  ${SADR} `, ` ${AJUZ}  `)).toBe(`${SADR}${HEMISTICH_SEP}${AJUZ}`)
  })

  it("carries no RLM of its own — it is the embeddable form", () => {
    expect(baytLine(SADR, AJUZ)).not.toContain(RLM)
  })
})

describe("formatBayt", () => {
  it("prefixes the RLM so a paste into an LTR editor keeps its direction", () => {
    const text = formatBayt(SADR, AJUZ)
    expect(text.startsWith(RLM)).toBe(true)
    expect(text).toBe(`${RLM}${SADR}${HEMISTICH_SEP}${AJUZ}`)
  })

  it("copies the DISPLAYED tashkeel state — strip first, prefix after", () => {
    // stripTashkeel also eats U+200B–U+200F, so the RLM must be prefixed LAST
    // or it is stripped away again. This pins that ordering.
    const bare = formatBayt(displayText(SADR, false), displayTextOrNull(AJUZ, false))
    expect(bare.startsWith(RLM)).toBe(true)
    expect(bare.slice(1)).toBe(`${stripTashkeel(SADR)}${HEMISTICH_SEP}${stripTashkeel(AJUZ)}`)
    expect(bare).not.toContain(FATHA)
    expect(formatBayt(SADR, AJUZ)).toContain(FATHA)
  })
})

describe("formatBaytWithPoet", () => {
  it("puts the attribution on its own RLM-prefixed line", () => {
    const lines = formatBaytWithPoet(SADR, AJUZ, "أحمد شوقي").split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(`${RLM}${SADR}${HEMISTICH_SEP}${AJUZ}`)
    expect(lines[1]).toBe(`${RLM}— أحمد شوقي`)
  })

  it("names the قصيدة only when it has a title", () => {
    expect(formatBaytWithPoet(SADR, AJUZ, "أحمد شوقي", "نهج البردة")).toContain("— أحمد شوقي، نهج البردة")
    expect(formatBaytWithPoet(SADR, AJUZ, "أحمد شوقي", null)).not.toContain("،")
  })
})

describe("formatPoem", () => {
  const poem = {
    title: "نهج البردة",
    poet: "أحمد شوقي",
    baits: [
      { sadr: SADR, ajuz: AJUZ },
      { sadr: "سَل قَلبَكَ الحُرَّ", ajuz: null },
    ],
  }

  it("is عنوان, شاعر, blank line, then one line per بيت", () => {
    const lines = formatPoem(poem).split("\n")
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe(`${RLM}نهج البردة`)
    expect(lines[1]).toBe(`${RLM}أحمد شوقي`)
    expect(lines[2]).toBe("")
    expect(lines[3]).toBe(`${RLM}${SADR}${HEMISTICH_SEP}${AJUZ}`)
    // the partial بيت keeps its lonely شطر, with no dangling separator
    expect(lines[4]).toBe(`${RLM}سَل قَلبَكَ الحُرَّ`)
    expect(lines[4]).not.toContain("…")
  })

  it("gives every non-blank line its own RLM", () => {
    for (const line of formatPoem(poem).split("\n")) {
      if (line === "") continue
      expect(line.startsWith(RLM)).toBe(true)
    }
  })
})

describe("COPY_MODES", () => {
  it("is the alt-click menu of design-ux.md §3, in order", () => {
    expect(COPY_MODES.map((m) => m.key)).toEqual(["bayt", "bayt-poet", "poem"])
    expect(COPY_MODES.map((m) => m.label)).toEqual(["البيت", "البيت والشاعر", "القصيدة كاملة"])
  })
})
