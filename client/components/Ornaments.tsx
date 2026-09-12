/**
 * Ornaments — inline SVG only. Never a font glyph, never a raster (design-ux.md
 * §2, §7). Each takes `size` in px and inherits `currentColor`, so a parent sets
 * the gold and the ornament follows.
 */
import type { CSSProperties } from "react"

type OrnamentProps = {
  size?: number
  className?: string
  style?: CSSProperties
  /** decorative by default — pass a label to expose it */
  title?: string
}

function svgProps({ size, className, style, title }: OrnamentProps, box: number) {
  return {
    width: size,
    height: size,
    viewBox: `0 0 ${box} ${box}`,
    className,
    style,
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    role: title ? ("img" as const) : ("presentation" as const),
    "aria-hidden": title ? undefined : (true as const),
    "aria-label": title,
    focusable: false as const,
  }
}

/**
 * شمسة — the eight-point rosette that marks a folio. Sits in the empty gutter
 * of a بيت and fades in on hover.
 */
export function Shamsa(props: OrnamentProps) {
  const { size = 12 } = props
  return (
    <svg {...svgProps({ ...props, size }, 24)}>
      <path
        d="M12 1.6 13.9 8 20.4 6.1 16.6 11.7 22.4 15.1 15.7 15.9 16.9 22.4 12 17.9 7.1 22.4 8.3 15.9 1.6 15.1 7.4 11.7 3.6 6.1 10.1 8Z"
        fill="currentColor"
        opacity=".9"
      />
      <circle cx="12" cy="12" r="2.1" fill="var(--bg-0, #07080c)" />
    </svg>
  )
}

/**
 * The dissolving gold hairline. Not an SVG — a 1px band painted with the
 * `--rule-gold` gradient, which fades at both ends exactly as §2 specifies.
 */
export function Rule({ className, style }: { className?: string; style?: CSSProperties }) {
  return <hr className={className ? `rule ${className}` : "rule"} style={style} />
}

/**
 * A corner bracket from a manuscript frame. Drawn for the block-start /
 * inline-start corner; the other three are the same path, mirrored by CSS
 * (`.panel__corner[data-at=…]`).
 */
export function Corner(props: OrnamentProps) {
  const { size = 18 } = props
  return (
    <svg {...svgProps({ ...props, size }, 24)}>
      <path
        d="M2 22V8.5C2 4.9 4.9 2 8.5 2H22"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity=".7"
      />
      <path d="M6 22V10.5C6 8 8 6 10.5 6H22" stroke="currentColor" strokeWidth="0.7" strokeLinecap="round" opacity=".45" />
      <circle cx="8.6" cy="8.6" r="1.5" fill="currentColor" opacity=".85" />
    </svg>
  )
}

/**
 * قلم — the cut nib. Favicon, footer mark, and one nib per life in the duel HUD
 * (spent lives drop to 18% opacity).
 */
export function Nib(props: OrnamentProps) {
  const { size = 16 } = props
  return (
    <svg {...svgProps({ ...props, size }, 24)}>
      <path d="M6 21c5.4-1.8 9.4-6.4 11.4-13.2L21 11c-2 7.4-6.8 10.9-15 12Z" fill="currentColor" />
    </svg>
  )
}

/** The four corners of a framed panel, positioned by CSS logical offsets. */
export function PanelCorners({ size = 18 }: { size?: number }) {
  return (
    <>
      {(["ts", "te", "bs", "be"] as const).map((at) => (
        <span key={at} className="panel__corner" data-at={at} aria-hidden="true">
          <Corner size={size} />
        </span>
      ))}
    </>
  )
}
