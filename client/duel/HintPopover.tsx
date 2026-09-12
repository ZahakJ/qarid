/**
 * هَمْس — the hint popover (design-ux.md §4 Play + amendments.md §8).
 *
 * Prices are visible before you buy, and they are the tier's real prices:
 * مبتدئ pays half, فحل double, سيف gets no hints at all. Every hint describes
 * a بيت that WOULD answer — not the بيت on screen — and with one stable seed
 * per exchange the three cheap hints all describe the SAME بيت, which is what
 * makes buying the second one worth anything.
 *
 * «بدّل الحرف» (−150, streak reset) is the mercy option: the server hands back
 * a brand-new famous بيت on a different letter so a duel never dead-ends on ظ.
 */
import { useEffect, useRef } from "react"
import { HINT_COSTS, type HintKind } from "../../shared/schema.ts"
import { formatScore } from "../../shared/format.ts"
import { hintPricing, pricedHint } from "./scoring.ts"
import type { DuelTier } from "../../shared/schema.ts"
import type { HintReveals } from "./machine.ts"

const LABEL: Record<HintKind, string> = {
  poet: "من قائله؟",
  first_word: "أول كلمة",
  meter: "البحر",
  switch_letter: "بدّل الحرف",
}

const ORDER: readonly HintKind[] = ["meter", "poet", "first_word", "switch_letter"]

export function HintPopover({
  open,
  tier,
  bought,
  reveals,
  onBuy,
  onClose,
  disabled,
}: {
  open: boolean
  tier: DuelTier
  bought: readonly HintKind[]
  reveals: HintReveals
  onBuy: (k: HintKind) => void
  onClose: () => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("mousedown", onDown)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("mousedown", onDown)
    }
  }, [open, onClose])

  const pricing = hintPricing(tier)
  if (!open) return null

  return (
    <div className="popover hint-pop" ref={ref} role="dialog" aria-label="همس">
      {!pricing.allowed ? (
        <p className="hint-pop__none">لا همس في رتبة السيف. أنت وحدك والبيت.</p>
      ) : (
        <ul className="hint-pop__list">
          {ORDER.map((kind) => {
            const price = pricedHint(kind, tier)
            const used = bought.includes(kind)
            const shown = revealOf(kind, reveals)
            return (
              <li key={kind} className="hint-pop__row" data-used={used ? "1" : undefined}>
                <button
                  type="button"
                  className="hint-pop__btn"
                  onClick={() => onBuy(kind)}
                  disabled={used || disabled}
                >
                  <span className="hint-pop__label">{LABEL[kind]}</span>
                  <span className="hint-pop__price">‎−{formatScore(price)}</span>
                </button>
                {shown ? <p className="hint-pop__reveal">{shown}</p> : null}
              </li>
            )
          })}
        </ul>
      )}
      <p className="hint-pop__note">
        الهمس يصف بيتًا يصلح للجواب، لا البيت الذي أمامك. و«بدّل الحرف» يقطع السلسلة ({formatScore(HINT_COSTS.switch_letter)}).
      </p>
    </div>
  )
}

function revealOf(kind: HintKind, r: HintReveals): string | null {
  if (kind === "poet") return r.poet ? `قائله: ${r.poet}` : null
  if (kind === "first_word") return r.firstWord ? `يبدأ بـ«${r.firstWord}»` : null
  if (kind === "meter") return r.meter ? `بحره: ${r.meter}` : null
  return null
}
