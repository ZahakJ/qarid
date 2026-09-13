/**
 * The ديوان's share block. It LEAVES the app, which is the whole reason it is
 * tested: every defect this file guards against shipped once in the duel's own
 * block first — a معدود glued to a digit («12 بيت»), a zero read as a noun
 * («سلسلة من لا أبيات»), and a line starting with a neutral character that a
 * Latin-first chat app then flipped end to end.
 */
import { describe, expect, it } from "vitest"

import { RLM } from "../../shared/format.ts"
import { albumShareText } from "./share.ts"

const URL = "https://qarid.example.com/#/diwan/BADIRUKAMO"

describe("albumShareText", () => {
  it("names the ديوان, its جامع and what it holds — in that order", () => {
    const lines = albumShareText({ title: "ما أحفظه", curator: "أبو الطيب", poems: 7, baits: 12, url: URL }).split("\n")
    expect(lines[0]).toContain("قريض — ديوان «ما أحفظه»")
    expect(lines[1]).toContain("جَمَعه أبو الطيب · 7 قصائد و12 بيتًا")
    expect(lines[2]).toContain(URL)
  })

  it("counts each kind the way the app does — العدد والمعدود, never a glued noun", () => {
    const of = (poems: number, baits: number) =>
      albumShareText({ title: "د", curator: "ف", poems, baits }).split("\n")[1]!
    expect(of(0, 1)).toContain("بيت واحد")
    expect(of(0, 2)).toContain("بيتان")
    expect(of(0, 3)).toContain("3 أبيات")
    expect(of(0, 12)).toContain("12 بيتًا")
    expect(of(1, 0)).toContain("قصيدة واحدة")
    expect(of(2, 0)).toContain("قصيدتان")
    expect(of(11, 0)).toContain("11 قصيدة")
    expect(of(2, 1)).toContain("قصيدتان وبيت واحد")
  })

  it("says an empty shelf in words rather than gluing a zero to a noun", () => {
    const line = albumShareText({ title: "د", curator: "ف", poems: 0, baits: 0 }).split("\n")[1]!
    expect(line).toContain("لم يُوضع فيه شيءٌ بعد")
    expect(line).not.toMatch(/\b0\b/)
  })

  it("opens EVERY line with an RLM — the link line above all", () => {
    const text = albumShareText({ title: "ما أحفظه", curator: "أبو الطيب", poems: 7, baits: 12, url: URL })
    for (const line of text.split("\n")) expect(line.startsWith(RLM)).toBe(true)
  })

  it("drops the link line when there is none to give", () => {
    const text = albumShareText({ title: "د", curator: "ف", poems: 0, baits: 4 })
    expect(text.split("\n")).toHaveLength(2)
    expect(text).not.toContain("http")
  })

  it("uses WESTERN digits, like every other number in the app", () => {
    expect(albumShareText({ title: "د", curator: "ف", poems: 12, baits: 12 })).not.toMatch(/[٠-٩]/)
  })
})
