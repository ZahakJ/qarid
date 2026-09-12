/**
 * Windowed (virtualized) lists, ~70 lines and no dependency (design-ux.md §6).
 *
 * Applied to the poets index, a poet's ديوان and the browse results ONLY. Verse
 * lists are NEVER virtualized — amendments.md §12 puts `content-visibility` on
 * بيت rows instead, so Ctrl+F, text selection and `?bayt=N` anchors keep
 * working on the 11,608-hemistich قصيدة.
 *
 * The scroller is the PAGE, not an inner box: قريض reads as one column and a
 * nested scroll region would break the browser's own find-on-page and the
 * sticky masthead's relationship to the list. So the maths is done against the
 * container's position in the document, and `windowFor` — the whole decision —
 * is a pure function that the test drives directly.
 */
import { useCallback, useEffect, useRef, useState } from "react"

/** What to render, and how much empty space to leave above and below it. */
export type ListWindow = {
  /** first index to render (inclusive) */
  start: number
  /** last index to render (EXCLUSIVE) */
  end: number
  /** px of spacer before `start` */
  padStart: number
  /** px of spacer after `end` */
  padEnd: number
}

export type WindowInput = {
  /** how many rows the list has in total */
  count: number
  /** fixed row height in px, including its own gap */
  rowHeight: number
  /**
   * how far the viewport's top edge is BELOW the top of the list, in px.
   * Negative while the list has not been reached yet.
   */
  scrolled: number
  /** viewport height in px */
  viewport: number
  /** rows of slack rendered beyond each edge */
  overscan?: number
}

export const DEFAULT_OVERSCAN = 6

/**
 * Pure: which slice of a fixed-height list is worth rendering.
 *
 * Contract the tests pin:
 *  • the result always covers the visible band plus `overscan` rows each side;
 *  • `padStart + (end-start)*rowHeight + padEnd === count*rowHeight` exactly,
 *    so the scrollbar never twitches as the window slides;
 *  • a count of 0, a zero viewport (first paint, before layout) and a
 *    nonsensical rowHeight all degrade to something renderable, never to NaN.
 */
export function windowFor({ count, rowHeight, scrolled, viewport, overscan = DEFAULT_OVERSCAN }: WindowInput): ListWindow {
  const n = Math.max(0, Math.floor(count))
  const h = rowHeight > 0 ? rowHeight : 1
  if (n === 0) return { start: 0, end: 0, padStart: 0, padEnd: 0 }

  // Before layout the viewport reads 0; render a screenful rather than nothing,
  // so the first paint has content and the server-rendered smoke shot is real.
  const vh = viewport > 0 ? viewport : 24 * h
  const slack = Math.max(0, Math.floor(overscan))

  const firstVisible = Math.floor(scrolled / h)
  const visibleRows = Math.ceil(vh / h) + 1

  const start = clamp(firstVisible - slack, 0, n)
  const end = clamp(firstVisible + visibleRows + slack, start, n)

  return {
    start,
    end,
    padStart: start * h,
    padEnd: (n - end) * h,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * The hook around `windowFor`: attach `ref` to the list container, render
 * `items.slice(w.start, w.end)` inside a box padded by `w.padStart`/`w.padEnd`.
 *
 * Recomputes on scroll, on resize, and whenever the container moves in the
 * document (a facet strip above it growing a row is the common case) — that
 * last one is what the ResizeObserver is for.
 */
export function useWindowedList(count: number, rowHeight: number, overscan = DEFAULT_OVERSCAN) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [win, setWin] = useState<ListWindow>(() =>
    windowFor({ count, rowHeight, scrolled: 0, viewport: 0, overscan }),
  )

  const measure = useCallback(() => {
    const el = ref.current
    const viewport = typeof window === "undefined" ? 0 : window.innerHeight
    const top = el ? el.getBoundingClientRect().top : 0
    setWin((prev) => {
      const next = windowFor({ count, rowHeight, scrolled: -top, viewport, overscan })
      return same(prev, next) ? prev : next
    })
  }, [count, rowHeight, overscan])

  useEffect(() => {
    measure()
    if (typeof window === "undefined") return
    const onScroll = () => measure()
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver === "function" && ref.current) {
      ro = new ResizeObserver(onScroll)
      ro.observe(ref.current)
      if (document.documentElement) ro.observe(document.documentElement)
    }
    return () => {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
      ro?.disconnect()
    }
  }, [measure])

  return { ref, window: win, measure }
}

function same(a: ListWindow, b: ListWindow): boolean {
  return a.start === b.start && a.end === b.end && a.padStart === b.padStart && a.padEnd === b.padEnd
}
