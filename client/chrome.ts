/**
 * The phone chrome's map of the app: which tab a screen belongs to, which
 * screens are tab ROOTS, and where «رجوع» goes when there is no history to go
 * back into.
 *
 * All of it is pure, and all of it is here rather than in the two components
 * that read it, because the tab bar and the app bar have to agree: a screen the
 * tab bar lights «التصفح» for is a screen the app bar must NOT draw a back
 * chevron on, and vice versa. One table, two readers.
 *
 * The tab order is the RTL reading order — الديوان first, so it renders at the
 * inline-start (right) edge of the bar.
 */
import { HOME, navDepth, navigate, type Route } from "./router.ts"

export type TabId = "home" | "browse" | "duel" | "train" | "more"

/** The five tab roots, in RTL order. */
export const TABS: { id: TabId; label: string; route: Route }[] = [
  { id: "home", label: "الديوان", route: HOME },
  { id: "browse", label: "التصفح", route: { view: "browse", query: {} } },
  { id: "duel", label: "المساجلة", route: { view: "duel" } },
  { id: "train", label: "التحفيظ", route: { view: "train" } },
  { id: "more", label: "المزيد", route: { view: "more" } },
]

/**
 * Which tab owns a screen — by its CONTENT, never by where the reader happened
 * to enter it from. #/poets is reached from «المزيد» on a phone and from a
 * قصيدة's crumbs on the web, and in both cases it is the ديوان; lighting
 * «المزيد» because that was the door would make the bar report the path taken
 * instead of the place reached.
 */
export function tabOf(route: Route): TabId {
  switch (route.view) {
    case "browse":
    // باحث القافية is التصفح asked a poet's question instead of a reader's —
    // same corpus, same أبيات, and its quiet door is on the browse rail's روي
    // grid. Lighting الديوان there would make the tab bar disagree with the
    // screen the reader pressed to get here.
    case "qafiya":
      return "browse"
    case "duel":
    case "duel-play":
    case "duel-summary":
    case "room":
    case "rules":
      return "duel"
    case "train":
    case "train-drill":
    case "train-arsenal":
      return "train"
    case "more":
    case "privacy":
    case "profile":
      return "more"
    default:
      // home, poets, poet, poem, search, favorites, stats, daily, wander,
      // anthology, buhur, diwan, diwans — every reading surface belongs to the
      // ديوان, and a ديوان a reader compiled himself most of all.
      // المختارات المنظومة is reached from HOME on a phone, so it lights
      // الديوان; صفحة البحور is a lesson ABOUT the ديوان and lights it too.
      return "home"
  }
}

/** A tab ROOT gets the title-and-tools app bar; everything else gets a back chevron. */
export function isTabRoot(route: Route): boolean {
  switch (route.view) {
    case "home":
    case "browse":
    case "duel":
    case "train":
    case "more":
      return true
    default:
      return false
  }
}

/**
 * Where «رجوع» lands when there is nothing behind this screen — a shared
 * `#/poem/…` link opened cold, or the app's very first screen.
 *
 * It is the screen the reader would have COME from, which is not always the
 * screen's own tab: الشعراء is a ديوان surface but its only door on a phone is
 * «المزيد», so that is where an orphaned back chevron returns to.
 */
export function parentRoute(route: Route): Route {
  switch (route.view) {
    case "poet":
      return { view: "poets" }
    case "poets":
    case "favorites":
    case "diwans":
    case "stats":
    case "daily":
    case "wander":
    case "privacy":
    case "profile":
    // صفحة البحور's phone door is «المزيد», like الشعراء's — a بحر chip's
    // popover also links here, but that is a push, and this is the fallback for
    // when there is nothing behind us.
    case "buhur":
      return { view: "more" }
    // باحث القافية is opened from the browse rail, so an orphaned back chevron
    // returns to the التصفح it was a door on.
    case "qafiya":
      return { view: "browse", query: {} }
    // A shelf's parent is the shelf strip it sits on, which is a real page.
    case "anthology-shelf":
      return { view: "anthology" }
    // …and a compiled ديوان's parent is «دواويني» — which is the right landing
    // for a VISITOR too: he arrives on a shared link, and the page he is sent
    // to when he presses back is his own shelf list, empty or not.
    case "diwan":
      return { view: "diwans" }
    case "anthology":
      return HOME
    case "duel-play":
    case "duel-summary":
    case "room":
    case "rules":
      return { view: "duel" }
    case "train-drill":
    case "train-arsenal":
      return { view: "train" }
    default:
      // poem, search and the tab roots themselves
      return HOME
  }
}

/**
 * The back chevron's action: the history stack when we are standing on
 * something this app pushed, and the parent screen when we are not.
 *
 * `navDepth()` is 0 exactly on the entry the reader arrived at, so a cold
 * `#/room/BADIRU` link has a back button that opens المساجلة rather than one
 * that throws them out of the app.
 */
export function goBack(route: Route): void {
  if (navDepth() > 0) history.back()
  else navigate(parentRoute(route))
}

/**
 * Per-tab scroll memory (the other half of `pageKey`, App.tsx).
 *
 * A hash router changes no document, so the window keeps the previous page's
 * offset and `pageKey` exists to send a NEW page back to its top. A tab bar
 * inverts exactly one case of that: pressing «التصفح» after wandering off into
 * a قصيدة is a RETURN, not an arrival, and a native tab that forgets where you
 * were reading is the tell that it is a website with a bar stuck on it.
 *
 * So the rule stays «a new page starts at its top» and gains one exception:
 * a TAB ROOT is restored to the offset it was left at. Sub-screens keep the old
 * behaviour outright — every one of them is either a fresh page or a deep link.
 */
const scrollPositions = new Map<string, number>()

export function rememberScroll(key: string, y: number): void {
  if (y > 0) scrollPositions.set(key, y)
  else scrollPositions.delete(key)
}

/**
 * Where the window should sit when `route` (identified by `key`) is entered.
 *
 * `native` gates the whole exception: the desktop web has no tab bar, so it has
 * no «return to a tab» gesture either, and CLAUDE.md's rule there stands
 * unamended — a new page starts at its top, every time.
 */
export function scrollTargetFor(route: Route, key: string, native: boolean): number {
  if (!native || !isTabRoot(route)) return 0
  return scrollPositions.get(key) ?? 0
}

/** Test seam — the map is module state, and a test may not leak into the next. */
export function resetScrollMemory(): void {
  scrollPositions.clear()
}
