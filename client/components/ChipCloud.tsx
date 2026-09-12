/**
 * A cloud of facet chips with counts — العصر / البحر / الغرض in the browse rail
 * and the شاعر-scoped chips on a poet page (design-ux.md §3).
 *
 * Sorting is the caller's job (the server already sends eras and meters in
 * their classical order, and re-sorting by count would put المتقارب before
 * الطويل). What this owns is the two behaviours every cloud shares: a zero
 * count disables the chip, and clicking the ACTIVE chip clears the facet.
 */
import { Chip, type ChipVariant } from "./Chip.tsx"

export type CloudItem = {
  slug: string
  label: string
  count?: number
  title?: string
}

export function ChipCloud({
  variant,
  items,
  active,
  onPick,
  showCounts = true,
  emptyNote,
}: {
  variant: ChipVariant
  items: readonly CloudItem[]
  active?: string | null
  /** called with the slug, or with `undefined` when the active chip is clicked */
  onPick: (slug: string | undefined) => void
  showCounts?: boolean
  emptyNote?: string
}) {
  if (items.length === 0) {
    return emptyNote ? <p className="facet-empty">{emptyNote}</p> : null
  }
  return (
    <div className="chip-cloud">
      {items.map((it) => {
        const isActive = it.slug === active
        return (
          <Chip
            key={it.slug}
            variant={variant}
            slug={variant === "bahr" ? it.slug : undefined}
            label={it.label}
            /* the ACTIVE chip keeps its count too. Hiding it dropped the number
               exactly when it mattered most — the one facet constraining the
               result set was the one whose share the reader could not see. */
            count={showCounts ? it.count : undefined}
            active={isActive}
            title={it.title}
            onClick={() => onPick(isActive ? undefined : it.slug)}
          />
        )
      })}
    </div>
  )
}
