/**
 * `GET /api/facets` — every value of every facet, zeros included
 * (design-server.md §7, design-ux.md §3).
 *
 * Two things make this route the interesting one.
 *
 * **Zeros are the point.** The browse rail's letter grids DISABLE a حرف at
 * zero rather than hiding it, and the empty state «جرّب إزالة: X (٠ نتيجة)»
 * has to name the chip that emptied the combination. So the response always
 * carries all 12 عصور, all 16+ بحور, all 18 أغراض, both لغة values and both
 * 28-letter grids, whatever the filter says.
 *
 * **Each dimension drops itself.** Counting العصور *with* `era=abbasi`
 * applied would report 11 zeros and one total, which would freeze the rail on
 * the first chip a reader clicked. Every dimension is therefore counted with
 * the OTHER filters applied and its own dropped — the standard faceted-search
 * semantics, and the only reading of §7 under which the rail keeps working.
 * `total` alone reflects the complete filter.
 *
 * Speed: the unfiltered case (the common one — it is what the home screen's
 * أبواب tiles and a fresh #/browse ask for) is served verbatim from
 * `meta.facets_json`, computed once at ingest. A filtered case runs six narrow
 * `GROUP BY`s, five of which ride `poems_filter(era_id, meter_id, theme_id,
 * rhyme, id)` as a covering index.
 */

import { Hono } from "hono"

import { HIJAI_LETTERS } from "../../shared/letters.ts"
import {
  FacetsQuerySchema,
  FacetsResponseSchema,
  type ArabicLetter,
  type FacetsQuery,
  type FacetsResponse,
  type LangType,
  type LetterFacet,
  type SlugFacet,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { poemFilter, slugMaps, type Filter, type FilterKey } from "../query.ts"
import { metaJson } from "./meta.ts"

const LANG_VALUES: readonly LangType[] = ["فصيح", "عامي"]

export function facetsRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()
  let unfiltered: FacetsResponse | null = null

  app.get("/", (c) => {
    const parsed = FacetsQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({ error: "bad_query", issues: parsed.error.issues.map((i) => ({ path: [...i.path], message: i.message })) }, 400)
    }
    const q = parsed.data

    if (!anyFilter(q)) {
      if (unfiltered === null) {
        const fromMeta = FacetsResponseSchema.safeParse(metaJson(db, "facets_json"))
        unfiltered = fromMeta.success ? fromMeta.data : computeFacets(db, q)
      }
      return c.json(unfiltered)
    }

    return c.json(computeFacets(db, q))
  })

  return app
}

function anyFilter(q: FacetsQuery): boolean {
  return (
    q.poet !== undefined ||
    q.era !== undefined ||
    q.meter !== undefined ||
    q.theme !== undefined ||
    q.rhyme !== undefined ||
    q.first !== undefined ||
    q.lang !== undefined ||
    q.minBaits !== undefined ||
    q.maxBaits !== undefined ||
    q.fame !== undefined
  )
}

function computeFacets(db: Db, q: FacetsQuery): FacetsResponse {
  const maps = slugMaps(db)
  const full = poemFilter(db, q)

  const idCounts = (skip: FilterKey, column: "era_id" | "meter_id" | "theme_id") => {
    const filter = poemFilter(db, q, skip)
    const rows = groupBy(db, filter, `p.${column}`)
    return rows
  }

  const eraCounts = idCounts("era", "era_id")
  const meterCounts = idCounts("meter", "meter_id")
  const themeCounts = idCounts("theme", "theme_id")
  const rhymeCounts = groupBy(db, poemFilter(db, q, "rhyme"), "p.rhyme")
  const firstCounts = groupBy(db, poemFilter(db, q, "first"), "p.first_letter")
  const langCounts = groupBy(db, poemFilter(db, q, "lang"), "p.lang_type")

  const slugList = (
    byId: Map<number, { slug: string; name: string; sort: number }>,
    counts: Map<string, number>,
  ): SlugFacet[] =>
    [...byId.entries()].map(([id, info]) => ({
      slug: info.slug,
      name: info.name,
      count: counts.get(String(id)) ?? 0,
    }))

  const letterList = (counts: Map<string, number>): LetterFacet[] =>
    HIJAI_LETTERS.map((letter) => ({ letter: letter as ArabicLetter, count: counts.get(letter) ?? 0 }))

  return {
    total: countPoems(db, full),
    eras: slugList(maps.eraName, eraCounts),
    meters: slugList(maps.meterName, meterCounts),
    themes: slugList(maps.themeName, themeCounts),
    rhymes: letterList(rhymeCounts),
    firstLetters: letterList(firstCounts),
    langTypes: LANG_VALUES.map((value) => ({ value, count: langCounts.get(value) ?? 0 })),
  }
}

function countPoems(db: Db, filter: Filter): number {
  if (filter.impossible) return 0
  const join = filter.needsPoet ? "JOIN poets po ON po.id = p.poet_id" : ""
  const row = db.q(`SELECT COUNT(*) AS n FROM poems p ${join} WHERE ${filter.where}`).get(...filter.params) as {
    n: number
  }
  return Number(row.n)
}

/** `column → count`, NULLs dropped (a facet has no "unset" chip). */
function groupBy(db: Db, filter: Filter, column: string): Map<string, number> {
  const out = new Map<string, number>()
  if (filter.impossible) return out
  const join = filter.needsPoet ? "JOIN poets po ON po.id = p.poet_id" : ""
  const rows = db
    .q(
      `SELECT ${column} AS k, COUNT(*) AS n FROM poems p ${join}
       WHERE ${filter.where} AND ${column} IS NOT NULL GROUP BY 1`,
    )
    .all(...filter.params) as Array<{ k: string | number; n: number }>
  for (const r of rows) out.set(String(r.k), Number(r.n))
  return out
}
