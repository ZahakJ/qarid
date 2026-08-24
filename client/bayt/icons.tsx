/**
 * The four marks of the بيت action rail. Inline SVG only — never a font glyph,
 * never a raster (design-ux.md §2, §7). Each inherits `currentColor` and sizes
 * off `1em`, so the rail sets the colour and the scale in one place.
 *
 * They are drawn on a 24-box in the same weight as Ornaments.tsx (1.1px hairline,
 * round caps) so a rail sitting next to a شمسة reads as one hand.
 */
type IconProps = { size?: number | string; className?: string }

function box({ size = "1em", className }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    className,
    fill: "none" as const,
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": true as const,
    focusable: false as const,
  }
}

/** نسخ — two stacked leaves. */
export function CopyMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <rect x="8.5" y="3.5" width="12" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M15.5 20.5h-9a2.5 2.5 0 0 1-2.5-2.5V7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** بطاقة — a framed folio with a ruled line, the share card in miniature. */
export function CardMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <rect x="2.75" y="5" width="18.5" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 10.5h11M6.5 14h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity=".75" />
    </svg>
  )
}

/** ♥ — filled once the بيت is in the مختارات. */
export function HeartMark({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...box(props)}>
      <path
        d="M12 20.3s-7.6-4.5-7.6-9.7A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.6 3c0 5.2-7.6 9.7-7.6 9.7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill={filled ? "currentColor" : "none"}
      />
    </svg>
  )
}

/** ساجِلني — two crossed قلم nibs: the مساجلة itself. */
export function DuelMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M4.6 4.6 15 15M19.4 4.6 9 15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13.4 16.4 16 19l3.4-3.4-2.6-2.6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M10.6 16.4 8 19l-3.4-3.4 2.6-2.6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}
