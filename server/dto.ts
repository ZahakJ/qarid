/**
 * `server/dto.ts` — the ONE row→DTO layer (design-server.md §7).
 *
 * Every read route selects its columns through the fragments below and shapes
 * them here, so a column rename in `scripts/ingest/ddl.ts` breaks in exactly
 * one file and every response is the shape `shared/schema.ts` promises.
 *
 * Three rules this file exists to keep:
 *  • `PoemSummary` is served from `poems JOIN poets` and NEVER touches `baits`
 *    — the denormalised `preview_sadr`/`preview_ajuz` are what make an untitled
 *    قصيدة renderable as its مطلع in a list row.
 *  • `baytKey` comes from `shared/arabic.ts`, not from a template literal here;
 *    favourites and drill cards are keyed by it and a second spelling is a bug.
 *  • Letters on the wire are one of the 28 (`shared/letters.ts`). The ingest
 *    already folded them; `letterOrNull` is the guard that proves it, so a
 *    corrupt artefact fails the zod parse on the client rather than silently
 *    shipping a ة.
 */

import { baytKey } from "../shared/arabic.ts"
import { isHijaiLetter } from "../shared/letters.ts"
import type {
  ArabicLetter,
  BaitDto,
  EraRef,
  LangType,
  MeterRef,
  PoemDetail,
  PoemRef,
  PoemSummary,
  PoetDetail,
  PoetRef,
  PoetSummary,
  ThemeRef,
} from "../shared/schema.ts"

/** A `node:sqlite` result row. Values are string | number | bigint | null. */
export type Row = Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// SQL fragments — the only place column names are spelled
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two columns a `PoetRef` needs. Every DTO that names a شاعر — a
 * `PoemSummary` row, a `BaitDto`, a `PoetSummary` — reads exactly these
 * aliases, which is why they are spelled once and composed into the wider
 * column lists below instead of being repeated in three of them.
 */
export const POET_REF_COLS = `po.slug AS po_slug, po.name AS po_name`

/**
 * Everything in a `PoetSummary`/`PoetDetail` EXCEPT the ref. Select it next to
 * `POEM_COLS` (which already carries the ref) when one row has to yield both a
 * poem and its full شاعر — `SELECT ${POEM_COLS}, ${POET_COLS}` would emit
 * `po_slug` twice and SQLite would silently keep one of them.
 */
export const POET_EXTRA_COLS = `
  po.id AS po_id, po.letter AS po_letter,
  po.location AS po_location, po.description AS po_description, po.fame AS po_fame,
  po.poem_count AS po_poem_count, po.bait_count AS po_bait_count, po.source_url AS po_source_url,
  pe.slug AS pe_slug, pe.name AS pe_name`

/** `poets po` + its era. Requires `LEFT JOIN eras pe ON pe.id = po.era_id`. */
export const POET_COLS = `${POET_REF_COLS}, ${POET_EXTRA_COLS}`

/** `poems p` + meter/theme/era. Requires `POEM_JOINS`. */
export const POEM_COLS = `
  p.id AS p_id, p.public_id AS p_public_id, p.title AS p_title, p.bait_count AS p_bait_count,
  p.rhyme AS p_rhyme, p.rhyme_share AS p_rhyme_share, p.first_letter AS p_first_letter,
  p.lang_type AS p_lang_type, p.has_tashkeel AS p_has_tashkeel, p.meter_variant AS p_meter_variant,
  p.preview_sadr AS p_preview_sadr, p.preview_ajuz AS p_preview_ajuz, p.url AS p_url,
  ${POET_REF_COLS},
  m.slug AS m_slug, m.name AS m_name,
  t.slug AS t_slug, t.name AS t_name, t.display AS t_display,
  e.slug AS e_slug, e.name AS e_name`

export const BAIT_COLS = `
  b.id AS b_id, b.position AS b_position, b.sadr AS b_sadr, b.ajuz AS b_ajuz,
  b.rawiyy AS b_rawiyy, b.last_letter AS b_last_letter, b.first_letter AS b_first_letter,
  b.is_partial AS b_is_partial`

/** Everything a `PoemSummary` (and a `BaitDto`'s poem/poet refs) needs. */
export const POEM_JOINS = `
  JOIN poets po ON po.id = p.poet_id
  LEFT JOIN eras pe ON pe.id = po.era_id
  LEFT JOIN meters m ON m.id = p.meter_id
  LEFT JOIN themes t ON t.id = p.theme_id
  LEFT JOIN eras e ON e.id = p.era_id`

export const POET_JOINS = `LEFT JOIN eras pe ON pe.id = po.era_id`

// ─────────────────────────────────────────────────────────────────────────────
// Column readers
// ─────────────────────────────────────────────────────────────────────────────

export function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v)
}

export function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v)
  return s === "" ? null : s
}

export function num(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "bigint") return Number(v)
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  return num(v)
}

export function bool(v: unknown): boolean {
  return num(v) !== 0
}

/** One of the 28, or null. The guard against a mis-built artefact. */
export function letterOrNull(v: unknown): ArabicLetter | null {
  if (v === null || v === undefined) return null
  const s = String(v)
  return isHijaiLetter(s) ? (s as ArabicLetter) : null
}

/** `poems.lang_type` collapses to exactly two values at ingest (§6). */
export function langOrNull(v: unknown): LangType | null {
  const s = strOrNull(v)
  return s === "فصيح" || s === "عامي" ? s : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Refs
// ─────────────────────────────────────────────────────────────────────────────

export function meterRef(row: Row): MeterRef | null {
  const slug = strOrNull(row.m_slug)
  if (slug === null) return null
  return { slug, name: str(row.m_name), variant: strOrNull(row.p_meter_variant) }
}

export function themeRef(row: Row): ThemeRef | null {
  const slug = strOrNull(row.t_slug)
  if (slug === null) return null
  return { slug, name: str(row.t_name), display: str(row.t_display) }
}

/** The poem's own era (backfilled from the poet at ingest). */
export function eraRef(row: Row): EraRef | null {
  const slug = strOrNull(row.e_slug)
  if (slug === null) return null
  return { slug, name: str(row.e_name) }
}

/** The poet's era — a different column, and the one a PoetSummary carries. */
export function poetEraRef(row: Row): EraRef | null {
  const slug = strOrNull(row.pe_slug)
  if (slug === null) return null
  return { slug, name: str(row.pe_name) }
}

export function poetRef(row: Row): PoetRef {
  return { slug: str(row.po_slug), name: str(row.po_name) }
}

/**
 * Both of a poem's names (see `PoemRefSchema`): the public id every route and
 * hash link speaks, and the internal `poems.id` the duel excludes on. Every
 * caller therefore has to have selected `p.id AS p_id` — `POEM_COLS` and
 * `BAIT_CONTEXT_COLS` both do.
 */
export function poemRef(row: Row): PoemRef {
  return { id: str(row.p_public_id), poemId: num(row.p_id), title: str(row.p_title) }
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

export function poetSummary(row: Row): PoetSummary {
  return {
    slug: str(row.po_slug),
    name: str(row.po_name),
    letter: (letterOrNull(row.po_letter) ?? "ا") as ArabicLetter,
    era: poetEraRef(row),
    location: strOrNull(row.po_location),
    description: strOrNull(row.po_description),
    fame: num(row.po_fame),
    poemCount: num(row.po_poem_count),
    baitCount: num(row.po_bait_count),
  }
}

export function poetDetail(row: Row): PoetDetail {
  return { ...poetSummary(row), sourceUrl: strOrNull(row.po_source_url) }
}

export function poemSummary(row: Row): PoemSummary {
  return {
    id: str(row.p_public_id),
    title: str(row.p_title),
    poet: poetRef(row),
    meter: meterRef(row),
    theme: themeRef(row),
    era: eraRef(row),
    langType: langOrNull(row.p_lang_type),
    rhyme: letterOrNull(row.p_rhyme),
    /**
     * amendment-adjacent: the share of أبيات whose روي is `rhyme`. Below 0.6
     * the قصيدة does not really have one قافية and the client hides the chip.
     */
    rhymeShare: numOrNull(row.p_rhyme_share),
    firstLetter: letterOrNull(row.p_first_letter),
    baitCount: num(row.p_bait_count),
    hasTashkeel: bool(row.p_has_tashkeel),
    previewSadr: strOrNull(row.p_preview_sadr),
    previewAjuz: strOrNull(row.p_preview_ajuz),
  }
}

export function poemDetail(row: Row): PoemDetail {
  return { ...poemSummary(row), url: strOrNull(row.p_url), poetFame: num(row.po_fame) }
}

/**
 * A بيت with the poem/poet/meter/era context the client needs to render it
 * anywhere — the duel transcript, a favourite, a search hit, a drill card.
 * `baytKey` is `<publicPoemId>:<position>`, stable across a rebuild that
 * renumbers `baits.id`.
 */
export function baitDto(row: Row): BaitDto {
  return {
    id: num(row.b_id),
    baytKey: baytKey(str(row.p_public_id), num(row.b_position)),
    position: num(row.b_position),
    sadr: str(row.b_sadr),
    ajuz: strOrNull(row.b_ajuz),
    rawiyy: letterOrNull(row.b_rawiyy),
    lastLetter: letterOrNull(row.b_last_letter),
    firstLetter: letterOrNull(row.b_first_letter),
    isPartial: bool(row.b_is_partial),
    poem: poemRef(row),
    poet: poetRef(row),
    meter: meterRef(row),
    era: eraRef(row),
  }
}

/**
 * The lean context a `BaitDto` needs — poem ref, poet ref, بحر and عصر, and
 * nothing else. `/api/poems/:id/baits` returns 300 of these at a time, so it
 * does not select the poem's previews and title_key 300 times over.
 */
export const BAIT_CONTEXT_COLS = `
  p.id AS p_id, p.public_id AS p_public_id, p.title AS p_title, p.meter_variant AS p_meter_variant,
  po.slug AS po_slug, po.name AS po_name,
  m.slug AS m_slug, m.name AS m_name,
  e.slug AS e_slug, e.name AS e_name`

/** Joins for `BAIT_CONTEXT_COLS`, starting from `baits b`. */
export const BAIT_JOINS = `
  JOIN poems p ON p.id = b.poem_id
  JOIN poets po ON po.id = p.poet_id
  LEFT JOIN meters m ON m.id = p.meter_id
  LEFT JOIN eras e ON e.id = p.era_id`
