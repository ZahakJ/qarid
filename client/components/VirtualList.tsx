/**
 * A windowed list over the PAGE scroller (design-ux.md §6): poets index, a
 * poet's ديوان, browse results. Never verse — amendments.md §12 keeps بيت rows
 * whole under `content-visibility` so Ctrl+F and anchors survive.
 *
 * The rows themselves are a fixed height so the maths in `useWindowedList` can
 * stay a pure function; `rowHeight` is a CSS contract, not a measurement, and
 * every list that uses this sets the matching `--row-h` in the stylesheet.
 */
import type { ReactNode } from "react"
import { useWindowedList } from "../hooks/useWindowedList.ts"

export function VirtualList<T>({
  items,
  rowHeight,
  render,
  keyOf,
  className,
  label,
  overscan,
}: {
  items: readonly T[]
  rowHeight: number
  render: (item: T, index: number) => ReactNode
  keyOf: (item: T, index: number) => string
  className?: string
  label?: string
  overscan?: number
}) {
  const { ref, window: win } = useWindowedList(items.length, rowHeight, overscan)
  const slice = items.slice(win.start, win.end)
  return (
    <div className={className ? `vlist ${className}` : "vlist"} ref={ref} role="list" aria-label={label}>
      {win.padStart > 0 ? <div style={{ blockSize: `${win.padStart}px` }} aria-hidden="true" /> : null}
      {slice.map((item, i) => (
        <div className="vlist__row" role="listitem" key={keyOf(item, win.start + i)} style={{ blockSize: `${rowHeight}px` }}>
          {render(item, win.start + i)}
        </div>
      ))}
      {win.padEnd > 0 ? <div style={{ blockSize: `${win.padEnd}px` }} aria-hidden="true" /> : null}
    </div>
  )
}
