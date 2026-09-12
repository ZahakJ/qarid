/**
 * The «المطلوب → عندك» cluster's GEOMETRY — the half of it that lives in the
 * component rather than in duel.css.
 *
 * Written with `createElement` rather than JSX so the file stays a `.ts` and
 * matches vite.config.ts's `*.test.ts` include glob (same bargain as
 * ./duel.test.ts).
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LetterIndicator } from "./LetterIndicator.tsx"

import type { LetterIndicatorProps } from "./LetterIndicator.tsx"

const base: LetterIndicatorProps = {
  required: "م",
  source: "peeled",
  alsoAccepted: ["ه"],
  mode: "rhyme",
  draft: "",
  msLeft: 20_000,
  turnMs: 40_000,
}

const render = (over: Partial<LetterIndicatorProps> = {}) =>
  renderToStaticMarkup(createElement(LetterIndicator, { ...base, ...over }))

describe("the flow arrow", () => {
  const html = render()

  it("is drawn, not typed", () => {
    // «←» and «→» are Bidi_Mirrored: inside an RTL run some shapers flip them
    // and some do not, so the one glyph whose job is to point had no reliable
    // direction. SVG geometry is never reordered by the bidi algorithm.
    expect(html).toContain('class="letter-ind__arrow"')
    expect(html).toContain("<svg")
    expect(html).not.toContain("←")
    expect(html).not.toContain("→")
  })

  it("is hidden from the accessibility tree — it repeats the two labels", () => {
    expect(html).toMatch(/<svg[^>]*class="letter-ind__arrow"[^>]*aria-hidden="true"/)
  })
})

describe("the timer arc", () => {
  it("is a square viewBox, so the ring is concentric at every disc size", () => {
    const html = render()
    expect(html).toMatch(/<svg class="letter-arc" viewBox="0 0 100 100"/)
    // r 47 with a 3-unit stroke keeps the ring inside the box at every scale
    expect(html).toContain('r="47"')
  })

  it("draws the remaining fraction of the turn, not the spent one", () => {
    const full = render({ msLeft: 40_000, turnMs: 40_000 })
    const half = render({ msLeft: 20_000, turnMs: 40_000 })
    const circ = 2 * Math.PI * 47
    // full turn → nothing dashed away; half → half the circumference offset
    expect(full).toContain(`stroke-dashoffset:0`)
    expect(half).toContain(`stroke-dashoffset:${circ * 0.5}`)
  })

  it("is absent when the turn has no clock", () => {
    expect(render({ msLeft: null })).not.toContain("letter-arc")
  })
})

describe("the cluster's two sides", () => {
  it("gives both discs a footnote slot so they sit on one row", () => {
    // the required side grows ghost chips and the typed side a verdict; both
    // are declared rows of the same grid, so neither can drift the discs apart
    const html = render({ draft: "مَن ذا" })
    expect(html).toContain("letter-ind__ghosts")
    expect(html).toContain("letter-ind__verdict")
    expect(html).toContain('class="letter-ind__side"')
  })

  it("keeps the glyph class the exchange log's snapshot test depends on", () => {
    expect(render()).toContain("letter-well__glyph")
  })
})
