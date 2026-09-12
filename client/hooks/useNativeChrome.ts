/**
 * ONE signal for «is this a phone?», read by JS and by CSS alike.
 *
 * The app already had two halves of an answer and they were never combined:
 * `(hover: none), (pointer: coarse)` decides what `.keys-only` shows, and
 * `useNarrow()` (860px) decides row heights. The native chrome — the bottom tab
 * bar, the compact app bar, the «المزيد» screen — needs BOTH: a narrow desktop
 * window is still a desktop and must keep the masthead, and a coarse-pointer
 * tablet at 1200px is not a phone either. The Capacitor shell satisfies both by
 * construction, which is the point.
 *
 * The result is mirrored onto `body[data-chrome]` (App.tsx) so
 * client/styles/chrome.css can react to the SAME decision rather than
 * re-deriving it from a media query that could drift. Every rule in that sheet
 * is scoped under the attribute, which is also what keeps desktop pixel-
 * identical: with no attribute, none of it matches.
 */
import { NARROW, useMediaQuery } from "./useMediaQuery.ts"

/** A touch pointer — the same feature `.keys-only` is gated on (base.css). */
export const COARSE = "(hover: none), (pointer: coarse)"

export function useNativeChrome(): boolean {
  const narrow = useMediaQuery(NARROW)
  const coarse = useMediaQuery(COARSE)
  return narrow && coarse
}
