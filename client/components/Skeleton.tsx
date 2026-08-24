/**
 * Loading placeholders that match the FINAL geometry — never a spinner, and
 * nothing at all under 200 ms (design-ux.md §6).
 */
export function Skeleton({ w = "100%", h = "1em", radius }: { w?: string; h?: string; radius?: string }) {
  return <span className="skeleton" style={{ inlineSize: w, blockSize: h, borderRadius: radius }} aria-hidden="true" />
}

/** The BaytPlate grid as ruled bars: two hemistichs and the quiet gutter. */
export function BaytSkeleton({ rows = 1 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="bayt-skeleton" key={i}>
          <span style={{ inlineSize: `${64 + ((i * 7) % 22)}%`, justifySelf: "start" }} />
          <span style={{ background: "none" }} />
          <span style={{ inlineSize: `${58 + ((i * 11) % 28)}%`, justifySelf: "end" }} />
        </div>
      ))}
    </div>
  )
}
