/** A framed surface. `illuminated` adds the four manuscript corners. */
import type { ReactNode } from "react"
import { PanelCorners } from "./Ornaments.tsx"

export function Panel({
  title,
  note,
  actions,
  illuminated = false,
  quiet = false,
  className,
  children,
}: {
  title?: ReactNode
  note?: ReactNode
  actions?: ReactNode
  illuminated?: boolean
  quiet?: boolean
  className?: string
  children?: ReactNode
}) {
  const classes = ["panel"]
  if (quiet) classes.push("panel--quiet")
  if (illuminated) classes.push("panel--illuminated")
  if (className) classes.push(className)
  return (
    <section className={classes.join(" ")}>
      {illuminated ? <PanelCorners /> : null}
      {title || note || actions ? (
        <header className="panel__head">
          <div>
            {title ? <h2 className="panel__title">{title}</h2> : null}
            {note ? <p className="panel__note">{note}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  )
}
