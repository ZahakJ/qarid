/**
 * `/api/anthologies` — the route, and the canon it resolves.
 *
 * Two halves, and both are needed.
 *
 * The first drives the app over the FIXTURE artefact, which holds almost none
 * of the curated canon. That is the point: it is the only place the "not in the
 * ديوان" path is exercised at all, and the invariant it proves is that an
 * unresolved entry is still an ITEM — same length, same order, `poem`/`bait`
 * null, the anthology's own شاعر and مطلع still on it. A route that dropped
 * them would look perfect here and lie on the real corpus.
 *
 * The second runs the WHOLE canon — 10 معلقات and 100 أبيات — against
 * `data/qarid.db` when that file exists, and asserts that every entry resolves
 * to a بيت by the شاعر the anthology names, opening on the words it names. That
 * is the check that would have caught «سئمت تكاليف الحياة» resolving to أبو
 * نصر النحاس. It is skipped in a fresh checkout, the way
 * `shared/rawiyy.corpus.test.ts` skips without its sample.
 */

import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Hono } from "hono"

import { normalizeArabic } from "../../shared/arabic.ts"
import { ANTHOLOGIES, anthologyBySlug, entryAnchor } from "../../shared/anthologies.ts"
import { canonicalNameKey } from "../../shared/poetAliases.ts"
import { AnthologiesResponseSchema, AnthologyResponseSchema } from "../../shared/schema.ts"
import { ensureFixtureDb, FIXTURE_DB, REPO_ROOT } from "../../test/fixtureDb.ts"
import { createApp } from "../app.ts"
import { loadConfig } from "../config.ts"
import { openDb, type Db } from "../db.ts"
import { resolveAnthology, shelfOf, warmAnthologies } from "./anthology.ts"

const config = loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test" } as NodeJS.ProcessEnv)

describe("/api/anthologies over the fixture", () => {
  let db: Db
  let app: Hono

  beforeAll(async () => {
    await ensureFixtureDb()
    db = openDb(FIXTURE_DB)
    app = createApp(config, db).app
  })

  afterAll(() => db.close())

  it("lists both shelves, with what the corpus answered and what was asked", async () => {
    const res = await app.request("/api/anthologies")
    expect(res.status).toBe(200)
    const body = AnthologiesResponseSchema.parse(await res.json())
    expect(body.shelves.map((s) => s.slug)).toEqual(["muallaqat", "sair"])
    const [muallaqat, sair] = body.shelves
    expect(muallaqat!.total).toBe(10)
    expect(sair!.total).toBe(100)
    expect(muallaqat!.kind).toBe("poems")
    expect(sair!.kind).toBe("baits")
    // `resolved` is what the shelf strip prints; it can never exceed `total`.
    for (const s of body.shelves) expect(s.resolved).toBeLessThanOrEqual(s.total)
  })

  it("puts real spines on every shelf card, resolved or not", () => {
    // The home tile and the index card BOTH print `preview[0]`, so an empty
    // string there is a blank line on the first screen of the app. It falls
    // back to the curated مطلع, which is why the fixture — which resolves
    // almost nothing — still fills it.
    for (const shelf of ANTHOLOGIES) {
      const { preview } = shelfOf(db, shelf)
      expect(preview.length).toBeGreaterThan(0)
      expect(preview.length).toBeLessThanOrEqual(3)
      for (const line of preview) expect(line.trim().length).toBeGreaterThan(0)
    }
  })

  it("returns EVERY curated entry, in order, resolved or not", async () => {
    for (const shelf of ANTHOLOGIES) {
      const res = await app.request(`/api/anthologies/${shelf.slug}`)
      expect(res.status).toBe(200)
      const body = AnthologyResponseSchema.parse(await res.json())
      expect(body.items).toHaveLength(shelf.entries.length)
      body.items.forEach((item, i) => {
        const entry = shelf.entries[i]!
        expect(item.index).toBe(i)
        expect(item.poet).toBe(entry.poet)
        expect(item.matla).toBe(entry.matla)
        expect(item.name).toBe(entry.name ?? null)
      })
    }
  })

  it("keeps a shelf to its own kind — a معلقة is a قصيدة and a بيت سائر is a بيت", async () => {
    const odes = AnthologyResponseSchema.parse(await (await app.request("/api/anthologies/muallaqat")).json())
    for (const item of odes.items) expect(item.bait).toBeNull()
    const sair = AnthologyResponseSchema.parse(await (await app.request("/api/anthologies/sair")).json())
    for (const item of sair.items) expect(item.poem).toBeNull()
  })

  it("prints the anthology's own مطلع on an entry the fixture cannot answer", async () => {
    const body = AnthologyResponseSchema.parse(await (await app.request("/api/anthologies/muallaqat")).json())
    const missing = body.items.filter((i) => i.poem === null)
    // The fixture is 2,000 sampled records; it does not hold ten معلقات.
    expect(missing.length).toBeGreaterThan(0)
    for (const item of missing) {
      expect(item.matla.length).toBeGreaterThan(0)
      expect(item.poet.length).toBeGreaterThan(0)
    }
  })

  it("answers an unknown shelf with 404, not 400 — it arrives from a deep link", async () => {
    const res = await app.request("/api/anthologies/mualaqat")
    expect(res.status).toBe(404)
  })

  it("is memoised on the DB handle — a second resolution is the same array of items", () => {
    const shelf = anthologyBySlug("muallaqat")!
    const first = resolveAnthology(db, shelf)
    const second = resolveAnthology(db, shelf)
    first.forEach((item, i) => expect(second[i]).toBe(item))
  })

  it("pre-warms every entry of every shelf, yielding to the loop between them", async () => {
    // A cold handle, so the sweep has real work to do — the memo keys on the
    // handle exactly like the facet memo does.
    const cold = openDb(FIXTURE_DB)
    try {
      const total = ANTHOLOGIES.reduce((n, a) => n + a.entries.length, 0)
      let finished = false
      const sweep = warmAnthologies(cold).then((n) => {
        finished = true
        return n
      })
      // Scheduled now, this must get its turn while the sweep is still running.
      // Without the `await setImmediate` before each entry the whole sweep would
      // be one blocking turn and the probe would only run after it.
      const ranDuringTheSweep = await new Promise<boolean>((resolve) =>
        setImmediate(() => resolve(!finished)),
      )
      expect(ranDuringTheSweep).toBe(true)
      expect(await sweep).toBe(total)
    } finally {
      cold.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The canon, against the real artefact
// ─────────────────────────────────────────────────────────────────────────────

const CORPUS = path.join(REPO_ROOT, "data", "qarid.db")
const HAVE_CORPUS = fs.existsSync(CORPUS)

describe.skipIf(!HAVE_CORPUS)("المختارات المنظومة over the real corpus", () => {
  let db: Db

  beforeAll(() => {
    db = openDb(CORPUS)
  })

  afterAll(() => db.close())

  for (const shelf of ANTHOLOGIES) {
    it(`resolves every entry of «${shelf.title}» to the شاعر it names`, () => {
      const items = resolveAnthology(db, shelf)
      const unresolved = items
        .filter((i) => (shelf.kind === "poems" ? i.poem : i.bait) === null)
        .map((i) => `${i.poet} · ${i.matla}`)
      expect(unresolved).toEqual([])

      for (const item of items) {
        const entry = shelf.entries[item.index]!
        const anchor = entryAnchor(entry.matla)
        const want = canonicalNameKey(normalizeArabic(entry.poet))
        // The شاعر is half the anchor: 21,739 صدور in this corpus carry a
        // different روي under a different name, so «resolved» is only right if
        // it resolved to HIM.
        const got = shelf.kind === "poems" ? item.poem!.poet.name : item.bait!.poet.name
        expect(canonicalNameKey(normalizeArabic(got)), `${entry.poet} · ${entry.matla}`).toBe(want)
        // And the anchor is an OPENING, not a substring — FTS5 would have
        // matched the phrase in somebody's عجز just as happily.
        const opening = shelf.kind === "poems" ? item.poem!.previewSadr : item.bait!.sadr
        expect(normalizeArabic(opening ?? "").startsWith(anchor), `${entry.matla}`).toBe(true)
      }
    })
  }

  it("gives every معلقة its own قصيدة — ten odes, ten poems, no two the same", () => {
    const items = resolveAnthology(db, anthologyBySlug("muallaqat")!)
    const ids = items.map((i) => i.poem!.id)
    expect(new Set(ids).size).toBe(ids.length)
    // A معلقة is a long ode; a five-بيت fragment that happens to open on the
    // same words is the wrong copy, and the length tie-break is what avoids it.
    for (const item of items) expect(item.poem!.baitCount, item.name ?? "").toBeGreaterThanOrEqual(40)
  })

  it("gives every بيت سائر a complete بيت, صدر and عجز", () => {
    const items = resolveAnthology(db, anthologyBySlug("sair")!)
    for (const item of items) {
      expect(item.bait!.isPartial, item.matla).toBe(false)
      expect(item.bait!.ajuz, item.matla).toBeTruthy()
    }
  })
})
