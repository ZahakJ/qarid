/**
 * A number that arrives by counting up to itself (v2.md §6, «HUD score
 * count-up»).
 *
 * The decision the whole file rests on: THE VALUE IS NEVER WRONG, only late.
 * `useCountUp` animates the last stretch of a number the reader already knows
 * is coming — a duel score after an answer, a poet's ديوان size as the page
 * settles — and it always ends on the exact value it was given. It refuses the
 * animation outright when motion is reduced, when the jump is a single step,
 * and when the number arrives on FIRST render with the page (there is nothing
 * to count up FROM at that point — see `from` below).
 *
 * `countUpValue` is pure and is what the test drives.
 */
import { useEffect, useRef, useState } from "react"

/** §8's one easing family, as a scalar: decelerating, never overshooting. */
export function easeOut(t: number): number {
  const p = t < 0 ? 0 : t > 1 ? 1 : t
  const inv = 1 - p
  return 1 - inv * inv * inv
}

/**
 * The integer to show at `progress` (0…1) of the way from `from` to `to`.
 * Always exactly `to` at 1, so the last frame is the truth and not a rounding
 * of it; degrades to `to` for any non-finite input.
 */
export function countUpValue(from: number, to: number, progress: number): number {
  if (!Number.isFinite(to)) return 0
  if (!Number.isFinite(from) || !Number.isFinite(progress)) return Math.round(to)
  if (progress >= 1) return Math.round(to)
  if (progress <= 0) return Math.round(from)
  return Math.round(from + (to - from) * easeOut(progress))
}

export type CountUpOptions = {
  /** how long the whole count takes; §8's entrance band */
  duration?: number
  /** false → the value is passed straight through (reduced motion, tests) */
  enabled?: boolean
  /** count up from this on the very first render instead of standing still */
  initial?: number
}

/**
 * The hook. Returns the number to RENDER, which trails `value` for at most
 * `duration` after it changes.
 *
 * On mount it returns `value` (or counts from `initial`, which is what a
 * summary tile wants: 0 → 364). A remount must not replay a count the reader
 * has already watched, which is why the duel HUD passes no `initial`.
 */
export function useCountUp(value: number, opts: CountUpOptions = {}): number {
  const { duration = 420, enabled = true, initial } = opts
  const [shown, setShown] = useState(() => (initial !== undefined && enabled ? initial : value))
  const frame = useRef(0)
  const from = useRef(shown)

  useEffect(() => {
    if (!enabled || duration <= 0 || typeof requestAnimationFrame !== "function") {
      from.current = value
      setShown(value)
      return
    }
    const start = from.current
    if (start === value) return
    const t0 = performance.now()
    const tick = (now: number) => {
      const progress = (now - t0) / duration
      const next = countUpValue(start, value, progress)
      from.current = next
      setShown(next)
      if (progress < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [value, duration, enabled])

  return shown
}
