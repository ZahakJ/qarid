/** Empty states carry a real بيت, not an apology (design-ux.md §2). */
import type { ReactNode } from "react"
import { FLAVOR, FLAVOR_TITLE, type FlavorKey } from "../data/flavor.ts"
import { Rule } from "./Ornaments.tsx"

export function EmptyState({
  flavor,
  title,
  children,
}: {
  flavor: FlavorKey
  /** overrides the default headline for this flavor */
  title?: string
  children?: ReactNode
}) {
  const bayt = FLAVOR[flavor]
  return (
    <div className="empty">
      <h2 className="empty__title">{title ?? FLAVOR_TITLE[flavor]}</h2>
      <Rule style={{ inlineSize: "min(18rem, 60%)" }} />
      <p className="empty__bayt">
        {bayt.sadr}
        <span aria-hidden="true"> … </span>
        {bayt.ajuz}
      </p>
      {bayt.poet ? <p className="empty__attrib">{bayt.poet}</p> : null}
      {children}
    </div>
  )
}
