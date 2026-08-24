/**
 * The loading shape of a بيت. Same grid, same margins, same row height as
 * BaytPlate, so the قصيدة does not jump when the real أبيات land (design-ux.md
 * §6: skeletons match final geometry, nothing spins under 200 ms).
 *
 * The bar widths are a fixed pseudo-random walk, not `Math.random` — a
 * skeleton that reshuffles on every re-render reads as noise (and CLAUDE.md
 * bans Math.random for anything that should be stable).
 */
import type { BaytSize } from "./BaytPlate.tsx"

/** deterministic, gently uneven — two coprime strides over a small range */
function sadrWidth(i: number): number {
  return 62 + ((i * 13) % 26)
}
function ajuzWidth(i: number): number {
  return 54 + ((i * 17) % 30)
}

export function BaytSkeleton({
  rows = 6,
  size = "md",
  numbered = true,
}: {
  rows?: number
  size?: BaytSize
  /** false for a standalone plate (hero, duel) with no margin number */
  numbered?: boolean
}) {
  return (
    <div className="bayt-list" data-skeleton="1" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="bayt-row" key={i} data-skeleton="1">
          {numbered ? <span className="bayt-num" /> : null}
          <div className="bayt bayt--skeleton" data-size={size}>
            <span className="sadr">
              <span className="bayt-bar" style={{ inlineSize: `${sadrWidth(i)}%` }} />
            </span>
            <span className="gutter" />
            <span className="ajuz">
              <span className="bayt-bar" style={{ inlineSize: `${ajuzWidth(i)}%` }} />
            </span>
          </div>
          <div className="bayt-rail" />
        </div>
      ))}
    </div>
  )
}
