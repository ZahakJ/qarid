/**
 * بيت اليوم, shareable — one address per day and a card a crawler can fetch.
 *
 *   GET /d                       → today's page (same as /d/today)
 *   GET /d/<YYYY-MM-DD>          the SPA shell with that day's og:/twitter: tags
 *   GET /og/daily/<YYYY-MM-DD>.png   the 1200×630 card (server/og/dailyCard.ts)
 *
 * The page exists for the reason `/p/<id>` does (server/share.ts): the app is
 * hash-routed, a fragment never reaches a server, and an unfurl needs tags
 * the server can only write for a path it sees. The client folds `/d/<date>`
 * back into `#/day/<date>` at boot (client/router.ts).
 *
 * A date is any calendar day up to today on the Riyadh calendar — the day
 * بيت اليوم turns over on. A future day has no بيت yet and answers 404, so a
 * link cannot leak tomorrow's.
 */

import fs from "node:fs"
import path from "node:path"

import { Hono, type Context } from "hono"

import { arabicDay } from "../shared/format.ts"
import { FIRST_DAY } from "../shared/daily.ts"
import type { Config } from "./config.ts"
import type { Db } from "./db.ts"
import { baitDto } from "./dto.ts"
import { CARD_H, CARD_W, initCardRenderer, renderDailyCard } from "./og/dailyCard.ts"
import { dailyRow, riyadhDay } from "./routes/baits.ts"
import { escapeHtml } from "./share.ts"

export type DailyVerse = {
  date: string
  sadr: string
  ajuz: string | null
  poet: string
}

/** `YYYY-MM-DD` naming a real calendar day (no 2026-02-30), else null. */
export function parseDay(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const d = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return null
  return raw
}

export type DayLookup =
  | { ok: true; verse: DailyVerse }
  | { ok: false; reason: "malformed" | "future" | "none" }

/** The بيت of one day, or why there is none. `today` is injectable for tests. */
export function dailyVerse(db: Db, raw: string, today: string = riyadhDay()): DayLookup {
  const date = raw === "today" ? today : parseDay(raw)
  if (date === null) return { ok: false, reason: "malformed" }
  if (date > today) return { ok: false, reason: "future" }
  if (date < FIRST_DAY) return { ok: false, reason: "none" }
  const row = dailyRow(db, date)
  if (row === undefined) return { ok: false, reason: "none" }
  const b = baitDto(row)
  return { ok: true, verse: { date, sadr: b.sadr.trim(), ajuz: b.ajuz?.trim() || null, poet: b.poet.name.trim() } }
}

/** «بيت اليوم · 14 تشرين الأول 2026 — قريض» */
export function dailyTitle(date: string): string {
  return `بيت اليوم · ${arabicDay(date)} ${date.slice(0, 4)} — قريض`
}

/** «صدر … عجز — الشاعر», bare: a meta value is one phrase in someone else's UI. */
export function dailyDescription(v: DailyVerse): string {
  const line = v.ajuz ? `${v.sadr} … ${v.ajuz}` : v.sadr
  return v.poet ? `${line} — ${v.poet}` : line
}

/**
 * Put one day's identity into the shell — `injectPoemHead`'s rule: the
 * shell's own `<title>` and description are REPLACED, never doubled.
 */
export function injectDailyHead(html: string, v: DailyVerse, origin: string): string {
  const base = origin.replace(/\/+$/, "")
  const title = dailyTitle(v.date)
  const desc = dailyDescription(v)
  const image = `${base}/og/daily/${v.date}.png`
  const tags: Array<[string, string]> = [
    ["og:type", "article"],
    ["og:site_name", "قريض"],
    ["og:title", title],
    ["og:description", desc],
    ["og:url", `${base}/d/${v.date}`],
    ["og:locale", "ar_AR"],
    ["og:image", image],
    ["og:image:type", "image/png"],
    ["og:image:width", String(CARD_W)],
    ["og:image:height", String(CARD_H)],
    ["og:image:alt", desc],
  ]
  const lines = tags.map(([p, v]) => `<meta property="${escapeHtml(p)}" content="${escapeHtml(v)}" />`)
  lines.push(`<meta name="twitter:card" content="summary_large_image" />`)
  lines.push(`<meta name="twitter:image" content="${escapeHtml(image)}" />`)
  lines.push(`<meta name="description" content="${escapeHtml(desc)}" />`)

  let out = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
  out = out.replace(/\s*<meta\s+name="description"[^>]*>/i, "")
  return out.replace(/<\/head>/i, `    ${lines.join("\n    ")}\n  </head>`)
}

/** A small LRU of rendered cards — a card is ~120 KB and a day's never changes. */
class PngCache {
  private map = new Map<string, Uint8Array>()
  private readonly max: number
  constructor(max: number) {
    this.max = max
  }
  get(k: string): Uint8Array | undefined {
    const v = this.map.get(k)
    if (v !== undefined) {
      this.map.delete(k)
      this.map.set(k, v)
    }
    return v
  }
  set(k: string, v: Uint8Array): void {
    this.map.delete(k)
    this.map.set(k, v)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }
}

const PNG_CACHE_MAX = 64
/** A past day's card is final for this artefact; today's is re-checked hourly. */
export const PAST_CACHE = "public, max-age=2592000"
export const TODAY_CACHE = "public, max-age=3600"

/**
 * `shell` is the built index.html, or null when dist/ is absent (the share
 * page then has nothing to serve; the card still works). Read from dist/ by
 * default; tests hand one in.
 */
export function dailyShareRoutes(
  db: Db | null,
  config: Config,
  shell: string | null = readShell(),
  today: () => string = () => riyadhDay(),
): Hono {
  const app = new Hono()
  const cache = new PngCache(PNG_CACHE_MAX)

  const page = (c: Context, raw: string) => {
    if (shell === null) return c.notFound()
    c.header("Cache-Control", "no-cache")
    if (db === null) return c.html(shell)
    const found = dailyVerse(db, raw, today())
    // The shell still serves on a bad date — the app opens and says so — but
    // with a 404 status, so nothing indexes or unfurls it.
    if (!found.ok) return c.html(shell, 404)
    return c.html(injectDailyHead(shell, found.verse, config.publicOrigin))
  }

  app.get("/d", (c) => page(c, "today"))
  app.get("/d/", (c) => page(c, "today"))
  app.get("/d/:date", (c) => page(c, c.req.param("date")))

  app.get("/og/daily/:file", async (c) => {
    const m = /^(.+)\.png$/.exec(c.req.param("file"))
    if (db === null) return c.json({ error: "corpus_unavailable" }, 503)
    const now = today()
    const found = m ? dailyVerse(db, m[1]!, now) : ({ ok: false, reason: "malformed" } as const)
    if (!found.ok) return c.json({ error: found.reason === "none" ? "no_bait" : "not_found" }, 404)
    const v = found.verse
    const key = `${v.date}\u0000${v.sadr}\u0000${v.ajuz ?? ""}\u0000${v.poet}`
    let png = cache.get(key)
    if (png === undefined) {
      await initCardRenderer()
      png = renderDailyCard(v)
      cache.set(key, png)
    }
    c.header("Content-Type", "image/png")
    c.header("Cache-Control", v.date === now ? TODAY_CACHE : PAST_CACHE)
    return c.body(png as Uint8Array<ArrayBuffer>)
  })

  return app
}

function readShell(): string | null {
  const p = path.join(import.meta.dirname, "..", "dist", "index.html")
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null
}
