import { describe, expect, it } from "vitest"
import { BUHUR, DAWAIR, bahrBySlug, bahrGlyph, buhurOfDaira, dairaBySlug } from "./buhur.ts"
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

/**
 * الدوائر are the structure `#/buhur` is built on: five sections, sixteen
 * cards, and no card anywhere else. The three properties below are what make
 * that page complete — every بحر placed, every دائرة populated, and the
 * partition covering all sixteen exactly once.
 */
describe("دوائر العروض", () => {
  it("holds الخليل's five circles, in his order, each explained in Arabic", () => {
    expect(DAWAIR).toHaveLength(5)
    expect(DAWAIR.map((d) => d.sort)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(DAWAIR.map((d) => d.slug)).size).toBe(5)
    for (const d of DAWAIR) {
      expect(d.name.startsWith("دائرة "), d.slug).toBe(true)
      expect(ARABIC.test(d.why), d.slug).toBe(true)
      // The clause explains the NAME, so it has to end as a sentence does.
      expect(d.why.endsWith("."), d.slug).toBe(true)
    }
  })

  it("partitions the sixteen بحور — every one placed, every circle inhabited", () => {
    const grouped = DAWAIR.flatMap((d) => buhurOfDaira(d.slug))
    expect(grouped).toHaveLength(16)
    expect(new Set(grouped.map((b) => b.slug)).size).toBe(16)
    for (const d of DAWAIR) expect(buhurOfDaira(d.slug).length, d.slug).toBeGreaterThan(0)
  })

  it("keeps the classical membership — the circles are not ours to redraw", () => {
    const names = (slug: Parameters<typeof buhurOfDaira>[0]) => buhurOfDaira(slug).map((b) => b.name)
    expect(names("mukhtalif")).toEqual(["الطويل", "المديد", "البسيط"])
    expect(names("mutalif")).toEqual(["الوافر", "الكامل"])
    expect(names("mujtalab")).toEqual(["الهزج", "الرجز", "الرمل"])
    expect(names("mushtabih")).toEqual(["السريع", "المنسرح", "الخفيف", "المضارع", "المقتضب", "المجتث"])
    expect(names("muttafiq")).toEqual(["المتقارب", "المتدارك"])
  })

  it("says that المتدارك is الأخفش's, not الخليل's", () => {
    // Sixteen cards under «دوائر الخليل» with no note would credit him with a
    // بحر he did not name — the one place this page could teach a falsehood
    // simply by being tidy.
    expect(bahrBySlug("mutadarik")?.note).toContain("الأخفش")
    expect(BUHUR.filter((b) => b.note !== undefined)).toHaveLength(1)
  })

  it("looks a دائرة up by slug", () => {
    expect(dairaBySlug("muttafiq")?.name).toBe("دائرة المتَّفِق")
    expect(dairaBySlug(null)).toBeUndefined()
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
