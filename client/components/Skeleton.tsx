/**
 * The skeleton PRIMITIVE — a ruled bar with the gold sweep. Loading
 * placeholders match the FINAL geometry, never a spinner, and nothing renders
 * at all under 200 ms (design-ux.md §6).
 *
 * The بيت-shaped skeleton is NOT here: `client/bayt/BaytSkeleton.tsx` is the
 * only one, because it has to reproduce `BaytPlate`'s real row geometry (the
 * number column, the gutter, the reserved action rail) and a second copy drifts
 * from it the first time that grid changes. This file had such a copy; it was
 * unused, its `.bayt-skeleton` class was never styled, and it is gone.
 */
export function Skeleton({ w = "100%", h = "1em", radius }: { w?: string; h?: string; radius?: string }) {
  return <span className="skeleton" style={{ inlineSize: w, blockSize: h, borderRadius: radius }} aria-hidden="true" />
}
