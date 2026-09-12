/**
 * The قصيدة's share block. It LEAVES the app, which is the whole reason it is
 * tested: every defect guarded here shipped once in the duel's own block first
 * — a معدود glued to a digit, a zero read as a noun, and a line starting on a
 * neutral character that a Latin-first chat app then flipped end to end.
 */
import { describe, expect, it } from "vitest"

import { RLM } from "../../shared/format.ts"
import { poemShareText, poemShareUrl } from "./share.ts"

const URL = "https://qarid.example.com/p/16182"

const base = { heading: "على قدر أهل العزم", isMatla: false, poet: "أبو الطيب المتنبي", count: 41 }

describe("poemShareText", () => {
  it("names the قصيدة, its شاعر and its length — in that order", () => {
    const lines = poemShareText({ ...base, url: URL }).split("\n")
    expect(lines[0]).toContain("قصيدة «على قدر أهل العزم»")
    expect(lines[1]).toContain("أبو الطيب المتنبي")
    expect(lines[1]).toContain("41 بيتًا")
    expect(lines[2]).toContain(URL)
  })

  it("says «مطلعها» when the heading is a مطلع and not a عنوان", () => {
    // «قصيدة «first hemistich»» announces a عنوان the قصيدة has not got, which
    // is the one thing the مطلع is there to stand in for.
    const titled = poemShareText({ ...base, isMatla: false }).split("\n")[0]!
    const untitled = poemShareText({ ...base, isMatla: true }).split("\n")[0]!
    expect(titled).toContain("قصيدة «")
    expect(titled).not.toContain("مطلعها")
    expect(untitled).toContain("قصيدة مطلعها «")
  })

  it("drops the ellipsis headingOf hangs on a مطلع", () => {
    const line = poemShareText({ ...base, heading: "قفا نبكِ من ذكرى حبيبٍ ومنزلِ …", isMatla: true }).split("\n")[0]!
    expect(line).toContain("«قفا نبكِ من ذكرى حبيبٍ ومنزلِ»")
    expect(line).not.toContain("…")
  })

  it("counts the أبيات the way the app does — العدد والمعدود, never a glued noun", () => {
    const of = (n: number) => poemShareText({ ...base, count: n }).split("\n")[1]!
    expect(of(1)).toContain("بيت واحد")
    expect(of(2)).toContain("بيتان")
    expect(of(3)).toContain("3 أبيات")
    expect(of(12)).toContain("12 بيتًا")
    expect(of(41)).toContain("41 بيتًا")
  })

  it("names the شاعر bare, because a لام needs a case these names are not stored in", () => {
    // «لأبو الطيب» is what a لام glued to a nominative gets you; the Arabic is
    // «لأبي الطيب». الأسماء الخمسة decline in the letters, and this corpus is
    // full of them, so the block attributes without a preposition at all.
    const line = poemShareText({ ...base, poet: "أبو الطيب المتنبي" }).split("\n")[1]!
    expect(line).toContain("أبو الطيب المتنبي")
    expect(line).not.toContain("لأبو")
    expect(line.startsWith(`${RLM}أبو`)).toBe(true)
  })

  it("never says «لا أبيات» — a zero drops the segment instead of becoming a noun", () => {
    const line = poemShareText({ ...base, count: 0, url: URL }).split("\n")[1]!
    expect(line).not.toContain("لا أبيات")
    expect(line).not.toMatch(/\b0\b/)
    expect(line).toContain("أبو الطيب المتنبي")
  })

  it("opens EVERY line with an RLM — the link line above all", () => {
    const text = poemShareText({ ...base, url: URL })
    for (const line of text.split("\n")) expect(line.startsWith(RLM)).toBe(true)
  })

  it("drops the link line when there is none to give", () => {
    const text = poemShareText(base)
    expect(text.split("\n")).toHaveLength(2)
    expect(text).not.toContain("http")
  })

  it("still says something when the قصيدة has neither heading nor شاعر", () => {
    const text = poemShareText({ heading: "", isMatla: false, poet: "", count: 0, url: URL })
    expect(text.split("\n")[0]).toContain("قريض — قصيدة")
    expect(text).toContain(URL)
    expect(text).not.toContain("«»")
  })

  it("uses WESTERN digits, like every other number in the app", () => {
    expect(poemShareText({ ...base, url: URL })).not.toMatch(/[٠-٩]/)
  })
})

describe("poemShareUrl", () => {
  it("is a PATH, not the app's own hash route", () => {
    // A fragment never reaches a server, so `#/poem/16182` could never carry
    // this قصيدة's preview tags — every one of the 238,733 unfurled alike.
    const url = poemShareUrl("https://qarid.example.com", "16182")
    expect(url).toBe("https://qarid.example.com/p/16182")
    expect(url).not.toContain("#")
  })

  it("takes the origin from the caller — `location` is a lie inside the APK", () => {
    // The WebView serves from https://localhost, so a link built on
    // `location.origin` there leaves the phone dead.
    expect(poemShareUrl("https://example.test", "1")).toBe("https://example.test/p/1")
    expect(poemShareUrl("https://qarid.example.com", "1")).toBe("https://qarid.example.com/p/1")
  })

  it("does not double the slash when the origin carries one", () => {
    expect(poemShareUrl("https://qarid.example.com/", "16182")).toBe("https://qarid.example.com/p/16182")
  })

  it("encodes an id that would otherwise change the path", () => {
    expect(poemShareUrl("https://q.test", "a/b")).toBe("https://q.test/p/a%2Fb")
  })
})
