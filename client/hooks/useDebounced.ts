/**
 * Debounce, the two shapes a view actually wants.
 *
 * The omnibox types a letter every ~90 ms; the browse facet rail fires a
 * /api/facets round trip on every chip. Both want the same 200 ms of quiet
 * before they cost anything (design-ux.md §3), and the game agent's note is
 * blunt about the other direction: a client that polls on every keystroke will
 * hit the /api/game/* rate limit.
 */
import { useEffect, useRef, useState } from "react"

/** The value, `ms` after it last changed. Changes faster than that are lost. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (ms <= 0) {
      setSettled(value)
      return
    }
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

/**
 * A stable callback that runs `ms` after its LAST invocation. The returned
 * function also carries `.cancel()` and `.flush()` for the cases where a view
 * must not let a pending call land (unmount, submit).
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  ms = 200,
): ((...args: A) => void) & { cancel: () => void; flush: () => void } {
  const latest = useRef(fn)
  latest.current = fn
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<A | null>(null)

  const ref = useRef<((...args: A) => void) & { cancel: () => void; flush: () => void }>(undefined as never)
  if (!ref.current) {
    const cancel = () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      pending.current = null
    }
    const flush = () => {
      const args = pending.current
      cancel()
      if (args) latest.current(...args)
    }
    const call = (...args: A) => {
      pending.current = args
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        pending.current = null
        latest.current(...args)
      }, ms)
    }
    ref.current = Object.assign(call, { cancel, flush })
  }

  useEffect(() => () => ref.current.cancel(), [])
  return ref.current
}
