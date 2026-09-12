/**
 * A media query as a boolean. Used for the one thing the CSS cannot tell the
 * windowed lists: their row height, which has to be a NUMBER in JS for the
 * virtualization maths and a `px` in the stylesheet for the row itself. Both
 * read the same two constants, and `client/styles/views.css` keeps them in sync.
 */
import { useEffect, useState } from "react"

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof matchMedia === "function" ? matchMedia(query).matches : false,
  )
  useEffect(() => {
    if (typeof matchMedia !== "function") return
    const mq = matchMedia(query)
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [query])
  return matches
}

/** The breakpoint the whole product turns on (bayt.css, views.css). */
export const NARROW = "(max-width: 860px)"

export function useNarrow(): boolean {
  return useMediaQuery(NARROW)
}
