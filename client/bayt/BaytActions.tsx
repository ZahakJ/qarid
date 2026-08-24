/**
 * The hover rail that hangs off a بيت: نسخ · بطاقة · ♥ · ساجِلني
 * (design-ux.md §3, Poem → Row interactions).
 *
 * Two layouts, one component:
 *  • `quad` — a 2×2 block in the outer margin of a poem row. It is a QUAD and
 *    not a horizontal strip on purpose: a four-button strip needs ~7rem, which
 *    would either eat the عجز's outer margin or force the rail to overlap the
 *    قافية word. The quad fits inside the row's own block size, so nothing
 *    shifts on hover and no rail ever spills into the neighbouring بيت.
 *  • `row` — a horizontal strip under a framed BaytPlate, where there is width
 *    to spare.
 *
 * An action with no handler is not rendered. A rail button that does nothing is
 * worse than a rail with three buttons.
 */
import type { MouseEvent } from "react"
import { CardMark, CopyMark, DuelMark, HeartMark } from "./icons.tsx"

export type BaytActionsProps = {
  layout?: "quad" | "row"
  /** نسخ — the copy handler; alt/right click opens the caller's copy menu */
  onCopy?: (e: MouseEvent) => void
  /** بطاقة — the share card */
  onCard?: () => void
  favorite?: boolean
  onFavorite?: () => void
  /** ساجِلني — a hash link when the target is a route, else a handler */
  duelHref?: string
  onDuel?: () => void
  /** describes the بيت for the buttons' accessible names */
  label?: string
}

export function BaytActions({
  layout = "quad",
  onCopy,
  onCard,
  favorite = false,
  onFavorite,
  duelHref,
  onDuel,
  label,
}: BaytActionsProps) {
  const suffix = label ? ` — ${label}` : ""
  return (
    <div className="bayt-acts" data-layout={layout} role="group" aria-label={`إجراءات البيت${suffix}`}>
      {onCopy ? (
        <button type="button" className="bayt-act" title="نسخ البيت" aria-label="نسخ البيت" onClick={onCopy}>
          <CopyMark />
        </button>
      ) : null}
      {onCard ? (
        <button type="button" className="bayt-act" title="بطاقة" aria-label="بطاقة البيت" onClick={onCard}>
          <CardMark />
        </button>
      ) : null}
      {onFavorite ? (
        <button
          type="button"
          className="bayt-act"
          data-on={favorite ? "1" : undefined}
          title={favorite ? "أزِل من المختارات" : "أضِف إلى المختارات"}
          aria-label={favorite ? "أزِل من المختارات" : "أضِف إلى المختارات"}
          aria-pressed={favorite}
          onClick={onFavorite}
        >
          <HeartMark filled={favorite} />
        </button>
      ) : null}
      {duelHref ? (
        <a className="bayt-act" href={duelHref} title="ساجِلني من هنا" aria-label="ساجِلني من هذا البيت">
          <DuelMark />
        </a>
      ) : onDuel ? (
        <button type="button" className="bayt-act" title="ساجِلني من هنا" aria-label="ساجِلني من هذا البيت" onClick={onDuel}>
          <DuelMark />
        </button>
      ) : null}
    </div>
  )
}
