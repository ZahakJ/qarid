/**
 * Global keyboard. The map itself lives in client/data/shortcuts.ts so the
 * HelpOverlay (`?`) and the handlers can never drift.
 *
 * Two rules everything here obeys:
 *  • never steal a key from a field — an `<input>`, a `<textarea>` or a
 *    contenteditable owns every keystroke it receives, including `/` and `?`;
 *  • `g`-chords expire. `g` then `p` is «الشعراء»; `g`, a pause, then `p` is
 *    two stray letters and must do nothing.
 */
import { useEffect, useRef } from "react"

/** True when the event came from somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable
}

/** How long a `g` stays armed. */
export const CHORD_MS = 900

export type KeyHandlers = {
  /** plain key → handler; the key is matched case-sensitively (`?`, `/`, `j`) */
  keys?: Record<string, (e: KeyboardEvent) => void>
  /** second key of a `g` chord → handler */
  chords?: Record<string, (e: KeyboardEvent) => void>
  /** the chord leader; `g` everywhere in قريض */
  leader?: string
  enabled?: boolean
}

export function useKeyboard({ keys, chords, leader = "g", enabled = true }: KeyHandlers): void {
  const latest = useRef({ keys, chords, leader })
  latest.current = { keys, chords, leader }

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return
    let armed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const disarm = () => {
      armed = false
      if (timer !== null) clearTimeout(timer)
      timer = null
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (isTypingTarget(e.target)) return
      const { keys: k, chords: c, leader: lead } = latest.current

      if (armed) {
        const chord = c?.[e.key]
        disarm()
        if (chord) {
          e.preventDefault()
          chord(e)
          return
        }
      }

      if (c && e.key === lead) {
        armed = true
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(disarm, CHORD_MS)
        return
      }

      const handler = k?.[e.key]
      if (handler) {
        e.preventDefault()
        handler(e)
      }
    }

    window.addEventListener("keydown", onKey)
    return () => {
      disarm()
      window.removeEventListener("keydown", onKey)
    }
  }, [enabled])
}
