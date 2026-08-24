/**
 * «المزيد» autoload: fire `onEnter` when a sentinel comes within `rootMargin`
 * of the viewport. Used by browse, the poets index and a poet's ديوان; the
 * poem page has its own copy from Phase 1 and is left alone.
 *
 * The button stays in the DOM next to the sentinel — an IntersectionObserver
 * that a browser extension has disabled must not be the only way to page.
 */
import { useEffect, type RefObject } from "react"

export function useIntersection(
  ref: RefObject<Element | null>,
  onEnter: () => void,
  { enabled = true, rootMargin = "800px 0px" }: { enabled?: boolean; rootMargin?: string } = {},
): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled || typeof IntersectionObserver !== "function") return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onEnter()
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, enabled, rootMargin, onEnter])
}
