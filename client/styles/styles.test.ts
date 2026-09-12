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

/**
 * 5. The بيت's action rail took a FIFTH action (أضِف إلى ديوان), and the quad
 *    that hangs in a قصيدة row's margin has one hard constraint: it must fit
 *    inside the row's own block size, or a rail spills into the neighbouring
 *    بيت and hovering one line moves another. Five cells in TWO columns is
 *    three rows; the fix is three columns in two rows, and a reserved rail
 *    column wide enough to hold them.
 */
describe("the بيت rail's quad holds five actions without growing the row", () => {
  const bayt = read("bayt.css")

  it("is three columns, not two", () => {
    const block = bayt.slice(bayt.indexOf('.bayt-acts[data-layout="quad"] {'))
    expect(block.slice(0, block.indexOf("}"))).toContain("grid-template-columns: repeat(3, 1.5rem)")
  })

  it("reserves a rail column wide enough for three 1.5rem cells and their gaps", () => {
    const m = /--bayt-rail-col:\s*([\d.]+)rem/.exec(bayt)
    expect(m).not.toBeNull()
    // 3 x 1.5rem + 2 x 2px, with the row's own padding around it
    expect(Number(m![1])).toBeGreaterThanOrEqual(4.5)
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

/**
 * 4. chrome.css loads after views.css, poets.css, app.css, duel.css and
 *    room.css — the exact position that made duel.css's `.letter-well` reach
 *    into the browse rail. It may therefore name an existing class only from
 *    inside a scope: `body[data-chrome="native"]`, which is the ONE signal the
 *    phone chrome turns on, or one of its own new classes. That is also what
 *    makes the desktop web pixel-identical: with no attribute on `body`,
 *    nothing in this sheet can match.
 */
describe("chrome.css cannot reach outside the phone", () => {
  const chrome = read("chrome.css")
  /** The classes this sheet introduces; a selector may lead with one of them. */
  const OWN = /^\.(appbar|tabbar|morelist|moregroup|morerow|moreabout)[\w-]*/

  it("every selector is scoped — to the body attribute, or to its own new class", () => {
    const offenders = selectors(chrome)
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !s.startsWith('body[data-chrome="native"]'))
      .filter((s) => !OWN.test(s))
    expect(offenders).toEqual([])
  })

  it("declares the two bar measures on body, never :root — they are DERIVED", () => {
    // `--safe-*` substitutes at the element that declares it (tokens.css's
    // header note), so a :root declaration would freeze the fallback before
    // the WebView's injected inset ever lands.
    expect(chrome).toMatch(/body\[data-chrome="native"\] \{[^}]*--safe-bottom:/)
    expect(selectors(chrome)).not.toContain(":root")
  })

  it("clears the gesture bar with BOTH the injected var and env()", () => {
    // passthrough WebView has the var and not env(); an iOS PWA has env() and
    // not the var; a browser has neither and must get 0.
    expect(chrome).toContain("max(var(--safe-area-inset-bottom, 0px), env(safe-area-inset-bottom, 0px))")
    expect(chrome).toContain("max(var(--safe-area-inset-top, 0px), env(safe-area-inset-top, 0px))")
  })

  it("hides a replaced page title the .sr-only way, never display:none", () => {
    // the app bar's title is deliberately not a heading, so the page's own
    // `<h1>` has to stay in the accessibility tree
    const block = chrome.slice(chrome.indexOf("body[data-chrome=\"native\"] .view__head .view__title"))
    const decls = block.slice(0, block.indexOf("}"))
    expect(decls).toContain("clip-path: inset(50%)")
    expect(decls).not.toContain("display: none")
  })
})

/**
 * 4b. anthology.css loads after views.css, poets.css, app.css, duel.css and
 *     room.css — the same position that let duel.css's `.letter-well` reach
 *     into the browse rail. It is a whole new SECTION (المختارات المنظومة),
 *     so it needs no scope attribute; the rule it is held to instead is that
 *     every selector's LEAD compound carries one of its own `.anth-*` classes.
 *     `.view.anth-index` is fine; a bare `.view` or a `.bcard__meta` is not.
 */
describe("anthology.css names only its own classes", () => {
  const anthology = read("anthology.css")

  it("every selector leads with an .anth- class", () => {
    const offenders = selectors(anthology)
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !/^(from|to|\d+%)$/.test(s))
      // the LEAD compound — everything up to the first descendant/child combinator
      .filter((s) => !/\.anth-/.test(s.split(/[\s>+~]/)[0] ?? ""))
    expect(offenders).toEqual([])
  })

  it("leaves the بيت to bayt.css — it frames أبيات, it does not set them", () => {
    // `BaytPlate` is the only بيت renderer (CLAUDE.md); a shelf that restyled
    // `.bayt`, `.sadr` or `.ajuz` would be a second one.
    for (const owned of [".bayt", ".sadr", ".ajuz", ".gutter", ".bayt-plate"]) {
      expect(selectors(anthology).some((s) => s.includes(owned))).toBe(false)
    }
  })
})

/**
 * 4b². The same rule again for the two surfaces built for a reader who is
 *      WRITING: qafiya.css (باحث القافية) and buhur.css (صفحة البحور). Both
 *      load after views.css and both DECORATE components earlier sheets own —
 *      the 28-cell `.letter-well` grid, `.chip`, `.chip-cloud`, `BaytPlate` —
 *      which is precisely the shape of the defect that shipped once. So every
 *      selector's LEAD compound must carry one of their own new classes, and
 *      neither may typeset a بيت.
 */
describe("qafiya.css and buhur.css name only their own classes", () => {
  const sheets = [
    ["qafiya.css", /\.qaf-/],
    ["buhur.css", /\.buhur-/],
  ] as const

  for (const [file, own] of sheets) {
    it(`${file}: every selector leads with one of its own classes`, () => {
      const offenders = selectors(read(file))
        .flatMap((s) => s.split(","))
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !/^(from|to|\d+%)$/.test(s))
        // the LEAD compound — everything up to the first descendant/child combinator
        .filter((s) => !own.test(s.split(/[\s>+~]/)[0] ?? ""))
      expect(offenders).toEqual([])
    })

    it(`${file}: leaves the بيت to bayt.css`, () => {
      // These two pages put أبيات on the screen through `BaytPlate` like every
      // other surface. Reaching a `.bayt`/`.sadr`/`.ajuz` from here would make
      // one of them a second بيت renderer.
      for (const owned of [".bayt ", ".bayt{", ".sadr", ".ajuz", ".gutter", ".bayt-plate"]) {
        expect(
          selectors(read(file)).some((s) => s.includes(owned)),
          `${file} names ${owned}`,
        ).toBe(false)
      }
    })
  }

  it("qafiya.css reaches the shared letter grid only from inside its own well", () => {
    // `.letter-well` is the two-element trap of §1: views.css's 28-cell روي
    // grid and duel.css's required-letter disc share the class. This page uses
    // the FORMER at full width, so it may widen the shell — but only where it
    // has put one, never everywhere.
    const touching = selectors(read("qafiya.css"))
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter((s) => /\.letter-(well|grid)/.test(s))
    expect(touching.length).toBeGreaterThan(0)
    for (const s of touching) expect(s.startsWith(".qaf-")).toBe(true)
  })
})

/**
 * 4b³. diwan.css is الدواوين, and it is the same rule a third time. It loads
 *      after views.css / poets.css / app.css / duel.css / room.css and it
 *      DECORATES what earlier sheets own — `.view`, `.view__head`, `.btn`, the
 *      `.field`, and `BaytPlate` rows in the shelf — which is exactly the shape
 *      of the `.letter-well` defect. So every selector's LEAD compound carries
 *      one of its own classes (`.diwan-*`, `.diwans-*`, `.dw*`), and none of
 *      them typesets a بيت: a shelf FRAMES أبيات, `BaytPlate` sets them.
 */
describe("diwan.css names only its own classes", () => {
  const diwan = read("diwan.css")
  const OWN = /\.(diwans?-|dw)[\w-]*/

  it("every selector leads with one of its own classes", () => {
    const offenders = selectors(diwan)
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !/^(from|to|\d+%)$/.test(s))
      .filter((s) => !OWN.test(s.split(/[\s>+~]/)[0] ?? ""))
    expect(offenders).toEqual([])
  })

  it("leaves the بيت to bayt.css — a ديوان frames أبيات, it does not set them", () => {
    for (const owned of [".bayt ", ".bayt{", ".sadr", ".ajuz", ".gutter", ".bayt-plate", ".bayt-rail"]) {
      expect(selectors(diwan).some((s) => s.includes(owned)), `diwan.css names ${owned}`).toBe(false)
    }
  })
})

/**
 * 4c. reader.css is وضع القراءة, and it loads after bayt.css — which it
 *     deliberately reaches into: a بيت being READ gives its action rail's
 *     column back to the verse. That is exactly the position that let duel.css
 *     redraw the browse rail's 28 روي cells, so the rule is the same one:
 *     every selector's LEAD compound is one of this sheet's own `.reader*`
 *     classes, or the `body[data-immersive="read"]` App.tsx writes. A bare
 *     `.bayt-rail` here would take the four actions off every بيت in the app.
 */
describe("reader.css reaches only inside a reading", () => {
  const reader = read("reader.css")
  const OWN = /^\.reader[\w-]*/

  it("every selector leads with one of its own classes, or with the body", () => {
    const offenders = selectors(reader)
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !/^(from|to|\d+%)$/.test(s))
      .filter((s) => !s.startsWith('body[data-immersive="read"]'))
      .filter((s) => !OWN.test(s))
    expect(offenders).toEqual([])
  })

  it("names the immersive VALUE, never the bare attribute", () => {
    // `body[data-immersive]` alone would put the reading's rules on the duel's
    // docked game screen, and phone.css's on a reading.
    expect(reader).not.toMatch(/\[data-immersive\]/)
    expect(read("phone.css")).not.toMatch(/\[data-immersive\]/)
  })

  it("clears the notch and the gesture bar, and falls back where there is none", () => {
    // `--safe-top` / `--safe-bottom` are declared on `body` by chrome.css under
    // the phone chrome ONLY, so the web must not depend on them existing.
    expect(reader).toContain("var(--safe-top, 0px)")
    expect(reader).toContain("var(--safe-bottom, 0px)")
  })

  it("stops the flick at the reading — there is nothing behind it to scroll", () => {
    const scroll = reader.slice(reader.indexOf(".reader__scroll {"))
    expect(scroll.slice(0, scroll.indexOf("}"))).toContain("overscroll-behavior: contain")
  })
})

/**
 * 5. sheet.css loads after chrome.css — later still than the position that made
 *    duel.css's `.letter-well` reach into the browse rail. It hosts surfaces
 *    other sheets own (`.facet-rail`, `.auth__form`, `.sharecard__stage`), so
 *    the rule it holds itself to is that every one of those is reached only
 *    from INSIDE one of its own classes: the selector's LEAD compound is a
 *    `.sheet*` class or the body attribute. `.sheet__body .facet-rail` restyles
 *    the rail where it has been put in a sheet and nowhere else; a bare
 *    `.facet-rail` would restyle the browse column on the desktop.
 */
describe("sheet.css reaches only inside a sheet", () => {
  const sheet = read("sheet.css")
  /** The classes this sheet introduces. */
  const OWN = /^\.sheet[\w-]*/

  it("every selector leads with one of its own classes, or with the body", () => {
    const offenders = selectors(sheet)
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      // keyframe steps (`from`, `to`, `50%`) are not selectors
      .filter((s) => !/^(from|to|\d+%)$/.test(s))
      .filter((s) => !s.startsWith("body["))
      .filter((s) => !OWN.test(s))
    expect(offenders).toEqual([])
  })

  it("clears the gesture bar with BOTH the injected var and env()", () => {
    expect(sheet).toContain("max(var(--safe-area-inset-bottom, 0px), env(safe-area-inset-bottom, 0px))")
  })

  it("stops scroll chaining at the scrim AND at the sheet's own body", () => {
    // a fixed cover is not a scroll container, so `contain` needs `hidden` to
    // have something to hold — see the comment on `.sheet-scrim`
    const scrim = sheet.slice(sheet.indexOf(".sheet-scrim {"))
    const decls = scrim.slice(0, scrim.indexOf("}"))
    expect(decls).toContain("overflow: hidden")
    expect(decls).toContain("overscroll-behavior: contain")
    const body = sheet.slice(sheet.indexOf(".sheet__body {"))
    expect(body.slice(0, body.indexOf("}"))).toContain("overscroll-behavior: contain")
  })
})

/**
 * 6. phone.css is the LAST sheet before motion.css, and it restyles screens
 *    other sheets own outright — the duel desk, the room's seats, the exchange
 *    log. It is therefore held to chrome.css's rule exactly: scoped under the
 *    body attributes App.tsx writes, or leading with one of its own new classes.
 */
describe("phone.css cannot reach outside the phone", () => {
  const phone = read("phone.css")
  const OWN = /^\.(fsearch)[\w-]*/

  it("every selector is scoped — to the body attributes, or to its own class", () => {
    const offenders = selectors(phone)
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !/^(from|to|\d+%)$/.test(s))
      .filter((s) => !s.startsWith('body[data-chrome="native"]'))
      .filter((s) => !OWN.test(s))
    expect(offenders).toEqual([])
  })

  it("measures the game screen against the VISUAL viewport, with a dvh fallback", () => {
    // `100dvh` does not shrink under an iOS keyboard; `--app-height` is
    // `visualViewport.height` (client/hooks/useAppHeight.ts).
    expect(phone).toContain("var(--app-height, 100dvh)")
  })

  it("clears the gesture bar AND the keyboard under the docked answer field", () => {
    const dock = phone.slice(phone.indexOf('body[data-chrome="native"][data-immersive="game"] .duel-desk {'))
    const decls = dock.slice(0, dock.indexOf("}"))
    expect(decls).toContain("var(--safe-bottom)")
    expect(decls).toContain("var(--kb-inset, 0px)")
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
