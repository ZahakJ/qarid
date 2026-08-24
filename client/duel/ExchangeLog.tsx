/**
 * The recitation transcript (design-ux.md §4 Play): newest at the BOTTOM, the
 * way a مساجلة is written down, every بيت a `BaytPlate`.
 *
 *  • the opponent's أبيات carry the lapis inline-start hairline (`side="them"`,
 *    one of lapis's three sanctioned uses), yours the gold one;
 *  • the opponent is «الخصم» while its بيت is still standing — the شاعر is
 *    named only once you have answered it, so the attribution is a reward and
 *    not a hint;
 *  • `+140` rides the plate of the بيت that earned it.
 *
 * `pulseExchange(baytKey)` is how the `already_used` rejection card sends the
 * reader back to the بيت they already said: it scrolls that plate into view and
 * pulses it twice. It reaches into the DOM on purpose — the alternative is
 * threading a "which exchange is flashing" flag through the reducer, which
 * would make a purely decorative flash part of the game's persisted state.
 */
import { useEffect, useRef } from "react"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { Chip } from "../components/Chip.tsx"
import { formatScore } from "../../shared/format.ts"
import { routeHash } from "../router.ts"
import type { Exchange } from "../../shared/schema.ts"
import { RecitationReveal } from "./RecitationReveal.tsx"

export const OPPONENT_NAME = "الخصم"

/** Scroll to a بيت already said in this مساجلة and pulse it twice. */
export function pulseExchange(baytKey: string): void {
  if (typeof document === "undefined") return
  const el = document.querySelector<HTMLElement>(`[data-exchange-key="${CSS.escape(baytKey)}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  el.dataset.pulse = "1"
  window.setTimeout(() => {
    delete el.dataset.pulse
  }, 1900)
}

/**
 * True when the شاعر behind an opponent's بيت may be named: the player has
 * already answered it (a later بيت of theirs exists), or the duel is over.
 */
export function poetRevealed(exchanges: readonly Exchange[], index: number, ended: boolean): boolean {
  if (ended) return true
  const ex = exchanges[index]
  if (!ex || ex.side === "player") return true
  for (let i = index + 1; i < exchanges.length; i++) if (exchanges[i]!.side === "player") return true
  return false
}

function Meta({ ex, revealed }: { ex: Exchange; revealed: boolean }) {
  const poet = ex.poet
  return (
    <>
      {ex.side === "opponent" && !revealed ? (
        <span className="exchange__who exchange__who--hidden">{OPPONENT_NAME}</span>
      ) : poet ? (
        <a className="exchange__who" href={routeHash({ view: "poet", slug: poet.slug })}>
          <bdi>{poet.name}</bdi>
        </a>
      ) : (
        <span className="exchange__who">{ex.side === "player" ? "أنت" : OPPONENT_NAME}</span>
      )}
      {revealed && ex.meter ? <Chip variant="bahr" slug={ex.meter.slug} label={ex.meter.name} /> : null}
      {revealed && ex.poemId ? (
        <a className="exchange__link" href={routeHash({ view: "poem", id: ex.poemId })}>
          القصيدة
        </a>
      ) : null}
      {ex.side === "player" && ex.award ? (
        <span className="exchange__award" aria-label={`${ex.award} نقطة`}>
          ‎+{formatScore(ex.award)}
        </span>
      ) : null}
    </>
  )
}

export type ExchangeLogProps = {
  exchanges: readonly Exchange[]
  /** index of the بيت being recited right now, or null when nothing is */
  revealIndex?: number | null
  onRevealDone?: () => void
  reduced?: boolean
  ended?: boolean
  tashkeel?: boolean
  showRawiyy?: boolean
  numerals?: "arabic" | "latin"
  /** the summary shows every شاعر and never animates */
  variant?: "play" | "summary"
}

export function ExchangeLog({
  exchanges,
  revealIndex = null,
  onRevealDone,
  reduced = false,
  ended = false,
  tashkeel = true,
  showRawiyy = false,
  numerals = "arabic",
  variant = "play",
}: ExchangeLogProps) {
  const endRef = useRef<HTMLLIElement | null>(null)

  // newest at the bottom → follow it, unless the reader is scrolled away
  useEffect(() => {
    if (variant !== "play") return
    endRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "end" })
  }, [exchanges.length, revealIndex, reduced, variant])

  return (
    <ol className="exchange-log" data-variant={variant}>
      {exchanges.map((ex, i) => {
        const revealed = variant === "summary" || poetRevealed(exchanges, i, ended)
        const side = ex.side === "player" ? "you" : "them"
        const meta = <Meta ex={ex} revealed={revealed} />
        return (
          <li className="exchange" key={`${ex.baytKey}:${i}`} data-side={ex.side} data-exchange-key={ex.baytKey}>
            {i === revealIndex ? (
              <RecitationReveal
                sadr={ex.sadr}
                ajuz={ex.ajuz}
                side={side}
                meta={meta}
                reduced={reduced}
                tashkeel={tashkeel}
                showRawiyy={showRawiyy}
                numerals={numerals}
                onDone={onRevealDone}
              />
            ) : (
              <BaytPlate
                variant="plate"
                sadr={ex.sadr}
                ajuz={ex.ajuz}
                side={side}
                meta={meta}
                tashkeel={tashkeel}
                showRawiyy={showRawiyy}
                numerals={numerals}
              />
            )}
          </li>
        )
      })}
      <li ref={endRef} className="exchange-log__end" aria-hidden="true" />
    </ol>
  )
}
