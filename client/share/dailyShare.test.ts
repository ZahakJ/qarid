/**
 * بيت اليوم's share link and block, and the route a shared `/d/<date>` lands on.
 */
import { describe, expect, it } from "vitest"

import { RLM } from "../../shared/format.ts"
import { pageKey, parseHash, routeHash, sharePathToHash } from "../router.ts"
import { dailyShareText, dailyShareUrl } from "./dailyShare.ts"

describe("dailyShareUrl", () => {
  it("is a /d/<date> path on the share origin", () => {
    expect(dailyShareUrl("https://qarid.example.com/", "2026-10-14")).toBe("https://qarid.example.com/d/2026-10-14")
  })
})

describe("dailyShareText", () => {
  const url = "https://qarid.example.com/d/2026-10-14"
  const text = dailyShareText({
    date: "2026-10-14",
    sadr: " على قدر أهل العزم تأتي العزائم ",
    ajuz: "وتأتي على قدر الكرام المكارم",
    poet: "أبو الطيب المتنبي",
    url,
  })
  const lines = text.split("\n")

  it("names the day, the بيت on one line, the شاعر, then the link", () => {
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain("بيت اليوم")
    expect(lines[0]).toContain("2026")
    expect(lines[1]).toBe(`${RLM}على قدر أهل العزم تأتي العزائم … وتأتي على قدر الكرام المكارم`)
    expect(lines[2]).toBe(`${RLM}— أبو الطيب المتنبي`)
    expect(lines[3]).toBe(`${RLM}${url}`)
  })

  it("opens every line with U+200F and uses Western digits only", () => {
    for (const l of lines) expect(l.startsWith(RLM)).toBe(true)
    expect(text).not.toMatch(/[٠-٩۰-۹]/)
  })

  it("drops the شاعر line when there is no name", () => {
    expect(dailyShareText({ date: "2026-10-14", sadr: "صدر", ajuz: null, poet: " ", url }).split("\n")).toHaveLength(3)
  })
})

describe("the #/day route", () => {
  it("round-trips with and without a date", () => {
    for (const r of [{ view: "day" as const }, { view: "day" as const, date: "2026-10-14" }]) {
      expect(parseHash(routeHash(r))).toEqual(r)
    }
  })

  it("drops a date that is not YYYY-MM-DD", () => {
    expect(parseHash("#/day/yesterday")).toEqual({ view: "day" })
  })

  it("gives each day its own page", () => {
    expect(pageKey({ view: "day", date: "2026-10-14" })).not.toBe(pageKey({ view: "day", date: "2026-10-13" }))
  })

  it("folds a shared /d link into it", () => {
    expect(sharePathToHash("/d/2026-10-14", "")).toBe("/#/day/2026-10-14")
    expect(sharePathToHash("/d/2026-10-14/", "")).toBe("/#/day/2026-10-14")
    for (const p of ["/d", "/d/", "/d/today"]) expect(sharePathToHash(p, "")).toBe("/#/day")
    for (const p of ["/d/x", "/d/2026-10-14/x", "/dx"]) expect(sharePathToHash(p, "")).toBeNull()
  })
})
