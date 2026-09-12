/**
 * The phone chrome's map of the app (client/chrome.ts).
 *
 * Two properties this pins, both of which are how the two bars stay in
 * agreement: EVERY route lands on exactly one tab, and a screen the tab bar
 * lights as a root is a screen the app bar draws no back chevron on.
 */
import { describe, expect, it } from "vitest"

import { TABS, isTabRoot, parentRoute, rememberScroll, resetScrollMemory, scrollTargetFor, tabOf } from "./chrome.ts"
import { parseHash, routeHash, type Route } from "./router.ts"

/** One canonical Route per `view` — the same shape router.test.ts walks. */
const EVERY_ROUTE: Route[] = [
  { view: "home" },
  { view: "poets" },
  { view: "poet", slug: "mutanabi" },
  { view: "poem", id: "q12" },
  { view: "browse", query: {} },
  { view: "search", q: "الخيل", page: 1 },
  { view: "wander" },
  { view: "duel" },
  { view: "duel-play" },
  { view: "duel-summary" },
  { view: "daily" },
  { view: "train" },
  { view: "train-drill" },
  { view: "train-arsenal" },
  { view: "stats" },
  { view: "favorites" },
  { view: "rules" },
  { view: "privacy" },
  { view: "more" },
  { view: "profile", username: "labid" },
  { view: "room", code: "BADIRU" },
]

describe("#/more is a route like any other", () => {
  it("round-trips through the hash", () => {
    expect(routeHash({ view: "more" })).toBe("#/more")
    expect(parseHash("#/more")).toEqual({ view: "more" })
  })
})

describe("the tab map", () => {
  it("covers every view in the app", () => {
    const ids = new Set(TABS.map((t) => t.id))
    for (const route of EVERY_ROUTE) expect(ids.has(tabOf(route))).toBe(true)
  })

  it("has five tabs, in RTL reading order, each rooted on its own view", () => {
    expect(TABS.map((t) => t.id)).toEqual(["home", "browse", "duel", "train", "more"])
    expect(TABS.map((t) => t.label)).toEqual(["الديوان", "التصفح", "المساجلة", "التحفيظ", "المزيد"])
    for (const tab of TABS) expect(tabOf(tab.route)).toBe(tab.id)
  })

  it("lights a tab's own root and only those five", () => {
    const roots = EVERY_ROUTE.filter(isTabRoot).map((r) => r.view)
    expect(roots).toEqual(["home", "browse", "duel", "train", "more"])
    for (const tab of TABS) expect(isTabRoot(tab.route)).toBe(true)
  })

  it("keeps a sub-screen on the tab its CONTENT belongs to, not the door it was opened from", () => {
    // #/poets is reached through «المزيد» on a phone; it is still the ديوان.
    expect(tabOf({ view: "poets" })).toBe("home")
    expect(tabOf({ view: "poem", id: "q12" })).toBe("home")
    expect(tabOf({ view: "room", code: "BADIRU" })).toBe("duel")
    expect(tabOf({ view: "train-drill" })).toBe("train")
    expect(tabOf({ view: "privacy" })).toBe("more")
  })
})

describe("the back chevron's fallback", () => {
  it("never falls back to the screen it is standing on", () => {
    for (const route of EVERY_ROUTE.filter((r) => !isTabRoot(r))) {
      expect(parentRoute(route).view).not.toBe(route.view)
    }
  })

  it("returns a route the router can spell", () => {
    for (const route of EVERY_ROUTE) expect(parseHash(routeHash(parentRoute(route)))).toEqual(parentRoute(route))
  })

  it("sends the surfaces whose only phone door is «المزيد» back to it", () => {
    for (const view of ["poets", "favorites", "stats", "daily", "wander", "privacy"] as const) {
      expect(parentRoute({ view } as Route)).toEqual({ view: "more" })
    }
    expect(parentRoute({ view: "poet", slug: "mutanabi" })).toEqual({ view: "poets" })
    expect(parentRoute({ view: "duel-summary" })).toEqual({ view: "duel" })
    expect(parentRoute({ view: "train-arsenal" })).toEqual({ view: "train" })
  })
})

describe("tab scroll memory", () => {
  it("returns a tab root to where it was left, and everything else to its top", () => {
    resetScrollMemory()
    rememberScroll("browse", 1840)
    rememberScroll("poet:mutanabi", 700)
    expect(scrollTargetFor({ view: "browse", query: {} }, "browse", true)).toBe(1840)
    // a sub-screen is a new page even when it has been seen before
    expect(scrollTargetFor({ view: "poet", slug: "mutanabi" }, "poet:mutanabi", true)).toBe(0)
  })

  it("does not exist off the phone — the web's «a new page starts at its top» is unamended", () => {
    resetScrollMemory()
    rememberScroll("browse", 1840)
    expect(scrollTargetFor({ view: "browse", query: {} }, "browse", false)).toBe(0)
  })

  it("is 0 for a tab never visited", () => {
    resetScrollMemory()
    expect(scrollTargetFor({ view: "train" }, "train", true)).toBe(0)
  })

  it("forgets a tab scrolled back to its top rather than remembering a zero", () => {
    resetScrollMemory()
    rememberScroll("home", 900)
    rememberScroll("home", 0)
    expect(scrollTargetFor({ view: "home" }, "home", true)).toBe(0)
  })
})
