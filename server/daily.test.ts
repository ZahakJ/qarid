/**
 * بيت اليوم, shareable: the date→بيت pick, the `/d/<date>` head and the
 * `/og/daily/<date>.png` card, on data/fixture.db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Hono } from "hono"

import { FIRST_DAY } from "../shared/daily.ts"
import { DailyResponseSchema } from "../shared/schema.ts"
import { ensureFixtureDb, FIXTURE_DB } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import {
  PAST_CACHE,
  TODAY_CACHE,
  dailyDescription,
  dailyShareRoutes,
  dailyVerse,
  injectDailyHead,
  parseDay,
  type DailyVerse,
} from "./daily.ts"
import { openDb, type Db } from "./db.ts"
import { CARD_H, CARD_W, dailyCardSvg, initCardRenderer, layoutDailyCard } from "./og/dailyCard.ts"
import { riyadhDay } from "./routes/baits.ts"

const SHELL = `<!doctype html><html lang="ar" dir="rtl"><head>
    <meta charset="utf-8" />
    <title>قريض</title>
    <meta name="description" content="ديوان الشعر العربي" />
    <script type="module" src="/assets/index-abc.js"></script>
  </head><body></body></html>`

const ORIGIN = "https://qarid.example.com"
const config = loadConfig({ DB_PATH: FIXTURE_DB, NODE_ENV: "test", PUBLIC_ORIGIN: ORIGIN } as NodeJS.ProcessEnv)

/** `YYYY-MM-DD` shifted by `n` days. */
function shift(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Width and height from a PNG's IHDR chunk. */
function ihdr(buf: Uint8Array): { w: number; h: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { w: v.getUint32(16), h: v.getUint32(20) }
}

describe("parseDay", () => {
  it("takes a real calendar day and nothing else", () => {
    expect(parseDay("2026-10-14")).toBe("2026-10-14")
    expect(parseDay("2024-02-29")).toBe("2024-02-29")
    for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-1-01", "20261014", "today", "", "2026-10-14x"]) {
      expect(parseDay(bad)).toBeNull()
    }
  })
})

describe("injectDailyHead", () => {
  const verse: DailyVerse = {
    date: "2026-10-14",
    sadr: `عَلى قَدرِ أَهلِ "العَزمِ" <b>تَأتي</b>`,
    ajuz: "وَتَأتي عَلى قَدرِ الكِرامِ & المَكارِمُ",
    poet: "أبو الطيب 'المتنبي'",
  }
  const html = injectDailyHead(SHELL, verse, `${ORIGIN}/`)

  it("escapes every interpolated corpus value", () => {
    expect(html).not.toContain("<b>")
    expect(html).toContain("&lt;b&gt;تَأتي&lt;/b&gt;")
    expect(html).toContain("&quot;العَزمِ&quot;")
    expect(html).toContain("&amp; المَكارِمُ")
    expect(html).toContain("&#39;المتنبي&#39;")
  })

  it("carries the بيت and the شاعر as the description, once", () => {
    expect(html.match(/<meta name="description"/g)).toHaveLength(1)
    expect(html.match(/<title>/g)).toHaveLength(1)
    expect(dailyDescription(verse)).toBe(`${verse.sadr} … ${verse.ajuz} — ${verse.poet}`)
  })

  it("points og:image at the absolute card URL, with its size", () => {
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/og/daily/2026-10-14.png" />`)
    expect(html).toContain(`<meta property="og:image:width" content="${CARD_W}" />`)
    expect(html).toContain(`<meta property="og:image:height" content="${CARD_H}" />`)
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/d/2026-10-14" />`)
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />')
    expect(html).toContain("2026")
  })

  it("leaves the rest of the shell alone", () => {
    expect(html).toContain('<script type="module" src="/assets/index-abc.js"></script>')
    expect(html).toContain("<body></body>")
  })
})

describe("the card layout", () => {
  beforeAll(() => initCardRenderer())

  it("escapes the text it puts into SVG", () => {
    const svg = dailyCardSvg({ date: "2026-10-14", sadr: "أ <b> & ب", ajuz: null, poet: 'ج "د"' })
    expect(svg).not.toContain("<b>")
    expect(svg).toContain("&lt;b&gt; &amp; ب")
  })

  it("shrinks — or breaks — a very long hemistich rather than overflowing", () => {
    const long = "وَما زِلتُ أَرجو أَن يَعودَ الزَمانُ الَّذي مَضى بِأَهلِهِ وَأَحبابِهِ وَما كانَ فيهِ مِنَ اللَهوِ وَالطَرَبِ وَالأُنسِ وَالصَفاءِ"
    const short = layoutDailyCard({ date: "2026-10-14", sadr: "قفا نبك من ذكرى حبيب ومنزل", ajuz: "بسقط اللوى بين الدخول فحومل" })
    const tight = layoutDailyCard({ date: "2026-10-14", sadr: long, ajuz: long, poet: "شاعر" })
    expect(short.verseLines).toHaveLength(2)
    expect(tight.verseLines.length).toBeGreaterThan(2)
    expect(tight.verseSize).toBeLessThan(short.verseSize)
    // the whole block stays between the header and the mark
    for (const l of tight.verseLines) {
      expect(l.y).toBeGreaterThan(100)
      expect(l.y).toBeLessThan(CARD_H - 100)
    }
    expect(tight.poetY).toBeLessThan(CARD_H - 100)
  })
})

describe("بيت اليوم by date on data/fixture.db", () => {
  let db: Db
  let api: Hono
  let routes: Hono
  const today = riyadhDay()

  beforeAll(async () => {
    await ensureFixtureDb()
    db = openDb(FIXTURE_DB)
    api = createApp(config, db).app
    routes = dailyShareRoutes(db, config, SHELL)
  })
  afterAll(() => db?.close())

  it("is deterministic for a date and moves across dates", () => {
    const a = dailyVerse(db, "2026-08-23", today)
    const b = dailyVerse(db, "2026-08-23", today)
    expect(a).toEqual(b)
    const seen = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const v = dailyVerse(db, shift("2026-08-23", i), today)
      if (v.ok) seen.add(v.verse.sadr)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it("gives today the same بيت as /api/baits/daily", async () => {
    const api1 = DailyResponseSchema.parse(await (await api.request("/api/baits/daily")).json())
    const mine = dailyVerse(db, "today", api1.date)
    expect(mine.ok && mine.verse.sadr).toBe(api1.bait.sadr.trim())
    expect(mine.ok && mine.verse.date).toBe(api1.date)
    // …and for a past day the API's `?date=` agrees too
    const past = DailyResponseSchema.parse(await (await api.request("/api/baits/daily?date=2026-08-23")).json())
    const v = dailyVerse(db, "2026-08-23", today)
    expect(v.ok && v.verse.sadr).toBe(past.bait.sadr.trim())
  })

  it("refuses a future day and a malformed one", () => {
    expect(dailyVerse(db, shift(today, 1), today)).toEqual({ ok: false, reason: "future" })
    expect(dailyVerse(db, "2026-02-30", today)).toEqual({ ok: false, reason: "malformed" })
  })

  it("has no page before the first day", () => {
    expect(dailyVerse(db, shift(FIRST_DAY, -1), today)).toEqual({ ok: false, reason: "none" })
    expect(dailyVerse(db, FIRST_DAY, today).ok).toBe(true)
  })

  describe("GET /d/<date>", () => {
    it("serves the shell with that day's head", async () => {
      const res = await routes.request("/d/2026-08-23")
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("no-cache")
      const html = await res.text()
      const v = dailyVerse(db, "2026-08-23", today)
      expect(v.ok).toBe(true)
      if (v.ok) expect(html).toContain(v.verse.poet)
      expect(html).toContain(`content="${ORIGIN}/og/daily/2026-08-23.png"`)
      expect(html).toContain("/assets/index-abc.js")
    })

    it("names today for /d and /d/today", async () => {
      for (const url of ["/d", "/d/", "/d/today"]) {
        const html = await (await routes.request(url)).text()
        expect(html).toContain(`content="${ORIGIN}/d/${today}"`)
      }
    })

    it("answers 404 — still the shell — for a future or malformed day", async () => {
      for (const url of [`/d/${shift(today, 1)}`, "/d/2026-13-01", "/d/yesterday"]) {
        const res = await routes.request(url)
        expect(res.status).toBe(404)
        const html = await res.text()
        expect(html).toContain("/assets/index-abc.js")
        expect(html).not.toContain('property="og:title"')
      }
    })
  })

  describe("GET /og/daily/<date>.png", () => {
    it("renders a 1200×630 PNG with a long cache for a past day", async () => {
      const res = await api.request("/og/daily/2026-08-23.png")
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("image/png")
      expect(res.headers.get("cache-control")).toBe(PAST_CACHE)
      const buf = new Uint8Array(await res.arrayBuffer())
      expect([...buf.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(ihdr(buf)).toEqual({ w: CARD_W, h: CARD_H })
    })

    it("caches today's card for a shorter while", async () => {
      const res = await api.request(`/og/daily/${today}.png`)
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe(TODAY_CACHE)
    })

    it("serves the same bytes twice", async () => {
      const a = new Uint8Array(await (await api.request("/og/daily/2026-08-24.png")).arrayBuffer())
      const b = new Uint8Array(await (await api.request("/og/daily/2026-08-24.png")).arrayBuffer())
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    })

    it("404s a future day, a malformed day and a wrong extension", async () => {
      for (const url of [`/og/daily/${shift(today, 1)}.png`, "/og/daily/2026-02-30.png", "/og/daily/2026-08-23.jpg", "/og/daily/x.png"]) {
        expect((await api.request(url)).status).toBe(404)
      }
    })
  })
})
