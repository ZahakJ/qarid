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
  it("names the ديوان, its جامع and how many أبيات — in that order", () => {
    const lines = albumShareText({ title: "ما أحفظه", curator: "أبو الطيب", count: 12, url: URL }).split("\n")
    expect(lines[0]).toContain("قريض — ديوان «ما أحفظه»")
    expect(lines[1]).toContain("جَمَعه أبو الطيب")
    expect(lines[2]).toContain(URL)
  })

  it("counts the أبيات the way the app does — العدد والمعدود, never a glued noun", () => {
    const of = (n: number) => albumShareText({ title: "د", curator: "ف", count: n }).split("\n")[1]!
    expect(of(1)).toContain("بيت واحد")
    expect(of(2)).toContain("بيتان")
    expect(of(3)).toContain("3 أبيات")
    expect(of(12)).toContain("12 بيتًا")
  })

  it("says an empty shelf in words rather than gluing a zero to a noun", () => {
    const line = albumShareText({ title: "د", curator: "ف", count: 0 }).split("\n")[1]!
    expect(line).toContain("لم يُنسخ فيه بيتٌ بعد")
    expect(line).not.toMatch(/\b0\b/)
  })

  it("opens EVERY line with an RLM — the link line above all", () => {
    const text = albumShareText({ title: "ما أحفظه", curator: "أبو الطيب", count: 12, url: URL })
    for (const line of text.split("\n")) expect(line.startsWith(RLM)).toBe(true)
  })

  it("drops the link line when there is none to give", () => {
    const text = albumShareText({ title: "د", curator: "ف", count: 4 })
    expect(text.split("\n")).toHaveLength(2)
    expect(text).not.toContain("http")
  })

  it("uses WESTERN digits, like every other number in the app", () => {
    expect(albumShareText({ title: "د", curator: "ف", count: 12 })).not.toMatch(/[٠-٩]/)
  })
})
