import { describe, expect, it } from "vitest"
import { BUHUR, bahrBySlug, bahrGlyph } from "./buhur.ts"
import { FLAVOR, FLAVOR_TITLE } from "./flavor.ts"
import { SCOPE_LABEL, SHORTCUTS } from "./shortcuts.ts"

const ARABIC = /[؀-ۿ]/

describe("البحور", () => {
  it("holds exactly the sixteen بحور with unique slugs and sorts", () => {
    expect(BUHUR).toHaveLength(16)
    expect(new Set(BUHUR.map((b) => b.slug)).size).toBe(16)
    expect(new Set(BUHUR.map((b) => b.name)).size).toBe(16)
    expect([...BUHUR].map((b) => b.sort).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
  })

  it("carries the canonical slugs from design-server.md §3", () => {
    const expected = [
      "tawil", "madid", "basit", "wafir", "kamil", "hazaj", "rajaz", "ramal",
      "sari", "munsarih", "khafif", "mudari", "muqtadab", "mujtath", "mutaqarib", "mutadarik",
    ]
    expect([...BUHUR].sort((a, b) => a.sort - b.sort).map((b) => b.slug)).toEqual(expected)
  })

  it("gives every بحر تفعيلات, a مفتاح and an Arabic name", () => {
    for (const b of BUHUR) {
      expect(b.tafilat.length).toBeGreaterThanOrEqual(2)
      expect(b.tafilat.every((t) => ARABIC.test(t))).toBe(true)
      expect(ARABIC.test(b.miftah)).toBe(true)
      expect(ARABIC.test(b.miftahTafilat)).toBe(true)
      expect(b.name.startsWith("ال")).toBe(true)
    }
  })

  it("looks a بحر up by slug and yields its glyph", () => {
    expect(bahrBySlug("tawil")?.name).toBe("الطويل")
    expect(bahrBySlug("nope")).toBeUndefined()
    expect(bahrBySlug(null)).toBeUndefined()
    expect(bahrGlyph("kamil")).toBe("متفاعلن")
    expect(bahrGlyph(undefined)).toBe("")
  })
})

describe("flavor abyat", () => {
  it("gives every empty state a real بيت and a title", () => {
    for (const [key, b] of Object.entries(FLAVOR)) {
      expect(ARABIC.test(b.sadr), key).toBe(true)
      expect(ARABIC.test(b.ajuz), key).toBe(true)
      expect(ARABIC.test(FLAVOR_TITLE[key as keyof typeof FLAVOR_TITLE])).toBe(true)
    }
  })

  it("attributes the two أبيات whose poets are certain", () => {
    expect(FLAVOR["search-none"].poet).toBe("أحمد شوقي")
    expect(FLAVOR.defeat.poet).toBe("المتنبي")
  })
})

describe("shortcuts", () => {
  it("labels every shortcut in Arabic and scopes it to a known area", () => {
    for (const s of SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0)
      expect(ARABIC.test(s.label), s.label).toBe(true)
      expect(SCOPE_LABEL[s.scope]).toBeTruthy()
    }
  })

  // amendments.md §15: under RTL ← is FORWARD and → is BACK. The browse list
  // appends rather than paginating, so forward is «المزيد من النتائج» and back
  // is «العودة إلى أول النتائج» — the direction is the contract, the wording
  // has to describe what the key actually does (BrowseView's useKeyboard).
  it("uses ← for forward and → for back, RTL-correct", () => {
    const next = SHORTCUTS.find((s) => s.keys[0] === "←")
    const prev = SHORTCUTS.find((s) => s.keys[0] === "→")
    expect(next?.label).toContain("المزيد")
    expect(prev?.label).toContain("أول النتائج")
    expect(next?.scope).toBe("browse")
    expect(prev?.scope).toBe("browse")
  })
})
