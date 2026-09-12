/**
 * Global keyboard. The map itself lives in client/data/shortcuts.ts so the
 * HelpOverlay (`?`) and the handlers can never drift.
 *
 * Three rules everything here obeys:
 *  • never steal a key from a field — an `<input>`, a `<textarea>` or a
 *    contenteditable owns every keystroke it receives, including `/` and `?`;
 *  • `g`-chords expire. `g` then `p` is «الشعراء»; `g`, a pause, then `p` is
 *    two stray letters and must do nothing;
 *  • match the key by its POSITION, not by the character the layout produced.
 *    This is an Arabic product: on an Arabic layout the physical J reports
 *    `e.key === 'ت'`, G reports «ل», P reports «ح» and Shift+/ reports «؟», so
 *    a map written in Latin letters fired NOTHING — no `?` overlay, no `/`
 *    focus, no `g`-chords, none of BaytPlate's j/k/c/f/s/t — while HelpOverlay
 *    advertised keys the reader physically could not produce. `logicalKey`
 *    falls back to `e.code`, which is the physical key on every layout.
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

/** Physical keys the keymap uses that are not letters. */
const CODE_PUNCT: Record<string, [plain: string, shifted: string]> = {
  Slash: ["/", "?"],
  Period: [".", ">"],
  Comma: [",", "<"],
  Semicolon: [";", ":"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
}

/**
 * The key a shortcut map should be matched against.
 *
 * `e.key` when it already is what the map is written in — a named key
 * (`Escape`, `Enter`, `ArrowLeft`) or printable ASCII, which is what a Latin
 * layout produces. Otherwise the PHYSICAL key from `e.code`, so «ت» on an
 * Arabic layout is matched as the `j` it shares a keycap with.
 */
export function logicalKey(e: Pick<KeyboardEvent, "key" | "code" | "shiftKey">): string {
  const k = e.key
  if (k.length > 1) return k
  if (k >= " " && k <= "~") return k
  const code = e.code
  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3).toLowerCase()
    return e.shiftKey ? letter.toUpperCase() : letter
  }
  if (/^Digit[0-9]$/.test(code) && !e.shiftKey) return code.slice(5)
  const punct = CODE_PUNCT[code]
  if (punct) return e.shiftKey ? punct[1] : punct[0]
  return k
}

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

      // the layout produced `e.key`; the map is written against the keycap
      const key = logicalKey(e)

      if (armed) {
        const chord = c?.[key] ?? c?.[e.key]
        disarm()
        if (chord) {
          e.preventDefault()
          chord(e)
          return
        }
      }

      if (c && (key === lead || e.key === lead)) {
        armed = true
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(disarm, CHORD_MS)
        return
      }

      const handler = k?.[key] ?? k?.[e.key]
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
