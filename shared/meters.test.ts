/**
 * `normalizeMeter` must be EXHAUSTIVE over the corpus. design-server.md §6 has
 * `build.ts` assert zero unmapped metres at the end of ingest; if that assert
 * can fire, it fires 30 minutes into a run, which is the worst possible moment
 * to learn about a two-character spelling variant. So the whole vocabulary is
 * checked here, in 40 milliseconds, against a list checked into the repo.
 *
 * RAW_METER_VALUES is the 101 distinct non-null `poem meter` strings measured
 * by `scripts/ingest/profile.ts`. `data/` is gitignored, so the list is copied
 * in rather than read from `data/profile.json` — and then cross-checked against
 * that file whenever it happens to be present, so the copy cannot rot.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  BUHUR,
  METERS,
  METERS_BY_SLUG,
  UNKNOWN_BY_DESIGN,
  isGameEligibleMeter,
  normalizeMeter,
} from "./meters.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = path.join(HERE, "..", "data", "profile.json")

/** Every distinct non-null `poem meter` in arbml/ashaar, verbatim. */
export const RAW_METER_VALUES: readonly string[] = [
  "الطويل",
  "الكامل",
  "بحر الطويل",
  "البسيط",
  "بحر الكامل",
  "بحر البسيط",
  "الوافر",
  "الخفيف",
  "بحر الوافر",
  "بحر الخفيف",
  "الرجز",
  "السريع",
  "بحر السريع",
  "الرمل",
  "المتقارب",
  "عموديه",
  "بحر المتقارب",
  "بحر مجزوء الكامل",
  "بحر الرجز",
  "بحر المنسرح",
  "المنسرح",
  "التفعيله",
  "المجتث",
  "بحر الرمل",
  "بحر مجزوء الرمل",
  "الموشح",
  "بحر المجتث",
  "الدوبيت",
  "بحر مجزوء الرجز",
  "بحر مخلع البسيط",
  "نثريه",
  "بحر موشح",
  "بحر أحذ الكامل",
  "الهزج",
  "المديد",
  "بحر مجزوء الخفيف",
  "بحر الهزج",
  "بحر مجزوء الوافر",
  "بحر المديد",
  "عامي",
  "بحر المواليا",
  "المواليا",
  "بحر مجزوء البسيط",
  "المتدارك",
  "شعر التفعيلة",
  "شعر حر",
  "بحر الدوبيت",
  "المسحوب",
  "بحر المتدارك",
  "المضارع",
  "بحر مجزوء المتقارب",
  "المقتضب",
  "بحر مشطور الرجز",
  "بحر مجزوء موشح",
  "بحر منهوك المنسرح",
  "بحر المقتضب",
  "السلسلة",
  "بحر مجزوء الدوبيت",
  "بحر مجزوء السريع",
  "بحر مجزوء الطويل",
  "بحر التفعيله",
  "بحر المضارع",
  "بحر مجزوء المتدارك",
  "بحر منهوك الرجز",
  "بحر السلسلة",
  "بحر مربع الرجز",
  "بحر مخلع الرمل",
  "بحر مخلع الكامل",
  "الهجيني",
  "بحر مجزوء المديد",
  "الكان كان",
  "بحر الكامل المقطوع",
  "بحر تفعيلة الكامل",
  "بحر مجزوء المجتث",
  "بحر مجزوء الهزج",
  "بحر مخلع موشح",
  "الحداء",
  "الصخري",
  "اللويحاني",
  "بحر أحذ المديد",
  "بحر أحذ الوافر",
  "بحر الخبب",
  "بحر القوما",
  "بحر المتدارك المنهوك",
  "بحر تفعيلة الرجز",
  "بحر تفعيلة الرمل",
  "بحر تفعيلة المتقارب",
  "بحر مجزوء الرمل ",
  "بحر مجزوء المنسرح",
  "بحر مجزوء المواليا",
  "بحر مخلع الرجز",
  "بحر مخلع السريع",
  "بحر مربع البسيط",
  "بحر مشطور السريع",
  "بحر مشطور الطويل",
  "بحر منهوك البسيط",
  "بحر منهوك الكامل",
  "بسيط",
  "زجل",
  "عدة أبحر",
  "مجزوء الخفيف",
]

describe("the meters table", () => {
  it("carries the canonical sixteen buhur", () => {
    expect(BUHUR).toHaveLength(16)
    expect(BUHUR.every((m) => m.kind === "bahr")).toBe(true)
    expect(BUHUR.map((m) => m.slug)).toEqual([
      "tawil", "madid", "basit", "wafir", "kamil", "hazaj", "rajaz", "ramal",
      "sari", "munsarih", "khafif", "mudari", "muqtadab", "mujtath",
      "mutaqarib", "mutadarik",
    ])
  })

  it("gives every bahr its تفعيلات and its مفتاح", () => {
    for (const m of BUHUR) {
      expect(m.tafila, m.slug).toBeTruthy()
      expect(m.miftah, m.slug).toBeTruthy()
      // The مفتاح is a بيت that scans as its own metre — it has both halves.
      expect(m.miftah!, m.slug).toContain("·")
    }
  })

  it("has unique slugs, unique names and a total order", () => {
    expect(new Set(METERS.map((m) => m.slug)).size).toBe(METERS.length)
    expect(new Set(METERS.map((m) => m.name)).size).toBe(METERS.length)
    expect(new Set(METERS.map((m) => m.sort)).size).toBe(METERS.length)
    expect(METERS.map((m) => m.sort)).toEqual([...METERS].sort((a, b) => a.sort - b.sort).map((m) => m.sort))
  })

  it("only lets the sixteen buhur into the game pool", () => {
    for (const m of METERS) expect(isGameEligibleMeter(m.slug), m.slug).toBe(m.kind === "bahr")
    expect(isGameEligibleMeter(null)).toBe(false)
    expect(isGameEligibleMeter("nope")).toBe(false)
  })
})

describe("normalizeMeter over the whole corpus vocabulary", () => {
  it("has all 101 raw values", () => {
    expect(RAW_METER_VALUES).toHaveLength(101)
    expect(new Set(RAW_METER_VALUES).size).toBe(101)
  })

  it("resolves every one of them to a row we actually seed", () => {
    const unresolved: string[] = []
    for (const raw of RAW_METER_VALUES) {
      const out = normalizeMeter(raw)
      if (out.meterSlug === null) {
        unresolved.push(raw)
        continue
      }
      expect(METERS_BY_SLUG.has(out.meterSlug), `${raw} -> ${out.meterSlug}`).toBe(true)
      expect(METERS_BY_SLUG.get(out.meterSlug)!.kind, raw).toBe(out.kind)
    }
    // «عامي» is the only raw value that names no metre at all.
    expect(unresolved).toEqual(["عامي"])
  })

  it("leaves nothing on kind:'unknown' except the three documented values", () => {
    const unknown = RAW_METER_VALUES.filter((raw) => normalizeMeter(raw).kind === "unknown")
    expect(unknown.sort()).toEqual([...UNKNOWN_BY_DESIGN].sort())
  })

  it("splits the 101 the way design-server.md \u00a73 says it should", () => {
    const byKind = new Map<string, number>()
    for (const raw of RAW_METER_VALUES) {
      const k = normalizeMeter(raw).kind
      byKind.set(k, (byKind.get(k) ?? 0) + 1)
    }
    expect(Object.fromEntries(byKind)).toEqual({
      bahr: 73, folk: 16, free: 4, muwashah: 4, unknown: 3, prose: 1,
    })
  })

  it("cross-checks the copied list against data/profile.json when it is there", () => {
    if (!fs.existsSync(PROFILE)) return
    const profile = JSON.parse(fs.readFileSync(PROFILE, "utf8")) as {
      meters: { values: { value: string | null }[] }
    }
    const live = profile.meters.values.map((v) => v.value).filter((v): v is string => v !== null)
    expect([...live].sort()).toEqual([...RAW_METER_VALUES].sort())
  })
})

describe("normalizeMeter, case by case", () => {
  it("drops the «بحر » prefix that 65 of the values carry", () => {
    expect(normalizeMeter("بحر الطويل").meterSlug).toBe("tawil")
    expect(normalizeMeter("الطويل").meterSlug).toBe("tawil")
  })

  it("adds the missing ال — the corpus writes «بسيط» exactly once", () => {
    expect(normalizeMeter("بسيط").meterSlug).toBe("basit")
  })

  it("survives the one value with a trailing space", () => {
    expect(normalizeMeter("بحر مجزوء الرمل ")).toEqual({
      meterSlug: "ramal", variant: "مجزوء", kind: "bahr", langHint: null,
    })
  })

  it("peels a leading modifier into variant", () => {
    expect(normalizeMeter("بحر مجزوء الكامل")).toMatchObject({ meterSlug: "kamil", variant: "مجزوء" })
    expect(normalizeMeter("بحر أحذ الكامل")).toMatchObject({ meterSlug: "kamil", variant: "أحذ" })
    expect(normalizeMeter("بحر منهوك المنسرح")).toMatchObject({ meterSlug: "munsarih", variant: "منهوك" })
    expect(normalizeMeter("مجزوء الخفيف")).toMatchObject({ meterSlug: "khafif", variant: "مجزوء" })
  })

  it("peels a TRAILING modifier too, ال and all", () => {
    expect(normalizeMeter("بحر الكامل المقطوع")).toMatchObject({ meterSlug: "kamil", variant: "مقطوع" })
    expect(normalizeMeter("بحر المتدارك المنهوك")).toMatchObject({ meterSlug: "mutadarik", variant: "منهوك" })
  })

  it("does not mistake «شعر التفعيلة» for a modifier hanging off «شعر»", () => {
    // The trailing token IS one of the modifiers; resolving the whole string
    // first is the only reason this lands on free verse instead of nowhere.
    expect(normalizeMeter("شعر التفعيلة")).toMatchObject({ meterSlug: "taf3ila", kind: "free" })
    expect(normalizeMeter("شعر حر")).toMatchObject({ meterSlug: "taf3ila", kind: "free" })
    expect(normalizeMeter("التفعيله")).toMatchObject({ meterSlug: "taf3ila", kind: "free" })
    expect(normalizeMeter("بحر التفعيله")).toMatchObject({ meterSlug: "taf3ila", kind: "free" })
  })

  it("still treats «تفعيلة» as a modifier when a bahr follows it", () => {
    expect(normalizeMeter("بحر تفعيلة الكامل")).toMatchObject({ meterSlug: "kamil", variant: "تفعيلة", kind: "bahr" })
  })

  it("files الخبب as a variant of المتدارك, not as its own bahr", () => {
    expect(normalizeMeter("بحر الخبب")).toEqual({
      meterSlug: "mutadarik", variant: "خبب", kind: "bahr", langHint: null,
    })
  })

  it("keeps a peeled modifier on a موشح", () => {
    expect(normalizeMeter("بحر موشح")).toMatchObject({ meterSlug: "muwashah", variant: null })
    expect(normalizeMeter("بحر مجزوء موشح")).toMatchObject({ meterSlug: "muwashah", variant: "مجزوء" })
    expect(normalizeMeter("بحر مخلع موشح")).toMatchObject({ meterSlug: "muwashah", variant: "مخلع" })
  })

  it("carries «عامي» out as a language hint, not as a metre", () => {
    expect(normalizeMeter("عامي")).toEqual({
      meterSlug: null, variant: null, kind: "unknown", langHint: "عامي",
    })
  })

  it("answers unknown for null, empty and the 32 rows that hold a bare dash", () => {
    for (const raw of [null, undefined, "", "   ", "-", "—", "؟", "12"]) {
      expect(normalizeMeter(raw), JSON.stringify(raw)).toEqual({
        meterSlug: null, variant: null, kind: "unknown", langHint: null,
      })
    }
  })

  it("is idempotent through its own canonical name", () => {
    for (const m of METERS) {
      const once = normalizeMeter(m.name)
      if (once.meterSlug === null) continue
      expect(once.meterSlug, m.name).toBe(m.slug)
    }
  })
})
