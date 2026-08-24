/**
 * BaytPlate is THE only بيت renderer, so this is the test that pins the shape
 * of every verse in قريض.
 *
 * It renders through `react-dom/server` and asserts on markup rather than
 * driving a DOM: vitest runs in the `node` environment here (vite.config.ts)
 * and the whole point of BaytPlate is that it is a pure function of its props —
 * no store subscription, no effects needed to paint the first frame. Written
 * with `createElement` rather than JSX so the file can stay a `.ts` inside the
 * existing `*.test.ts` include pattern (vite.config.ts does not glob `.tsx`).
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { rawiyyOf, stripTashkeel } from "../../shared/arabic.ts"
import { BaytPlate, type BaytPlateProps } from "./BaytPlate.tsx"
import { splitRawiyy } from "./rawiyy.ts"

/** أحمد شوقي, fully vocalized — the corpus's own spelling. */
const SADR = "وَما نَيلُ المَطالِبِ بِالتَمَنّي"
const AJUZ = "وَلَكِن تُؤخَذُ الدُنيا غِلابا"

function render(props: Partial<BaytPlateProps> = {}): string {
  return renderToStaticMarkup(createElement(BaytPlate, { sadr: SADR, ajuz: AJUZ, ...props }))
}

/** Innermost text of the first element carrying `class="…cls…"`. */
function textOf(html: string, cls: string): string | null {
  const m = new RegExp(`<span class="${cls}"[^>]*>([\\s\\S]*?)</span>`).exec(html)
  return m ? m[1]!.replace(/<[^>]*>/g, "") : null
}

describe("BaytPlate — the two hemistichs", () => {
  it("renders both شطر, each in its own cell", () => {
    const html = render()
    expect(textOf(html, "sadr")).toBe(SADR)
    expect(textOf(html, "ajuz")).toBe(AJUZ)
  })

  it("keeps DOM order sadr → gutter → ajuz (RTL pushes them to the margins)", () => {
    const html = render()
    const iSadr = html.indexOf('class="sadr"')
    const iGutter = html.indexOf('class="gutter"')
    const iAjuz = html.indexOf('class="ajuz"')
    expect(iSadr).toBeGreaterThan(-1)
    expect(iGutter).toBeGreaterThan(iSadr)
    expect(iAjuz).toBeGreaterThan(iGutter)
  })

  it("gives the lone شطر of a partial بيت the full measure", () => {
    const html = render({ ajuz: null })
    expect(textOf(html, "sadr")).toBe(SADR)
    expect(html).not.toContain('class="ajuz"')
    expect(html).toContain('data-partial="1"')
  })
})

describe("BaytPlate — تشكيل", () => {
  it("renders the marks as they came from the API by default", () => {
    const html = render()
    expect(textOf(html, "sadr")).toBe(SADR)
    expect(html).toContain('data-tashkeel="1"')
  })

  it("strips them through the SHARED stripTashkeel when the reader turns it off", () => {
    const html = render({ tashkeel: false })
    expect(textOf(html, "sadr")).toBe(stripTashkeel(SADR))
    expect(textOf(html, "ajuz")).toBe(stripTashkeel(AJUZ))
    // and the taller leading goes with them
    expect(html).not.toContain('data-tashkeel="1"')
  })

  it("does not claim the taller leading for a بيت that carries no marks", () => {
    const bare = stripTashkeel(SADR)
    const html = render({ sadr: bare, ajuz: stripTashkeel(AJUZ) })
    expect(html).not.toContain('data-tashkeel="1"')
  })
})

describe("BaytPlate — الروي", () => {
  it("leaves the عجز untouched until إظهار الروي is on", () => {
    expect(render()).not.toContain("rawiyy-mark")
  })

  it("underlines the روي the SERVER named, keeping its حركة inside the mark", () => {
    const { rawiyy } = rawiyyOf(AJUZ) // ب — «غِلابا» peels its ألف الإطلاق
    expect(rawiyy).toBe("ب")
    const html = render({ showRawiyy: true, rawiyy })
    const mark = /<span class="rawiyy-mark">([\s\S]*?)<\/span>/.exec(html)
    expect(mark).not.toBeNull()
    expect(stripTashkeel(mark![1]!)).toBe("ب")
    // the peeled ألف stays outside the underline, after the mark
    expect(html.indexOf("rawiyy-mark")).toBeLessThan(html.lastIndexOf("ا"))
  })

  it("renders plain text when the named letter is not in the عجز", () => {
    const html = render({ showRawiyy: true, rawiyy: "ظ" })
    expect(html).not.toContain("rawiyy-mark")
    expect(textOf(html, "ajuz")).toBe(AJUZ)
  })
})

describe("BaytPlate — the margins", () => {
  it("numbers the بيت in Arabic-Indic digits", () => {
    expect(render({ number: 7 })).toContain("٧")
    expect(render({ number: 12 })).toContain("١٢")
  })

  it("honours the Latin numerals setting", () => {
    const html = render({ number: 12, numerals: "latin" })
    expect(html).toContain(">12<")
  })

  it("reserves both margin columns even with nothing in them", () => {
    const html = render()
    expect(html).toContain('class="bayt-num"')
    expect(html).toContain('class="bayt-rail"')
  })
})

describe("BaytPlate — variants", () => {
  it("is a keyboard-reachable row inside a قصيدة", () => {
    const html = render({ anchorId: "bayt-7", number: 7 })
    expect(html).toContain('class="bayt-row"')
    expect(html).toContain('id="bayt-7"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain("data-bayt-row")
  })

  it("is a framed plate when asked, with the duel's provenance hairline", () => {
    const html = render({ variant: "plate", side: "them" })
    expect(html).toContain('class="bayt-plate"')
    expect(html).toContain('data-side="them"')
    expect(html).not.toContain('class="bayt-num"')
  })

  it("carries the size step the reader chose", () => {
    expect(render({ size: "lg" })).toContain('data-size="lg"')
    expect(render({ size: "sm" })).toContain('data-size="sm"')
  })

  it("renders only the rail actions it was given a handler for", () => {
    const plain = render()
    expect(plain).not.toContain("bayt-acts")
    const railed = render({ onFavorite: () => {}, duelHref: "#/duel" })
    expect(railed).toContain("bayt-acts")
    expect(railed).toContain("نسخ البيت")
    expect(railed).toContain('href="#/duel"')
    expect(railed).not.toContain("بطاقة البيت")
  })
})

describe("splitRawiyy", () => {
  it("finds the last character that folds to the روي", () => {
    const s = splitRawiyy("كِتابُهُ", "ب")
    expect(s).not.toBeNull()
    expect(stripTashkeel(s!.letter)).toBe("ب")
    expect(s!.head + s!.letter + s!.tail).toBe("كِتابُهُ")
  })

  it("folds on the way in — ة counts as the letter ه", () => {
    const s = splitRawiyy("رحمة", "ه")
    expect(s?.letter).toBe("ة")
  })

  it("is null for a missing عجز or a missing روي", () => {
    expect(splitRawiyy(null, "ب")).toBeNull()
    expect(splitRawiyy("غلابا", null)).toBeNull()
    expect(splitRawiyy("غلابا", "ظ")).toBeNull()
  })
})
