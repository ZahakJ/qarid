/**
 * The opponent RECITES; it does not paste (design-ux.md §4 Play):
 *
 *   "Progressive reveal: sadr words staggered 55ms (opacity+blur 3px→0,
 *    180ms), 400ms caesura, ajuz same; **timer starts only after reveal
 *    completes**; any key/tap skips; instant under reduced-motion."
 *
 * IMPLEMENTATION NOTE — the reveal is a stepped MASK, not per-word spans.
 * `BaytPlate` is the only بيت renderer in قريض (CLAUDE.md invariant), and
 * wrapping every word in its own element here would be a second renderer with
 * its own line-breaking. So the plate renders the whole بيت exactly as it will
 * finally read, and this component animates a `mask-image` across each hemistich
 * in `steps(<word count>)` — the words therefore appear one at a time, in
 * reading order, without the text ever reflowing under the player's eye. The
 * blur is applied to the hemistich as a whole and clears over the same span.
 *
 * The reveal is PURELY decorative: `data-reveal` is dropped from the DOM the
 * moment it is done, so a browser that ignores CSS masks, a reduced-motion
 * reader and a failed animation all end at the same place — the full بيت, and
 * `onDone` fired exactly once. Nothing in the game waits on an animation event.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { BaytPlate, type BaytSize } from "../bayt/BaytPlate.tsx"

/** design-ux.md §4: 55ms per word, 180ms per fade, 400ms caesura. */
export const REVEAL = { perWord: 55, fade: 180, caesura: 400 } as const

export type RevealTiming = {
  sadrWords: number
  ajuzWords: number
  sadrMs: number
  ajuzMs: number
  caesuraMs: number
  totalMs: number
}

export function wordCount(s: string | null | undefined): number {
  if (!s) return 0
  const words = s.trim().split(/\s+/u).filter(Boolean)
  return words.length
}

/** How long the recitation of this بيت takes, itemised (pure, tested). */
export function revealTiming(sadr: string, ajuz: string | null | undefined): RevealTiming {
  const sadrWords = Math.max(1, wordCount(sadr))
  const ajuzWords = wordCount(ajuz)
  const sadrMs = sadrWords * REVEAL.perWord + REVEAL.fade
  const ajuzMs = ajuzWords > 0 ? ajuzWords * REVEAL.perWord + REVEAL.fade : 0
  const caesuraMs = ajuzWords > 0 ? REVEAL.caesura : 0
  return { sadrWords, ajuzWords, sadrMs, ajuzMs, caesuraMs, totalMs: sadrMs + caesuraMs + ajuzMs }
}

export type RecitationRevealProps = {
  sadr: string
  ajuz: string | null
  size?: BaytSize
  side?: "you" | "them"
  meta?: ReactNode
  rawiyy?: string | null
  showRawiyy?: boolean
  tashkeel?: boolean
  /** false → render finished, fire nothing (a transcript line, not a recital) */
  animate?: boolean
  /** system/user reduced-motion: the whole بيت lands at once */
  reduced?: boolean
  /** fired exactly once, when the بيت is fully on screen — the timer starts here */
  onDone?: () => void
  className?: string
}

export function RecitationReveal({
  sadr,
  ajuz,
  size = "md",
  side,
  meta,
  rawiyy = null,
  showRawiyy = false,
  tashkeel = true,
  animate = true,
  reduced = false,
  onDone,
  className,
}: RecitationRevealProps) {
  const timing = useMemo(() => revealTiming(sadr, ajuz), [sadr, ajuz])
  const instant = !animate || reduced
  const [phase, setPhase] = useState<"sadr" | "ajuz" | "done">(instant ? "done" : "sadr")
  const fired = useRef(false)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  // one recitation per بيت; a new صدر restarts the whole thing
  useEffect(() => {
    fired.current = false
    if (instant) {
      setPhase("done")
      fired.current = true
      doneRef.current?.()
      return
    }
    setPhase("sadr")
    const finish = () => {
      if (fired.current) return
      fired.current = true
      setPhase("done")
      doneRef.current?.()
    }
    const timers = [
      setTimeout(() => setPhase("ajuz"), timing.sadrMs + timing.caesuraMs),
      setTimeout(finish, timing.totalMs),
    ]
    // «any key/tap skips» — the whole window, not just a focused element
    const skip = () => finish()
    window.addEventListener("keydown", skip)
    window.addEventListener("pointerdown", skip)
    return () => {
      for (const t of timers) clearTimeout(t)
      window.removeEventListener("keydown", skip)
      window.removeEventListener("pointerdown", skip)
    }
  }, [sadr, ajuz, instant, timing.sadrMs, timing.caesuraMs, timing.totalMs])

  const style =
    phase === "done"
      ? undefined
      : ({
          "--recite-sadr-steps": String(timing.sadrWords),
          "--recite-sadr-ms": `${timing.sadrMs}ms`,
          "--recite-ajuz-steps": String(Math.max(1, timing.ajuzWords)),
          "--recite-ajuz-ms": `${timing.ajuzMs}ms`,
        } as React.CSSProperties)

  return (
    <div
      className={className ? `recite ${className}` : "recite"}
      data-reveal={phase === "done" ? undefined : phase}
      style={style}
    >
      <BaytPlate
        variant="plate"
        sadr={sadr}
        ajuz={ajuz}
        size={size}
        side={side}
        rawiyy={rawiyy}
        showRawiyy={showRawiyy}
        tashkeel={tashkeel}
        meta={meta}
      />
    </div>
  )
}
