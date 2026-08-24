/**
 * The eighteen `poem theme` values, and the two of them that are not themes.
 * «قصيدة قصيره» and «قصيدة عامه» together hold 46,522 poems — more than every
 * real غرض in the corpus combined — so leaving them in the filter chips would
 * bury غزل and رثاء under two labels that tell a reader nothing.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  FILTERABLE_THEMES,
  THEMES,
  normalizeLangType,
  normalizeLocation,
  normalizeTheme,
  themeBySlug,
} from "./themes.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = path.join(HERE, "..", "data", "profile.json")

/** Every distinct non-null `poem theme` in arbml/ashaar, verbatim. */
const RAW_THEME_VALUES: readonly string[] = [
  "قصيدة قصيره", "قصيدة عامه", "قصيدة مدح", "قصيدة رومنسيه", "قصيدة حزينه",
  "قصيدة عتاب", "قصيدة هجاء", "قصيدة غزل", "قصيدة دينية", "قصيدة رثاء",
  "قصيدة شوق", "قصيدة فراق", "قصيدة ذم", "قصيدة وطنيه", "قصيدة الاناشيد",
  "قصيدة سياسية", "قصيدة المعلقات", "قصيدة اعتذار",
]

describe("the themes table", () => {
  it("is exactly the eighteen values the corpus holds", () => {
    expect(THEMES).toHaveLength(18)
    expect([...THEMES.map((t) => t.name)].sort()).toEqual([...RAW_THEME_VALUES].sort())
  })

  it("has unique slugs, names, displays and sort keys", () => {
    for (const key of ["slug", "name", "display", "sort"] as const) {
      expect(new Set(THEMES.map((t) => t[key])).size, key).toBe(18)
    }
  })

  it("displays the raw value minus its «قصيدة » prefix", () => {
    for (const t of THEMES) expect(t.display, t.slug).toBe(t.name.replace(/^قصيدة /, ""))
  })

  it("marks قصيره and عامه as buckets and hides them from the chips", () => {
    expect(THEMES.filter((t) => t.kind === "bucket").map((t) => t.slug)).toEqual(["qasira", "amma"])
    expect(FILTERABLE_THEMES).toHaveLength(16)
    expect(FILTERABLE_THEMES.every((t) => t.kind === "theme")).toBe(true)
    // Still reachable by URL — amendment 11 says browsable, just not offered.
    expect(themeBySlug("qasira")).not.toBeNull()
  })

  it("sorts the buckets last", () => {
    const maxTheme = Math.max(...FILTERABLE_THEMES.map((t) => t.sort))
    for (const b of THEMES.filter((t) => t.kind === "bucket")) {
      expect(b.sort).toBeGreaterThan(maxTheme)
    }
  })

  it("cross-checks the copied list against data/profile.json when it is there", () => {
    if (!fs.existsSync(PROFILE)) return
    const profile = JSON.parse(fs.readFileSync(PROFILE, "utf8")) as {
      themes: { values: { value: string | null }[] }
    }
    const live = profile.themes.values.map((v) => v.value).filter((v): v is string => v !== null)
    expect([...live].sort()).toEqual([...RAW_THEME_VALUES].sort())
  })
})

describe("normalizeTheme", () => {
  it("resolves every raw value", () => {
    for (const raw of RAW_THEME_VALUES) expect(normalizeTheme(raw), raw).not.toBeNull()
    expect(new Set(RAW_THEME_VALUES.map((r) => normalizeTheme(r)!.slug)).size).toBe(18)
  })

  it("is spelling-insensitive", () => {
    expect(normalizeTheme("قصيدة دينيه")!.slug).toBe("diniya")
    expect(normalizeTheme("  قصيدة   غزل ")!.slug).toBe("ghazal")
  })

  it("answers null for the 187,110 untagged poems and for junk", () => {
    for (const raw of [null, undefined, "", "قصيدة لا شيء"]) {
      expect(normalizeTheme(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe("normalizeLangType", () => {
  it("collapses five spellings onto two ideas", () => {
    expect(normalizeLangType("فصيح")).toBe("فصيح")
    expect(normalizeLangType("فصحى")).toBe("فصيح")
    expect(normalizeLangType("عامي")).toBe("عامي")
    expect(normalizeLangType("شعبي")).toBe("عامي")
  })

  it("drops the 32 rows that hold a bare dash, and the nulls", () => {
    for (const raw of ["-", "", null, undefined]) {
      expect(normalizeLangType(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe("normalizeLocation", () => {
  it("merges the two spellings of Syria onto one display form", () => {
    expect(normalizeLocation("سوريا")).toBe("سورية")
    expect(normalizeLocation("سورية")).toBe("سورية")
  })

  it("passes every other country through as written", () => {
    expect(normalizeLocation("مصر")).toBe("مصر")
    expect(normalizeLocation("  العراق  ")).toBe("العراق")
  })

  it("answers null for the 190,602 rows with no location", () => {
    for (const raw of [null, undefined, "", "  ", "-"]) {
      expect(normalizeLocation(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})
