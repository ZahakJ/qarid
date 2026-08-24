/**
 * الشعراء ← العصر ← الشاعر. The separator points back toward the root; in RTL
 * that is ←, which reads as "then" going right-to-left (amendments §15).
 *
 * Crumbs are real `<a href="#/…">` — hash navigation, so middle-click and
 * copy-link behave the way the browser already knows how to.
 */
import { routeHash, type Route } from "../router.ts"

export type Crumb = { label: string; route?: Route }

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="crumbs" aria-label="مسار التصفح">
      {items.map((c, i) => {
        const last = i === items.length - 1
        return [
          i > 0 ? (
            <span className="crumbs__sep" key={`sep-${i}`} aria-hidden="true">
              ←
            </span>
          ) : null,
          c.route && !last ? (
            <a href={routeHash(c.route)} key={`crumb-${i}`}>
              <bdi>{c.label}</bdi>
            </a>
          ) : (
            <span key={`crumb-${i}`} aria-current={last ? "page" : undefined}>
              <bdi>{c.label}</bdi>
            </span>
          ),
        ]
      })}
    </nav>
  )
}
