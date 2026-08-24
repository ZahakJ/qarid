/**
 * `windowFor` is the whole of the virtualization decision (design-ux.md §6),
 * so it is pinned here without a DOM.
 *
 * The invariant everything else rests on is the SPACER IDENTITY:
 *   padStart + (end - start) * rowHeight + padEnd === count * rowHeight
 * If that ever stops holding, the document's scroll height changes as the
 * window slides and the scrollbar jitters under the reader's thumb — which is
 * the one thing a hand-rolled windowed list is likely to get wrong.
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_OVERSCAN, windowFor, type WindowInput } from "./useWindowedList.ts"

const H = 84
const VH = 900

function w(over: Partial<WindowInput> = {}) {
  return windowFor({ count: 500, rowHeight: H, scrolled: 0, viewport: VH, ...over })
}

/** The identity that keeps the scrollbar still. */
function totalHeight(win: ReturnType<typeof windowFor>): number {
  return win.padStart + (win.end - win.start) * H + win.padEnd
}

describe("windowFor", () => {
  it("keeps the total height exact at every scroll offset", () => {
    for (const scrolled of [-2000, -1, 0, 1, 83, 84, 500, 4200, 41_916, 100_000]) {
      const win = w({ scrolled })
      expect(totalHeight(win), `scrolled=${scrolled}`).toBe(500 * H)
    }
  })

  it("renders the top of the list while it is still just below the fold", () => {
    // the list begins 400px under the viewport's top edge — the normal case,
    // with a masthead and a facet strip above it
    const win = w({ scrolled: -400 })
    expect(win.start).toBe(0)
    expect(win.padStart).toBe(0)
    expect(win.end).toBeGreaterThan(Math.ceil((VH - 400) / H))
  })

  it("renders nothing, but reserves everything, for a list entirely off screen", () => {
    const below = w({ scrolled: -30_000 })
    expect(below.start).toBe(0)
    expect(below.end).toBe(0)
    expect(below.padEnd).toBe(500 * H)

    const above = w({ scrolled: 500 * H + 30_000 })
    expect(above.start).toBe(500)
    expect(above.end).toBe(500)
    expect(above.padStart).toBe(500 * H)
    expect(totalHeight(above)).toBe(500 * H)
  })

  it("covers the visible band plus overscan on both sides", () => {
    const scrolled = 40 * H // row 40 is at the top edge
    const win = w({ scrolled })
    expect(win.start).toBe(40 - DEFAULT_OVERSCAN)
    // ceil(900/84) + 1 = 12 rows visible, plus overscan below
    expect(win.end).toBe(40 + Math.ceil(VH / H) + 1 + DEFAULT_OVERSCAN)
    // every row the viewport can actually see is inside the window
    const lastVisible = Math.floor((scrolled + VH) / H)
    expect(win.start).toBeLessThanOrEqual(40)
    expect(win.end).toBeGreaterThan(lastVisible)
  })

  it("clamps at the end of the list instead of running past it", () => {
    const win = w({ scrolled: 499 * H })
    expect(win.end).toBe(500)
    expect(win.padEnd).toBe(0)
    expect(win.start).toBeLessThan(500)
  })

  it("is empty for an empty list", () => {
    expect(w({ count: 0 })).toEqual({ start: 0, end: 0, padStart: 0, padEnd: 0 })
  })

  it("renders a screenful before layout, when the viewport still measures 0", () => {
    const win = w({ viewport: 0 })
    expect(win.start).toBe(0)
    // 24 rows of fallback viewport + 1 + overscan, capped by the list
    expect(win.end).toBeGreaterThanOrEqual(24)
    expect(totalHeight(win)).toBe(500 * H)
  })

  it("degrades rather than producing NaN on nonsense input", () => {
    for (const bad of [
      { rowHeight: 0 },
      { rowHeight: -12 },
      { scrolled: Number.NaN },
      { viewport: Number.NaN },
      { count: -5 },
      { count: 3.7 },
      { overscan: -4 },
    ] satisfies Partial<WindowInput>[]) {
      const win = w(bad)
      for (const v of [win.start, win.end, win.padStart, win.padEnd]) {
        expect(Number.isFinite(v), JSON.stringify(bad)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
      }
      expect(win.end).toBeGreaterThanOrEqual(win.start)
    }
  })

  it("never returns a window the list cannot fill", () => {
    const win = w({ count: 3, scrolled: 10_000 })
    expect(win.end).toBeLessThanOrEqual(3)
    expect(win.start).toBeLessThanOrEqual(win.end)
  })

  it("moves the window monotonically as the reader scrolls down", () => {
    let prev = -1
    for (let scrolled = 0; scrolled < 400 * H; scrolled += H * 7) {
      const win = w({ scrolled })
      expect(win.start).toBeGreaterThanOrEqual(prev)
      prev = win.start
    }
  })

  it("uses the two real row heights of the product without drift", () => {
    // ROW_POEM 84 / ROW_POEM_NARROW 100 (client/views/shared.tsx)
    for (const rowHeight of [84, 100, 132, 148]) {
      const win = windowFor({ count: 137, rowHeight, scrolled: 33 * rowHeight, viewport: 812 })
      expect(win.padStart + (win.end - win.start) * rowHeight + win.padEnd).toBe(137 * rowHeight)
    }
  })
})
