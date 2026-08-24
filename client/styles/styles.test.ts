/**
 * Guards for the three CSS facts that cannot be asserted from the DOM in a
 * jsdom-less test run, and that each shipped as a real defect once.
 *
 *  1. `.letter-well` is TWO different elements — views.css's 28-cell روي grid
 *     (browse rail, search قيود drawer) and duel.css's 4.25rem required-letter
 *     disc — and duel.css loads after views.css. Un-scoped, the disc's rules
 *     reached every grid cell: 68px gold circles overlapping their neighbours
 *     inside a 15.5rem rail, counts clipped, clicks landing on the wrong
 *     letter. Every duel rule that names `.letter-well` must be scoped under
 *     `.letter-ind`.
 *  2. The spacing scale is the one in v2 §8 (4 8 12 16 24 32 48 64 96) and the
 *     `--sp-*` steps are what the whole app measures itself in.
 *  3. Scrollbars are themed app-wide, and `scrollbar-width` needs a universal
 *     selector because — unlike `scrollbar-color` — it does not inherit.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const STYLES = path.join(import.meta.dirname)
const read = (f: string) => readFileSync(path.join(STYLES, f), "utf8")

/**
 * Selector text of every rule in a stylesheet, comments stripped. A rule opens
 * either at the start of the file or after a brace, and `@media`/`@container`
 * preludes are excluded by the `@` — so the rules INSIDE one are still seen,
 * which is where the ≤860px override that resized all 28 grid cells lived.
 */
function selectors(css: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "")
  return [...bare.matchAll(/(?:^|[{}])\s*([^{}@;]+?)\s*\{/gm)]
    .map((m) => m[1]!.trim())
    .filter(Boolean)
}

describe("the two `.letter-well`s never meet", () => {
  const duel = read("duel.css")

  it("every duel rule naming .letter-well is scoped under .letter-ind", () => {
    const offenders = selectors(duel)
      .filter((s) => s.includes(".letter-well"))
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter((s) => s.includes(".letter-well"))
      .filter((s) => !s.includes(".letter-ind"))
    expect(offenders).toEqual([])
  })

  it("views.css still owns the un-scoped .letter-well grid cell", () => {
    expect(selectors(read("views.css"))).toContain(".letter-well")
  })

  it("the duel disc is a true circle — a fixed inline size and aspect-ratio", () => {
    const block = duel.slice(duel.indexOf(".letter-ind .letter-well {"))
    const decls = block.slice(0, block.indexOf("}"))
    expect(decls).toContain("aspect-ratio: 1")
    expect(decls).toContain("inline-size: var(--well)")
    // a matched block-size is what let a stretching parent distort it
    expect(decls).not.toContain("block-size:")
  })
})

describe("the spacing scale (v2 §8)", () => {
  const tokens = read("tokens.css")

  it("is 4 8 12 16 24 32 48 64 96, in rem", () => {
    const want: Record<string, string> = {
      "--sp-1": "0.25rem",
      "--sp-2": "0.5rem",
      "--sp-3": "0.75rem",
      "--sp-4": "1rem",
      "--sp-5": "1.5rem",
      "--sp-6": "2rem",
      "--sp-7": "3rem",
      "--sp-8": "4rem",
      "--sp-9": "6rem",
    }
    for (const [name, value] of Object.entries(want)) {
      expect(tokens).toMatch(new RegExp(`\\${name}:\\s*${value.replace(".", "\\.")};`))
    }
  })

  it("declares the shared meta band the list rows and chip rows align on", () => {
    expect(tokens).toMatch(/--meta-band:\s*2rem;/)
  })
})

describe("themed scrollbars (v2 §6)", () => {
  const base = read("base.css")

  it("sets scrollbar-width on a universal selector — it does not inherit", () => {
    const universal = base.slice(base.indexOf("*,\n::before,\n::after {"))
    expect(universal.slice(0, universal.indexOf("}"))).toContain("scrollbar-width: thin")
  })

  it("colours the viewport bar from the root, where the UA reads it", () => {
    const html = base.slice(base.indexOf("\nhtml {", base.indexOf("scrollbar-width: thin")))
    expect(html.slice(0, html.indexOf("}"))).toContain("scrollbar-color:")
  })

  it("keeps a webkit fallback for the engines that ignore the standard pair", () => {
    expect(base).toContain("::-webkit-scrollbar-thumb {")
    expect(base).toContain("background-clip: content-box")
  })
})
