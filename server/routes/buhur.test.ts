/**
 * `/api/buhur` — the shape, the memo, the pre-warm, and the three gates that
 * make a بيت an EXAMPLE rather than merely a hit.
 *
 * Two halves, the shape `anthology.test.ts` established. The first drives the
 * app over the FIXTURE artefact, which holds only a handful of قصائد and
 * therefore exercises the path that matters most on a thin corpus: a بحر with
 * no usable قصيدة must come back as an ITEM with `bait: null`, never be dropped
 * and never take the other fifteen down with it — the card teaches from its
 * مفتاح either way.
 *
 * The second runs against `data/qarid.db` when it exists and asserts what the
 * gates are actually FOR: every example is voweled, complete (both شطران), on
 * the بحر it illustrates and not on a مجزوء of it. Those are the four ways this
 * page could quietly teach something false. It is skipped in a fresh checkout,
 * the way the anthology and rawiyy corpus tests are.
 */

import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Hono } from "hono"

import { stripTashkeel } from "../../shared/arabic.ts"
import { BUHUR } from "../../shared/meters.ts"
import { BuhurResponseSchema } from "../../shared/schema.ts"
import { ensureFixtureDb, FIXTURE_DB, REPO_ROOT } from "../../test/fixtureDb.ts"
import { createApp } from "../app.ts"
import { loadConfig } from "../config.ts"
import { openDb, type Db } from "../db.ts"
import { warmBuhur } from "./buhur.ts"

const config = loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test" } as NodeJS.ProcessEnv)

describe("/api/buhur over the fixture", () => {
  let db: Db
  let app: Hono

  beforeAll(async () => {
    await ensureFixtureDb()
    db = openDb(FIXTURE_DB)
    app = createApp(config, db).app
  })

  afterAll(() => db.close())

  it("answers with all sixteen بحور, in الخليل's دوائر order", async () => {
    const res = await app.request("/api/buhur")
    expect(res.status).toBe(200)
    const body = BuhurResponseSchema.parse(await res.json())
    expect(body.items).toHaveLength(16)
    expect(body.items.map((i) => i.slug)).toEqual(BUHUR.map((m) => m.slug))
  })

  it("keeps a بحر the corpus cannot illustrate as an item with no بيت", async () => {
    // The fixture is a few hundred قصائد, so most بحور have nothing that passes
    // the gates. Dropping them would leave the page with a ragged five cards
    // and no way for the reader to know the other eleven exist.
    const body = BuhurResponseSchema.parse(await (await app.request("/api/buhur")).json())
    const empty = body.items.filter((i) => i.bait === null)
    expect(empty.length).toBeGreaterThan(0)
    expect(body.items).toHaveLength(16)
  })

  it("never serves half a بيت — an example must show a whole تفعيلات line", async () => {
    const body = BuhurResponseSchema.parse(await (await app.request("/api/buhur")).json())
    for (const item of body.items) {
      if (!item.bait) continue
      expect(item.bait.ajuz).not.toBeNull()
      expect(item.bait.ajuz?.trim()).not.toBe("")
    }
  })

  it("is cached as hard as /api/meta — it is a pure function of the artefact", async () => {
    const res = await app.request("/api/buhur")
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600, stale-while-revalidate=86400")
  })

  it("warms every بحر, and a warmed handle answers from the memo", async () => {
    expect(await warmBuhur(db)).toBe(16)
    // A second warm is pure memo lookups: same answer, no new query.
    expect(await warmBuhur(db)).toBe(16)
    const a = BuhurResponseSchema.parse(await (await app.request("/api/buhur")).json())
    const b = BuhurResponseSchema.parse(await (await app.request("/api/buhur")).json())
    expect(a).toEqual(b)
  })

  it("memoises on the HANDLE, so a second handle is genuinely cold", async () => {
    const cold = openDb(FIXTURE_DB)
    try {
      // The memo is a WeakMap keyed on the Db, like slugMaps and the facet
      // cache. A route closure would have made this the same object.
      const app2 = createApp(config, cold).app
      const fresh = BuhurResponseSchema.parse(await (await app2.request("/api/buhur")).json())
      expect(fresh.items.map((i) => i.slug)).toEqual(BUHUR.map((m) => m.slug))
    } finally {
      cold.close()
    }
  })
})

const CORPUS = path.join(REPO_ROOT, "data", "qarid.db")
const HAVE_CORPUS = fs.existsSync(CORPUS)

describe.skipIf(!HAVE_CORPUS)("صفحة البحور over the real corpus", () => {
  let db: Db
  let app: Hono

  beforeAll(() => {
    db = openDb(CORPUS)
    app = createApp(config, db).app
  })

  afterAll(() => db.close())

  it("illustrates every one of the sixteen بحور", async () => {
    const body = BuhurResponseSchema.parse(await (await app.request("/api/buhur")).json())
    const missing = body.items.filter((i) => i.bait === null).map((i) => i.slug)
    expect(missing).toEqual([])
  })

  it("prints the بيت on the بحر the card claims, never on a مجزوء of it", async () => {
    // The card sets the full تفعيلات directly under the بيت. A مجزوء قصيدة is
    // on the بحر but not on those تفعيلات, so it would not scan against the
    // line printed above it.
    const body = BuhurResponseSchema.parse(await (await app.request("/api/buhur")).json())
    for (const item of body.items) {
      expect(item.bait?.meter?.slug).toBe(item.slug)
      expect(item.bait?.meter?.variant ?? null).toBeNull()
    }
  })

  it("is VOWELED — this is the one page where the vowels are the content", async () => {
    const body = BuhurResponseSchema.parse(await (await app.request("/api/buhur")).json())
    for (const item of body.items) {
      const bait = item.bait!
      const line = `${bait.sadr} ${bait.ajuz}`
      expect(stripTashkeel(line).length, `${item.slug} carries no tashkeel`).toBeLessThan(line.length)
    }
  })

  it("opens on the مطلع, so the example is the line the قصيدة starts on", async () => {
    const body = BuhurResponseSchema.parse(await (await app.request("/api/buhur")).json())
    for (const item of body.items) expect(item.bait?.position).toBe(1)
  })

  it("warms all sixteen inside one facet warm's worst turn, per بحر", async () => {
    const started = performance.now()
    expect(await warmBuhur(db)).toBe(16)
    // The whole warm was measured at 97 ms cold on `build_id d1a38337`; the
    // ceiling here is loose because it runs on whatever the CI box is, and the
    // property under test is «this is a warm, not a scan».
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})
