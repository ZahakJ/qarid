/**
 * The bottom tab bar — the centrepiece of the phone chrome.
 *
 * Five doors, fixed to the bottom edge, in the RTL reading order: الديوان ·
 * التصفح · المساجلة · التحفيظ · المزيد. It renders only where the chrome
 * applies (a coarse pointer AND a narrow viewport — `useNativeChrome`), so the
 * web masthead is untouched and nothing here exists in the desktop DOM at all.
 *
 * Three things make it a TAB bar rather than a row of links:
 *
 *  • The active tab is decided by `tabOf(route)`, which maps every screen in
 *    the app onto one of the five — so a قصيدة reached from التصفح still lights
 *    التصفح, and the bar never goes blank in the middle of a journey.
 *  • Pressing the tab you are already standing on returns to that tab's ROOT
 *    (the native gesture), instead of re-navigating to a hash the router would
 *    ignore.
 *  • The whole cell is the target, and it is at least 48px tall, so the label
 *    is a caption of the button rather than a second, smaller button.
 *
 * The icons are `ChromeIcons.tsx`; the press state and the indicator's arrival
 * are motion.css's, in the app's one easing family.
 */
import { TABS, tabOf } from "../chrome.ts"
import { hapticTick } from "../platform/haptics.ts"
import { navigate, routeHash, type Route } from "../router.ts"
import { BrowseMark, DiwanMark, DuelTabMark, MoreMark, TrainMark } from "./ChromeIcons.tsx"

const ICON = {
  home: DiwanMark,
  browse: BrowseMark,
  duel: DuelTabMark,
  train: TrainMark,
  more: MoreMark,
} as const

export function TabBar({ route }: { route: Route }) {
  const active = tabOf(route)
  return (
    <nav className="tabbar" aria-label="أبواب قريض">
      <ul className="tabbar__row">
        {TABS.map((tab) => {
          const Icon = ICON[tab.id]
          const on = tab.id === active
          return (
            <li className="tabbar__cell" key={tab.id}>
              <a
                className="tabbar__tab"
                href={routeHash(tab.route)}
                aria-current={on ? "page" : undefined}
                data-on={on ? "1" : "0"}
                onClick={(e) => {
                  // One light tick per press — a no-op on the web, a real buzz
                  // in the Capacitor shell (client/platform/haptics.ts).
                  hapticTick()
                  // Standing on the tab already: the press means «take me back
                  // to the root of this tab», which is what a native bar does.
                  // The `href` is that root and would be a no-op navigation, so
                  // it has to be asked for explicitly.
                  if (!on || route.view === tab.route.view) return
                  e.preventDefault()
                  navigate(tab.route)
                }}
              >
                <span className="tabbar__ind" aria-hidden="true" />
                <span className="tabbar__icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="tabbar__label">{tab.label}</span>
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
