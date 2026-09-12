/**
 * THE CENTRED DIALOG'S SCRIM — and the one thing every `.overlay` in قريض must
 * do: be a PORTAL onto `document.body`.
 *
 * ── THE TRAP (CLAUDE.md §Invariants, and it bit five dialogs) ──────────────
 *
 * `position: fixed` is measured against the viewport ONLY while no ancestor has
 * a transform. motion.css gives `.route-swap` — the wrapper App.tsx puts around
 * EVERY view — `animation: qr-rise … both`; `both` keeps the animation filling
 * its `to` keyframe forever, that keyframe says `transform: none`, and Chromium
 * resolves it to the IDENTITY matrix rather than to `none`. So the wrapper is a
 * containing block for the life of the page, and a `.overlay` opened from
 * inside a view is laid out against the VIEW's box, not the screen.
 *
 * What that looked like, measured on #/duel at 390 before this component
 * existed: the walkthrough's scrim at y = −1,237, height 3,805, bottom 2,568 in
 * an 844px viewport; «التالي», «السابق» and the five step dots at y 902–1,006,
 * entirely below the fold; scroll 400px and the ✕ is gone with the page. That
 * is the tutorial v2.md §1 auto-offers ONCE to every new player, so a first-run
 * phone reader could not advance past step 1 except by accident. The
 * delete-account confirm was worse than clipped: its scrim ended 312px above the
 * bottom edge, so `elementFromPoint` at the tab bar returned the tab's own svg
 * and a reader could tap «التصفح» straight out of an irreversible confirmation.
 *
 * `Sheet` and `PhoneSearch` already portal for exactly this reason. This is the
 * same fix for the surface they do not cover, and it is applied to EVERY
 * `.overlay` — including the three App.tsx mounts that were never inside a view
 * — so that the rule has no exceptions to remember and cannot drift when a
 * dialog moves.
 *
 * It owns the portal and nothing else: the scrim's dismiss handler, the role,
 * the label and the `.overlay__card` inside stay at the call site, because they
 * differ per dialog (the recovery-code sheet, for one, deliberately refuses to
 * dismiss on its scrim).
 */
import type { ReactNode } from "react"
import { createPortal } from "react-dom"

export type OverlayProps = {
  children: ReactNode
  /** the scrim's own class, when a dialog needs a measure of its own */
  className?: string
  role?: string
  "aria-modal"?: boolean
  "aria-label"?: string
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void
}

export function Overlay({ children, className, ...rest }: OverlayProps) {
  return createPortal(
    <div className={className ? `overlay ${className}` : "overlay"} {...rest}>
      {children}
    </div>,
    document.body,
  )
}
