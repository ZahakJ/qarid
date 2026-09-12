/**
 * The head a SHARED قصيدة link is served with.
 *
 * Two things are load-bearing here and neither is cosmetic: the values are
 * SCRAPED corpus text going into a double-quoted attribute, and the shell must
 * end up with exactly one `<title>` and one description — a document with two
 * of either lets each scraper pick a different one.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import type { Hono } from "hono"

import { ensureFixtureDb, FIXTURE_DB, REPO_ROOT } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { openDb, type Db } from "./db.ts"
import { escapeHtml, injectPoemHead, poemDescription, poemMetaTags, poemTitle, type PoemMeta } from "./share.ts"

const meta: PoemMeta = {
  heading: "سبيل الجَماهير",
  isMatla: false,
  poet: "محمد مهدي الجواهري",
  count: 38,
  matla: "لو أن مقاليد الجماهير في يدي",
  url: "https://qarid.example.com/p/16182",
  image: "https://qarid.example.com/icons/icon-512.png",
}

describe("escapeHtml", () => {
  it("escapes everything that can break out of a quoted attribute", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
  })

  it("escapes the ampersand FIRST, or the other escapes get double-escaped", () => {
    expect(escapeHtml("<")).toBe("&lt;")
    expect(escapeHtml("&lt;")).toBe("&amp;lt;")
  })

  it("leaves Arabic alone", () => {
    expect(escapeHtml("قصيدة «سبيل الجَماهير»")).toBe("قصيدة «سبيل الجَماهير»")
  })
})

describe("poemTitle", () => {
  it("names the قصيدة, then the app", () => {
    expect(poemTitle(meta)).toBe("سبيل الجَماهير — قريض")
  })

  it("falls back to the app alone when there is no name at all", () => {
    expect(poemTitle({ heading: "   " })).toBe("قريض")
  })
})

describe("poemDescription", () => {
  it("leads with the شاعر and the length — what decides whether to open a link", () => {
    expect(poemDescription(meta)).toContain("محمد مهدي الجواهري · 38 بيتًا")
  })

  it("adds the مطلع as a taste when the headline is a real عنوان", () => {
    expect(poemDescription(meta)).toContain("لو أن مقاليد الجماهير في يدي")
  })

  it("does NOT repeat the مطلع when it is already the headline", () => {
    const d = poemDescription({ ...meta, isMatla: true })
    expect(d).not.toContain("لو أن مقاليد")
    expect(d).toBe("محمد مهدي الجواهري · 38 بيتًا")
  })

  it("counts through shared/format.ts and never glues a noun to a digit", () => {
    expect(poemDescription({ ...meta, count: 1 })).toContain("بيت واحد")
    expect(poemDescription({ ...meta, count: 2 })).toContain("بيتان")
    expect(poemDescription({ ...meta, count: 38 })).toContain("38 بيتًا")
  })

  it("drops the count at zero rather than saying «لا أبيات» after a name", () => {
    const d = poemDescription({ ...meta, count: 0 })
    expect(d).not.toContain("لا أبيات")
    expect(d).toContain("محمد مهدي الجواهري")
  })

  it("still says something when the row carries neither شاعر nor مطلع", () => {
    expect(poemDescription({ heading: "", isMatla: true, poet: "", count: 0, matla: null })).toBe(
      "ديوان الشعر العربي ومساجلته",
    )
  })

  it("does not print the مطلع twice when the title IS the مطلع unvowelled", () => {
    // Not hypothetical: a great many aldiwan titles are the first hemistich
    // with the تشكيل stripped, so the two fields differ only by marks the
    // normalizer exists to erase.
    const d = poemDescription({
      ...meta,
      heading: "سقتني حميا الحب راحة مقلتي",
      matla: "سَقَتني حُمَيَّا الحُبَّ راحَةَ مُقلَتي",
      poet: "ابن الفارض",
      count: 760,
    })
    expect(d).toBe("ابن الفارض · 760 بيتًا")
  })

  it("still prints a مطلع that genuinely differs from the title", () => {
    expect(poemDescription(meta)).toContain("لو أن مقاليد الجماهير في يدي")
  })

  it("drops a مطلع the title merely cuts short", () => {
    const d = poemDescription({ ...meta, heading: "لو أن مقاليد", matla: "لو أن مقاليد الجماهير في يدي" })
    expect(d).not.toContain("الجماهير في يدي")
  })

  it("uses WESTERN digits, like every other number in the app", () => {
    expect(poemDescription(meta)).not.toMatch(/[٠-٩]/)
  })
})

describe("poemMetaTags", () => {
  it("emits the tags a chat app actually reads", () => {
    const tags = poemMetaTags(meta)
    expect(tags).toContain('property="og:title"')
    expect(tags).toContain('property="og:description"')
    expect(tags).toContain(`content="${meta.url}"`)
    expect(tags).toContain('property="og:image"')
    expect(tags).toContain('name="twitter:card" content="summary_large_image"')
  })

  it("falls back to the small card when there is no image to show", () => {
    const tags = poemMetaTags({ ...meta, image: null })
    expect(tags).toContain('name="twitter:card" content="summary"')
    expect(tags).not.toContain("og:image")
  })

  it("escapes a قصيدة whose text would otherwise close the attribute", () => {
    // The corpus is scraped HTML; a stray quote or bracket in a عنوان is a
    // tag-injection, not a typo to shrug at.
    const tags = poemMetaTags({ ...meta, heading: `x" onload="alert(1)` })
    expect(tags).not.toContain('onload="alert(1)"')
    expect(tags).toContain("&quot;")
  })
})

describe("injectPoemHead", () => {
  const shell = `<!doctype html><html><head><meta charset="utf-8" /><title>قريض</title>
    <meta name="description" content="ديوان الشعر العربي ومساجلته" /></head><body></body></html>`

  it("replaces the shell's title rather than adding a second one", () => {
    const out = injectPoemHead(shell, meta)
    expect(out.match(/<title>/g)).toHaveLength(1)
    expect(out).toContain("<title>سبيل الجَماهير — قريض</title>")
  })

  it("leaves exactly one description behind", () => {
    const out = injectPoemHead(shell, meta)
    expect(out.match(/name="description"/g)).toHaveLength(1)
    expect(out).toContain("محمد مهدي الجواهري")
  })

  it("puts the tags inside the head", () => {
    const out = injectPoemHead(shell, meta)
    const head = out.slice(0, out.indexOf("</head>"))
    expect(head).toContain('property="og:title"')
    expect(out.indexOf("og:title")).toBeLessThan(out.indexOf("</head>"))
  })

  it("leaves the body untouched", () => {
    expect(injectPoemHead(shell, meta)).toContain("<body></body>")
  })
})

// ═══════════════════════════════════════════════════════════════════════════

const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.html")
const built = fs.existsSync(DIST_INDEX)

describe.skipIf(!built)("GET /p/:publicId on data/fixture.db", () => {
  let db: Db
  let api: Hono
  let poemId: string
  let poemTitleText: string

  beforeAll(async () => {
    await ensureFixtureDb()
    db = openDb(FIXTURE_DB)
    api = createApp(loadConfig({ DB_PATH: FIXTURE_DB, NODE_ENV: "test" } as NodeJS.ProcessEnv), db).app
    const first = (await (await api.request("/api/poems?limit=1")).json()) as {
      items: { id: string; title: string }[]
    }
    poemId = first.items[0]!.id
    poemTitleText = first.items[0]!.title
  })
  afterAll(() => db?.close())

  it("serves the shell with THAT قصيدة's head", async () => {
    const res = await api.request(`/p/${poemId}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('property="og:title"')
    expect(html).toContain(`content="https://qarid.example.com/p/${poemId}"`)
    // …and it is the SHELL, so the app still boots under the share path.
    expect(html).toContain("/assets/")
  })

  it("names the قصيدة the way its own page does", async () => {
    const html = await (await api.request(`/p/${poemId}`)).text()
    if (poemTitleText && poemTitleText !== "بلا عنوان") expect(html).toContain(poemTitleText)
  })

  it("still serves a working shell for an unknown id — a shared link must not 404", async () => {
    const res = await api.request("/p/999999999")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("/assets/")
    expect(html).not.toContain('property="og:title"')
  })

  it("refuses to interpolate a malformed id, and still serves the shell", async () => {
    const res = await api.request("/p/%3Cscript%3E")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain('property="og:title"')
  })

  it("is no-cache, like the shell it is a copy of", async () => {
    const res = await api.request(`/p/${poemId}`)
    expect(res.headers.get("cache-control")).toContain("no-cache")
  })
})
