/**
 * ONE chip component. The four variants differ by SHAPE and SVG mark, never by
 * hue (design-ux.md §2) — colour is reserved for state: active gets the accent
 * border + dim fill + glow, a zero-count facet dims to 32%.
 *
 *   bahr    pill, carries the meter's first تفعيلة as its mark
 *   gharad  filled pill
 *   asr     square-cornered
 *   rawiyy  circular 1.9em letter well in Amiri behind a lapis hairline
 */
import type { ReactNode } from "react"
import { bahrGlyph } from "../data/buhur.ts"

export type ChipVariant = "bahr" | "gharad" | "asr" | "rawiyy"

export function Chip({
  variant,
  label,
  count,
  active = false,
  slug,
  title,
  onClick,
  disabled = false,
}: {
  variant: ChipVariant
  label: ReactNode
  /** facet chips carry counts; a 0 dims and disables the chip */
  count?: number
  active?: boolean
  /** meter slug — supplies the tafʿila glyph on a بحر chip */
  slug?: string
  title?: string
  onClick?: () => void
  disabled?: boolean
}) {
  const zero = count === 0
  const glyph = variant === "bahr" && slug ? bahrGlyph(slug) : ""
  const inner = (
    <>
      {glyph ? (
        <span className="chip__mark" aria-hidden="true">
          {glyph}
        </span>
      ) : null}
      <span className="chip__label">{label}</span>
      {count !== undefined ? <span className="chip__count">{count.toLocaleString("ar-EG")}</span> : null}
    </>
  )
  const className = `chip chip--${variant}`
  if (!onClick) {
    return (
      <span className={className} data-active={active ? "1" : undefined} data-zero={zero ? "1" : undefined} title={title}>
        {inner}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={className}
      data-active={active ? "1" : undefined}
      data-zero={zero ? "1" : undefined}
      title={title}
      onClick={onClick}
      disabled={disabled || zero}
      aria-pressed={active}
    >
      {inner}
    </button>
  )
}
