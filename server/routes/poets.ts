/**
 * `/api/poets` — the شعراء index and one شاعر's page (design-server.md §7).
 *
 *   GET /api/poets              letter / era / q / fame, sorted, paginated
 *   GET /api/poets/:slug        poet + signature بيت + first page + facet chips
 *   GET /api/poets/:slug/poems  that poet's ديوان, filtered and sorted
 *
 * `:slug` is NOT ascii: 91,936 rows carry no `poet url`, so the fallback slug
 * is an Arabic hyphenation of the name (CLAUDE.md spike finding 2) and every
 * link to it arrives percent-encoded. `decodeParam` is the only door.
 */

import { Hono } from "hono"

import { normalizeArabic } from "../../shared/arabic.ts"
import { hijaiIndex } from "../../shared/letters.ts"
import {
  PoetPoemsQuerySchema,
  PoetsQuerySchema,
  type ArabicLetter,
  type BaitDto,
  type PoetPageResponse,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import {
  BAIT_COLS,
  BAIT_CONTEXT_COLS,
  BAIT_JOINS,
  POET_COLS,
  POET_JOINS,
  baitDto,
  poetDetail,
  poetSummary,
  type Row,
} from "../dto.ts"
import { decodeParam, listBody, listPoems, notFound, parseQuery, poemFilter, slugMaps } from "../query.ts"

export function poetsRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()

  // ── GET /api/poets ───────────────────────────────────────────────────────
  app.get("/", (c) => {
    const parsed = parseQuery(c, PoetsQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data

    const where: string[] = []
    const params: Array<string | number> = []
    let impossible = false

    if (q.letter !== undefined) {
      where.push("po.letter = ?")
      params.push(q.letter)
    }
    if (q.era !== undefined) {
      const id = slugMaps(db).era.get(q.era)
      if (id === undefined) impossible = true
      else {
        where.push("po.era_id = ?")
        params.push(id)
      }
    }
    if (q.fame !== undefined) {
      where.push("po.fame >= ?")
      params.push(q.fame)
    }
    if (q.q !== undefined) {
      // Substring on the normalised name — the index/query form both sides of
      // the product agree on. Real ranked search is /api/search's job; this is
      // the poets-index filter box, which only ever needs "contains".
      const needle = normalizeArabic(q.q)
      if (needle === "") impossible = true
      else {
        where.push("po.name_key LIKE ? ESCAPE '\\'")
        params.push(`%${likeEscape(needle)}%`)
      }
    }

    if (impossible) return c.json(listBody([], 0, q.page, q.limit))

    const cond = where.length === 0 ? "1 = 1" : where.join(" AND ")
    const total = Number(
      (db.q(`SELECT COUNT(*) AS n FROM poets po WHERE ${cond}`).get(...params) as { n: number }).n,
    )
    const rows = db
      .q(
        `SELECT ${POET_COLS} FROM poets po ${POET_JOINS} WHERE ${cond}
         ORDER BY ${poetsOrder(q.sort)} LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, (q.page - 1) * q.limit) as Row[]

    return c.json(listBody(rows.map(poetSummary), total, q.page, q.limit))
  })

  // ── GET /api/poets/:slug ─────────────────────────────────────────────────
  app.get("/:slug", (c) => {
    const slug = decodeParam(c.req.param("slug"))
    const row = db.q(`SELECT ${POET_COLS} FROM poets po ${POET_JOINS} WHERE po.slug = ?`).get(slug) as Row | undefined
    if (row === undefined) return notFound(c, "poet")
    const poetId = Number(row.po_id)

    const filter = poemFilter(db, { poet: slug })
    const first = listPoems(db, filter, "fame", undefined, 1, 20)

    const body: PoetPageResponse = {
      poet: poetDetail(row),
      signatureBait: signatureBait(db, poetId),
      poems: first.items,
      poemsTotal: first.total,
      ...poetBreakdown(db, poetId),
    }
    return c.json(body)
  })

  // ── GET /api/poets/:slug/poems ───────────────────────────────────────────
  app.get("/:slug/poems", (c) => {
    const slug = decodeParam(c.req.param("slug"))
    const parsed = parseQuery(c, PoetPoemsQuerySchema)
    if (!parsed.ok) return parsed.res
    const q = parsed.data

    const exists = db.q("SELECT 1 AS ok FROM poets WHERE slug = ?").get(slug) as { ok: number } | undefined
    if (exists === undefined) return notFound(c, "poet")

    const filter = poemFilter(db, { poet: slug, meter: q.meter, theme: q.theme, rhyme: q.rhyme })
    const { items, total } = listPoems(db, filter, q.sort, q.seed, q.page, q.limit)
    return c.json(listBody(items, total, q.page, q.limit))
  })

  return app
}

function poetsOrder(sort: "name" | "poems" | "baits"): string {
  switch (sort) {
    case "poems":
      return "po.poem_count DESC, po.fame DESC, po.id ASC"
    case "baits":
      return "po.bait_count DESC, po.fame DESC, po.id ASC"
    case "name":
    default:
      // `sort_key` is `sortName()` — المتنبي files under الميم, which is where
      // a reader looks for him. `poets_letter(letter, sort_key)` covers it.
      return "po.sort_key ASC, po.id ASC"
  }
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * The بيت on the poet's header plate. Deterministic, and never a fragment: the
 * longest قصيدة with a known بحر, then its مطلع, preferring a complete بيت.
 * Two indexed lookups — `poems_poet` then `baits_poem_pos` — so a شاعر with
 * 5,000 قصائد costs the same as one with two.
 */
function signatureBait(db: Db, poetId: number): BaitDto | null {
  const poem = db
    .q(
      `SELECT id FROM poems WHERE poet_id = ?
       ORDER BY (meter_id IS NOT NULL) DESC, bait_count DESC, id ASC LIMIT 1`,
    )
    .get(poetId) as { id: number } | undefined
  if (poem === undefined) return null

  const sql = (extra: string) =>
    `SELECT ${BAIT_COLS}, ${BAIT_CONTEXT_COLS} FROM baits b ${BAIT_JOINS}
     WHERE b.poem_id = ? ${extra} ORDER BY b.position ASC LIMIT 1`
  const row =
    (db.q(sql("AND b.is_partial = 0 AND b.ajuz IS NOT NULL")).get(poem.id) as Row | undefined) ??
    (db.q(sql("")).get(poem.id) as Row | undefined)
  return row === undefined ? null : baitDto(row)
}

/**
 * The poet-page toolbar chips: which قوافي, بحور and أغراض this شاعر actually
 * used, with counts. Three `GROUP BY`s over `poems_poet` — no per-poem query,
 * no `baits` read.
 */
function poetBreakdown(db: Db, poetId: number): Pick<PoetPageResponse, "rhymes" | "meters" | "themes"> {
  const maps = slugMaps(db)

  const rhymeRows = db
    .q("SELECT rhyme AS k, COUNT(*) AS n FROM poems WHERE poet_id = ? AND rhyme IS NOT NULL GROUP BY 1")
    .all(poetId) as Array<{ k: string; n: number }>
  const rhymes = rhymeRows
    .filter((r) => hijaiIndex(String(r.k)) >= 0)
    .map((r) => ({ letter: String(r.k) as ArabicLetter, count: Number(r.n) }))
    .sort((a, b) => hijaiIndex(a.letter) - hijaiIndex(b.letter))

  const group = (column: "meter_id" | "theme_id", byId: Map<number, { slug: string; name: string; sort: number }>) => {
    const rows = db
      .q(`SELECT ${column} AS k, COUNT(*) AS n FROM poems WHERE poet_id = ? AND ${column} IS NOT NULL GROUP BY 1`)
      .all(poetId) as Array<{ k: number; n: number }>
    return rows
      .map((r) => ({ info: byId.get(Number(r.k)), count: Number(r.n) }))
      .filter((r): r is { info: { slug: string; name: string; sort: number }; count: number } => r.info !== undefined)
      .sort((a, b) => a.info.sort - b.info.sort)
      .map((r) => ({ slug: r.info.slug, name: r.info.name, count: r.count }))
  }

  return { rhymes, meters: group("meter_id", maps.meterName), themes: group("theme_id", maps.themeName) }
}

