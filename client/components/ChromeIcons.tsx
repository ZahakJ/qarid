/**
 * The marks of the phone chrome — the five tab icons, the back chevron, and the
 * disclosure chevron of a «المزيد» row.
 *
 * Same hand as Ornaments.tsx and bayt/icons.tsx: inline SVG on a 24-box, never a
 * font glyph and never a raster. The tab icons are drawn at 1.5px so a 24px
 * icon reads at arm's length on a phone, where the بيت rail's 1.4px hairline
 * would disappear; caps and joins are round, as everywhere else.
 *
 * Each one is the app's own vocabulary rather than a stock glyph set: a شمسة
 * for the ديوان (it is the mark that opens a folio), an open codex for التصفح,
 * the two crossed قلم nibs the مساجلة already uses on every بيت, stacked
 * بطاقات for التحفيظ, and three dots for المزيد.
 */
type IconProps = { size?: number | string; className?: string }

function box({ size = 24, className }: IconProps) {
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

const STROKE = { stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }

/** الديوان — the شمسة that marks a folio, drawn as a line rosette. */
export function DiwanMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M12 2.6 13.7 8.3 19.4 6.6 17.1 12 19.4 17.4 13.7 15.7 12 21.4 10.3 15.7 4.6 17.4 6.9 12 4.6 6.6 10.3 8.3Z" {...STROKE} />
      <circle cx="12" cy="12" r="2.4" {...STROKE} />
    </svg>
  )
}

/** التصفح — an open codex: two leaves over a spine. */
export function BrowseMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M12 6.4v13" {...STROKE} />
      <path d="M12 6.4C10.4 5 8.4 4.3 5.9 4.3H3.2v13h2.7c2.5 0 4.5.7 6.1 2.1" {...STROKE} />
      <path d="M12 6.4c1.6-1.4 3.6-2.1 6.1-2.1h2.7v13h-2.7c-2.5 0-4.5.7-6.1 2.1" {...STROKE} />
    </svg>
  )
}

/** المساجلة — the two crossed nibs of `DuelMark`, redrawn at chrome weight. */
export function DuelTabMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M4.4 4.4 15.2 15.2M19.6 4.4 8.8 15.2" {...STROKE} />
      <path d="M13.4 16.6 16.1 19.3 19.7 15.7 17 13" {...STROKE} />
      <path d="M10.6 16.6 7.9 19.3 4.3 15.7 7 13" {...STROKE} />
    </svg>
  )
}

/** التحفيظ — three بطاقات in a stack, the front one ruled. */
export function TrainMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M6.6 6.2 8 3.4l11 4.4-1.3 2.6" {...STROKE} opacity=".55" />
      <rect x="3.2" y="8.6" width="17.6" height="12" rx="2.6" {...STROKE} />
      <path d="M7.4 12.6h9.2M7.4 16.2h5.6" {...STROKE} opacity=".7" />
    </svg>
  )
}

/** المزيد — three dots on the reading line. */
export function MoreMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <circle cx="5.6" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="18.4" cy="12" r="1.7" fill="currentColor" />
    </svg>
  )
}

/**
 * «رجوع». Under RTL, back is toward the inline-start edge — the RIGHT — so the
 * chevron points right, the mirror of what an LTR app draws.
 */
export function BackChevron(props: IconProps) {
  return (
    <svg {...box({ size: 22, ...props })}>
      <path d="M9.5 5 16.5 12 9.5 19" {...STROKE} />
    </svg>
  )
}

/** A settings row's disclosure. Forward under RTL is toward the LEFT. */
export function ForwardChevron(props: IconProps) {
  return (
    <svg {...box({ size: 18, ...props })}>
      <path d="M14.5 5 7.5 12 14.5 19" {...STROKE} />
    </svg>
  )
}

/* ── the marks of a «المزيد» row ──────────────────────────────────────────
 *
 * Smaller siblings of the tab icons — same box, same weight, same hand. Each
 * one names a door the شعراء index, بيت اليوم, التجوال and the rest already
 * have elsewhere in the app, so the row is recognisable before its label is
 * read. */

/** الشعراء — the medallion the شاعر cards and the index hero wear. */
export function PoetsMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <circle cx="12" cy="12" r="8.6" {...STROKE} />
      <circle cx="12" cy="12" r="4.6" {...STROKE} opacity=".6" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </svg>
  )
}

/** بيت اليوم — one بيت for everyone, on the day's own seal. */
export function DayMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <circle cx="12" cy="12" r="4.4" {...STROKE} />
      <path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6" {...STROKE} />
      <path d="m5.4 5.4 1.9 1.9M16.7 16.7l1.9 1.9M18.6 5.4l-1.9 1.9M7.3 16.7l-1.9 1.9" {...STROKE} opacity=".6" />
    </svg>
  )
}

/** التجوال — a compass rose: one بيت, and three doors out of it. */
export function WanderMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <circle cx="12" cy="12" r="8.8" {...STROKE} />
      <path d="m15.4 8.6-1.9 5-5 1.9 1.9-5Z" {...STROKE} />
    </svg>
  )
}

/**
 * المختارات المنظومة — a shelf of bound spines, with the middle one drawn out.
 *
 * A rosette would have collided with الشعراء's medallion and a ♥ with
 * المختارات's; a shelf is the one thing on the list that is neither a person
 * nor a keepsake but a PLACE, and the pulled spine says it can be opened.
 */
export function ShelfMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M4.4 6.2h3.1v13.4H4.4zM9.4 6.2h3.1v13.4H9.4z" {...STROKE} />
      <path d="M15.2 5.2h3.1v13.4h-3.1z" {...STROKE} opacity=".7" transform="rotate(11 16.75 11.9)" />
      <path d="M3.4 21.4h17.2" {...STROKE} opacity=".55" />
    </svg>
  )
}

/**
 * البحور — a دائرة عروضية, drawn as what it is: a ring you TRAVEL.
 *
 * الخليل's circles are not a metaphor. He wrote the أجزاء around the rim of an
 * actual circle and read each بحر off it by entering at a different جزء and
 * going round — which is why الطويل and المديد come off the same circle. So the
 * ring is OPEN, with a full dot where the reading starts and two fainter ones
 * along the way.
 *
 * It was a closed ring with a smaller ring inside first, and at 24px on
 * «المزيد» that was indistinguishable from الشعراء's medallion two rows above
 * it. The gap is what makes it a different object, not a different size of the
 * same one.
 */
export function BuhurMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M20.2 12A8.2 8.2 0 1 1 12.6 3.82" {...STROKE} />
      <circle cx="20.2" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="20.2" r="1.15" fill="currentColor" opacity=".7" />
      <circle cx="3.8" cy="12" r="1.15" fill="currentColor" opacity=".45" />
    </svg>
  )
}

/**
 * باحث القافية — two شطران, and a ring around what ends the second one.
 *
 * The قافية is a PLACE before it is a letter: the end of the line. Under RTL
 * that end is the inline-start edge, which is where the ring sits — so the mark
 * points at the same corner of a بيت that the lapis روي underline does.
 */
export function QafiyaMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M20 7.6H7.2" {...STROKE} />
      <path d="M20 13.2h-6.4" {...STROKE} opacity=".75" />
      <path d="M20 18.8H9.6" {...STROKE} opacity=".5" />
      <circle cx="6.2" cy="13.2" r="2.9" {...STROKE} />
    </svg>
  )
}

/** المختارات — the same ♥ the بيت rail fills when a بيت is kept. */
export function KeepMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M12 20.3s-7.6-4.5-7.6-9.7A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.6 3c0 5.2-7.6 9.7-7.6 9.7Z" {...STROKE} />
    </svg>
  )
}

/** الإحصاءات — the ديوان, counted. */
export function StatsMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M4.2 20V13.4M9.4 20V7.6M14.6 20v-9.2M19.8 20V4.6" {...STROKE} />
    </svg>
  )
}

/** قواعد المساجلة — a folio of rules, ruled. */
export function RulesMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M5.6 3.4h9.1l4.7 4.7V20a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 20V5A1.6 1.6 0 0 1 5.6 3.4Z" {...STROKE} />
      <path d="M14.4 3.6v4.6h4.6" {...STROKE} opacity=".6" />
      <path d="M7.6 13h8.8M7.6 16.6h5.6" {...STROKE} opacity=".7" />
    </svg>
  )
}

/** الحساب — the نِيب disc, in outline. */
export function AccountMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <circle cx="12" cy="9.2" r="3.8" {...STROKE} />
      <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" {...STROKE} />
    </svg>
  )
}

/** خروج — the door, and the way out of it. */
export function SignOutMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M14.6 4.4H6.8A1.8 1.8 0 0 0 5 6.2v11.6a1.8 1.8 0 0 0 1.8 1.8h7.8" {...STROKE} />
      <path d="M18.4 12H10m0 0 3-3m-3 3 3 3" {...STROKE} />
    </svg>
  )
}

/** سياسة الخصوصية — the shield the policy is. */
export function ShieldMark(props: IconProps) {
  return (
    <svg {...box(props)}>
      <path d="M12 3 19.4 5.8v6c0 4.2-3 7.4-7.4 9.2-4.4-1.8-7.4-5-7.4-9.2v-6Z" {...STROKE} />
      <path d="m8.8 12 2.3 2.3 4.1-4.4" {...STROKE} opacity=".75" />
    </svg>
  )
}
