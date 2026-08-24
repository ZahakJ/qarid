import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { Hono } from "hono"
import type { z } from "zod"

import { HIJAI_LETTERS } from "../shared/letters.ts"
import {
  BaitDetailResponseSchema,
  BaitDtoSchema,
  BaitsResponseSchema,
  DailyResponseSchema,
  FacetsResponseSchema,
  LIMITS,
  MetaResponseSchema,
  PoemBaitsResponseSchema,
  PoemDetailResponseSchema,
  PoemsResponseSchema,
  PoetPageResponseSchema,
  PoetsResponseSchema,
  SimilarPoemsResponseSchema,
  StatsResponseSchema,
  TrainCandidatesResponseSchema,
} from "../shared/schema.ts"
import { ensureFixtureDb, FIXTURE_DB } from "../test/fixtureDb.ts"
import { loadConfig } from "./config.ts"
import { createApp } from "./app.ts"
import { openDb, type Db } from "./db.ts"
import { riyadhDay } from "./routes/baits.ts"

const config = loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test" } as NodeJS.ProcessEnv)

describe("loadConfig", () => {
  it("defaults to the prod port and the repo-local database", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv)
    expect(c.host).toBe("127.0.0.1")
    expect(c.port).toBe(8010)
    expect(c.publicOrigin).toBe("https://qarid.avicenna.space")
    expect(c.dbPath.endsWith("/data/qarid.db")).toBe(true)
    expect(c.dev).toBe(true)
  })

  it("honours the env overrides", () => {
    const c = loadConfig({ HOST: "::1", PORT: "5750", DB_PATH: "/x/y.db", PUBLIC_ORIGIN: "http://localhost:6750", NODE_ENV: "production" } as NodeJS.ProcessEnv)
    expect(c).toMatchObject({ host: "::1", port: 5750, dbPath: "/x/y.db", publicOrigin: "http://localhost:6750", dev: false })
  })
})

describe("createApp without a corpus", () => {
  const { app } = createApp(config, null)

  it("serves /healthz", async () => {
    const res = await app.request("/healthz")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  it("sets the baseline security headers on every response", async () => {
    const res = await app.request("/healthz")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin")
  })

  it("puts a CSP with font-src 'self' data: on html responses", async () => {
    const res = await app.request("/")
    const csp = res.headers.get("Content-Security-Policy")
    // "/" is html only once dist/ exists; when it does, the CSP must be there
    if ((res.headers.get("content-type") ?? "").includes("text/html")) {
      expect(csp).toContain("font-src 'self' data:")
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
    } else {
      expect(res.status).toBe(200)
    }
  })

  it("answers 503 on /api/* rather than crashing", async () => {
    const res = await app.request("/api/meta")
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "corpus_unavailable" })
  })
})

describe("createApp with a corpus handle", () => {
  // A stub is enough here: no route factory touches SQLite at MOUNT time (the
  // meta payload and the slug maps are memoised on first request), so all this
  // block asserts is that the 503 guard lifts and that an unknown /api path
  // 404s instead of returning the SPA shell — a JSON client must never be
  // handed html. The routes themselves are exercised against a real artefact
  // in the «read API on data/fixture.db» block below.
  const stub = { raw: {}, q: () => ({}), close: () => {} } as unknown as Parameters<typeof createApp>[1]
  const { app } = createApp(config, stub)

  it("404s unknown /api routes", async () => {
    const res = await app.request("/api/definitely-not-a-route")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not_found" })
  })

  it("still serves /healthz", async () => {
    expect(await (await app.request("/healthz")).text()).toBe("ok")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The read API against a real artefact (design-server.md §7, §10).
//
// Every response is parsed through the SAME zod schema `client/api/client.ts`
// will parse it through. That is the point of this file: a route that answers
// 200 with a field renamed, a letter unfolded or a `total` missing is a broken
// contract, and only the schema catches all three. Facts are read out of
// `data/fixture.db` rather than hard-coded wherever the fixture could grow —
// what is asserted is the INVARIANT (a filtered list only contains matching
// rows, page 2 never repeats page 1), not the row count of the day.
// ═══════════════════════════════════════════════════════════════════════════


describe("read API on data/fixture.db", () => {
  let db: Db
  let api: Hono

  beforeAll(async () => {
    await ensureFixtureDb()
    db = openDb(FIXTURE_DB)
    api = createApp(loadConfig({ DB_PATH: FIXTURE_DB, NODE_ENV: "test" } as NodeJS.ProcessEnv), db).app
  })
  afterAll(() => db?.close())

  /** GET + status + body, with no schema opinion. */
  async function raw(path: string): Promise<{ status: number; body: any }> {
    const res = await api.request(path)
    return { status: res.status, body: await res.json() }
  }

  /** GET, assert 200, and parse through the wire schema. Returns the DTO. */
  async function get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    const res = await api.request(path)
    const body = await res.json()
    expect(res.status, `${path} → ${JSON.stringify(body).slice(0, 200)}`).toBe(200)
    const parsed = schema.safeParse(body)
    expect(
      parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      `${path} does not match its schema`,
    ).toEqual([])
    return (parsed as { data: z.infer<S> }).data
  }

  const scalar = (sql: string, ...args: Array<string | number>): number =>
    Number((db.q(sql).get(...args) as { n: number }).n)

  // ── /api/meta ───────────────────────────────────────────────────────────
  describe("GET /api/meta", () => {
    it("reports the artefact's real counts", async () => {
      const meta = await get("/api/meta", MetaResponseSchema)
      expect(meta.counts.poems).toBe(scalar("SELECT COUNT(*) AS n FROM poems"))
      expect(meta.counts.baits).toBe(scalar("SELECT COUNT(*) AS n FROM baits"))
      expect(meta.counts.poets).toBe(scalar("SELECT COUNT(*) AS n FROM poets"))
      expect(meta.counts.gameBaits).toBe(scalar("SELECT COUNT(*) AS n FROM game_baits"))
      expect(meta.buildId).toMatch(/^[0-9a-f]{8}$/)
      expect(meta.schemaVersion).toBeGreaterThan(0)
    })

    it("carries all 28 letters with supply and demand (amendment 10)", async () => {
      const meta = await get("/api/meta", MetaResponseSchema)
      expect(meta.letters.map((l) => l.letter)).toEqual([...HIJAI_LETTERS])
      const alif = meta.letters.find((l) => l.letter === "ا")!
      expect(alif.startsWith).toBe(scalar("SELECT COUNT(*) AS n FROM game_baits WHERE first_letter = 'ا'"))
      expect(alif.endsWith).toBe(scalar("SELECT COUNT(*) AS n FROM game_baits WHERE rawiyy = 'ا'"))
    })

    it("keeps zero-count lookups instead of hiding them (the browse doors)", async () => {
      const meta = await get("/api/meta", MetaResponseSchema)
      expect(meta.eras.length).toBe(scalar("SELECT COUNT(*) AS n FROM eras"))
      expect(meta.meters.length).toBe(scalar("SELECT COUNT(*) AS n FROM meters"))
      expect(meta.themes.length).toBe(scalar("SELECT COUNT(*) AS n FROM themes"))
      expect(meta.eras.some((e) => e.poemCount === 0)).toBe(true)
      expect(meta.themes.some((t) => t.kind === "bucket")).toBe(true)
    })
  })

  // ── /api/stats ──────────────────────────────────────────────────────────
  it("GET /api/stats serves the precomputed histograms", async () => {
    const stats = await get("/api/stats", StatsResponseSchema)
    const meta = await get("/api/meta", MetaResponseSchema)
    expect(stats.buildId).toBe(meta.buildId)
    expect(stats.counts).toEqual(meta.counts)
    expect(stats.poemLengths.length).toBeGreaterThan(0)
    expect(stats.poemLengths.reduce((a, b) => a + b.count, 0)).toBe(meta.counts.poems)
    expect(stats.rhymes.map((r) => r.letter)).toEqual([...HIJAI_LETTERS])
    expect(stats.topPoets.length).toBeGreaterThan(0)
  })

  // ── /api/poets ──────────────────────────────────────────────────────────
  describe("GET /api/poets", () => {
    it("pages the index and echoes the clamp that happened", async () => {
      const all = await get("/api/poets?limit=100", PoetsResponseSchema)
      expect(all.total).toBe(scalar("SELECT COUNT(*) AS n FROM poets"))

      const clamped = await get("/api/poets?limit=9999&page=0", PoetsResponseSchema)
      expect(clamped.limit).toBe(LIMITS.maxLimit)
      expect(clamped.page).toBe(1)

      const junk = await get("/api/poets?limit=abc", PoetsResponseSchema)
      expect(junk.limit).toBe(LIMITS.defaultLimit)
    })

    it("never repeats a poet across pages", async () => {
      const p1 = await get("/api/poets?limit=10&page=1", PoetsResponseSchema)
      const p2 = await get("/api/poets?limit=10&page=2", PoetsResponseSchema)
      expect(p2.total).toBe(p1.total)
      const slugs = new Set(p1.items.map((p) => p.slug))
      expect(p2.items.every((p) => !slugs.has(p.slug))).toBe(true)
    })

    it("filters by letter, era and fame", async () => {
      const mim = await get("/api/poets?letter=م&limit=100", PoetsResponseSchema)
      expect(mim.items.every((p) => p.letter === "م")).toBe(true)
      expect(mim.total).toBe(scalar("SELECT COUNT(*) AS n FROM poets WHERE letter = 'م'"))

      const jahili = await get("/api/poets?era=jahili&limit=100", PoetsResponseSchema)
      expect(jahili.items.every((p) => p.era?.slug === "jahili")).toBe(true)

      const famous = await get("/api/poets?fame=3&limit=100", PoetsResponseSchema)
      expect(famous.items.every((p) => p.fame >= 3)).toBe(true)
      expect(famous.total).toBe(scalar("SELECT COUNT(*) AS n FROM poets WHERE fame >= 3"))
    })

    it("sorts by name, poems and baits", async () => {
      const byPoems = await get("/api/poets?sort=poems&limit=10", PoetsResponseSchema)
      const counts = byPoems.items.map((p) => p.poemCount)
      expect([...counts].sort((a, b) => b - a)).toEqual(counts)

      const byBaits = await get("/api/poets?sort=baits&limit=10", PoetsResponseSchema)
      const baits = byBaits.items.map((p) => p.baitCount)
      expect([...baits].sort((a, b) => b - a)).toEqual(baits)
    })

    it("filters by a normalized substring of the name", async () => {
      const hit = await get("/api/poets?q=المتنبي", PoetsResponseSchema)
      expect(hit.items.some((p) => p.slug === "mutanabi")).toBe(true)
      const miss = await get("/api/poets?q=زززززز", PoetsResponseSchema)
      expect(miss).toMatchObject({ items: [], total: 0 })
    })

    it("400s on an illegal enum but never on a junk number", async () => {
      const bad = await raw("/api/poets?sort=bogus")
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe("bad_query")
      expect(bad.body.issues[0].path).toEqual(["sort"])
    })

    it("treats an unknown era slug as a filter matching nothing, not an error", async () => {
      const res = await get("/api/poets?era=no-such-era", PoetsResponseSchema)
      expect(res).toMatchObject({ items: [], total: 0 })
    })
  })

  // ── /api/poets/:slug ────────────────────────────────────────────────────
  describe("GET /api/poets/:slug", () => {
    it("returns the poet, a signature بيت, the first page and the facet chips", async () => {
      const page = await get("/api/poets/mutanabi", PoetPageResponseSchema)
      expect(page.poet.slug).toBe("mutanabi")
      expect(page.poet.description).not.toBeNull()
      expect(page.signatureBait).not.toBeNull()
      expect(page.signatureBait!.poet.slug).toBe("mutanabi")
      expect(page.poemsTotal).toBe(page.poet.poemCount)
      expect(page.poems.length).toBeGreaterThan(0)
      expect(page.poems.every((p) => p.poet.slug === "mutanabi")).toBe(true)
      // a chip count can never exceed the ديوان it is scoped to
      for (const group of [page.rhymes, page.meters, page.themes]) {
        expect(group.reduce((a, b) => a + b.count, 0)).toBeLessThanOrEqual(page.poemsTotal)
      }
    })

    it("serves a percent-encoded Arabic slug (73% of poets have one)", async () => {
      const slug = String(
        (db.q("SELECT slug FROM poets WHERE slug GLOB '*[^ -~]*' LIMIT 1").get() as { slug: string }).slug,
      )
      const page = await get(`/api/poets/${encodeURIComponent(slug)}`, PoetPageResponseSchema)
      expect(page.poet.slug).toBe(slug)
    })

    it("404s an unknown slug", async () => {
      const res = await raw("/api/poets/no-such-poet")
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: "not_found", message: "poet" })
    })

    it("pages and filters the ديوان at /poems", async () => {
      const all = await get("/api/poets/mutanabi/poems?limit=100", PoemsResponseSchema)
      expect(all.total).toBe(all.items.length)
      expect(all.items.every((p) => p.poet.slug === "mutanabi")).toBe(true)

      const meter = all.items.find((p) => p.meter !== null)!.meter!.slug
      const filtered = await get(`/api/poets/mutanabi/poems?meter=${meter}&limit=100`, PoemsResponseSchema)
      expect(filtered.items.every((p) => p.meter?.slug === meter)).toBe(true)
      expect(filtered.total).toBeLessThanOrEqual(all.total)

      expect((await raw("/api/poets/no-such-poet/poems")).status).toBe(404)
    })
  })

  // ── /api/poems ──────────────────────────────────────────────────────────
  describe("GET /api/poems", () => {
    it("lists poems from poems+poets only, with the مطلع preview", async () => {
      const res = await get("/api/poems?limit=100", PoemsResponseSchema)
      expect(res.total).toBe(scalar("SELECT COUNT(*) AS n FROM poems"))
      for (const poem of res.items) {
        expect(poem.poet.slug).not.toBe("")
        expect(poem.poet.name).not.toBe("")
        expect(poem.baitCount).toBeGreaterThan(0)
      }
      expect(res.items.some((p) => p.previewSadr !== null)).toBe(true)
    })

    it("honours every filter and combines them", async () => {
      const era = await get("/api/poems?era=jahili&limit=100", PoemsResponseSchema)
      expect(era.items.every((p) => p.era?.slug === "jahili")).toBe(true)
      expect(era.total).toBe(
        scalar("SELECT COUNT(*) AS n FROM poems p JOIN eras e ON e.id = p.era_id WHERE e.slug = 'jahili'"),
      )

      const combo = await get("/api/poems?era=jahili&meter=tawil&limit=100", PoemsResponseSchema)
      expect(combo.items.every((p) => p.era?.slug === "jahili" && p.meter?.slug === "tawil")).toBe(true)
      expect(combo.total).toBeLessThanOrEqual(era.total)

      const bounded = await get("/api/poems?minBaits=5&maxBaits=12&limit=100", PoemsResponseSchema)
      expect(bounded.items.every((p) => p.baitCount >= 5 && p.baitCount <= 12)).toBe(true)

      const rhyme = await get("/api/poems?rhyme=م&limit=100", PoemsResponseSchema)
      expect(rhyme.items.every((p) => p.rhyme === "م")).toBe(true)

      const famous = await get("/api/poems?fame=3&limit=100", PoemsResponseSchema)
      expect(famous.total).toBeLessThan(scalar("SELECT COUNT(*) AS n FROM poems"))
    })

    it("sorts by title, length, poet and fame", async () => {
      const byLength = await get("/api/poems?sort=length&limit=20", PoemsResponseSchema)
      const lengths = byLength.items.map((p) => p.baitCount)
      expect([...lengths].sort((a, b) => b - a)).toEqual(lengths)

      for (const sort of ["title", "poet", "fame"]) {
        const res = await get(`/api/poems?sort=${sort}&limit=5`, PoemsResponseSchema)
        expect(res.items.length).toBe(5)
      }
      expect((await raw("/api/poems?sort=sideways")).status).toBe(400)
    })

    it("sort=random is a stable permutation of the seed", async () => {
      const a1 = await get("/api/poems?sort=random&seed=alpha&limit=10", PoemsResponseSchema)
      const a2 = await get("/api/poems?sort=random&seed=alpha&limit=10", PoemsResponseSchema)
      expect(a2.items.map((p) => p.id)).toEqual(a1.items.map((p) => p.id))

      // stable across pagination: page 2 continues the same order, no repeats
      const a3 = await get("/api/poems?sort=random&seed=alpha&limit=10&page=2", PoemsResponseSchema)
      const first = new Set(a1.items.map((p) => p.id))
      expect(a3.items.every((p) => !first.has(p.id))).toBe(true)

      const b = await get("/api/poems?sort=random&seed=beta&limit=10", PoemsResponseSchema)
      expect(b.items.map((p) => p.id)).not.toEqual(a1.items.map((p) => p.id))
      expect(b.total).toBe(a1.total)
    })

    it("clamps the page size and keeps `total` unpaginated", async () => {
      const big = await get("/api/poems?limit=9999", PoemsResponseSchema)
      expect(big.limit).toBe(LIMITS.maxLimit)
      const small = await get("/api/poems?limit=3&page=2", PoemsResponseSchema)
      expect(small.items.length).toBeLessThanOrEqual(3)
      expect(small.total).toBe(big.total)
    })
  })

  // ── /api/poems/:publicId ────────────────────────────────────────────────
  describe("GET /api/poems/:publicId", () => {
    it("returns the poem with its أبيات already paired", async () => {
      const res = await get("/api/poems/16182", PoemDetailResponseSchema)
      expect(res.poem.id).toBe("16182")
      expect(res.poem.poet.slug).toBe(res.poet.slug)
      expect(res.hasTashkeel).toBe(true)
      expect(res.hasTashkeel).toBe(res.poem.hasTashkeel)
      expect(res.total).toBe(res.poem.baitCount)
      expect(res.baits.length).toBe(res.total)
      expect(res.limit).toBe(LIMITS.poemDetailBaits)
      expect(res.offset).toBe(0)
      expect(res.baits.map((b) => b.position)).toEqual(res.baits.map((_, i) => i + 1))
      for (const bait of res.baits) {
        expect(bait.baytKey).toBe(`16182:${bait.position}`)
        expect(bait.poem.id).toBe("16182")
        expect(bait.sadr.length).toBeGreaterThan(0)
        if (!bait.isPartial) expect(bait.ajuz).not.toBeNull()
      }
    })

    it("caps the inline أبيات at 200 and reports the whole poem in `total`", async () => {
      const long = db.q("SELECT public_id, bait_count FROM poems ORDER BY bait_count DESC LIMIT 1").get() as {
        public_id: string
        bait_count: number
      }
      const res = await get(`/api/poems/${long.public_id}`, PoemDetailResponseSchema)
      expect(res.total).toBe(Number(long.bait_count))
      expect(res.baits.length).toBe(Math.min(Number(long.bait_count), LIMITS.poemDetailBaits))
    })

    it("404s an unknown and a malformed public id", async () => {
      expect((await raw("/api/poems/q99999999")).status).toBe(404)
      expect((await raw("/api/poems/not-an-id")).status).toBe(404)
    })
  })

  // ── /api/poems/:publicId/baits ──────────────────────────────────────────
  describe("GET /api/poems/:publicId/baits", () => {
    it("windows the أبيات and clamps the limit to 300", async () => {
      const whole = await get("/api/poems/16182/baits?limit=300", PoemBaitsResponseSchema)
      expect(whole.total).toBe(10)
      expect(whole.items.length).toBe(10)

      const window = await get("/api/poems/16182/baits?offset=3&limit=4", PoemBaitsResponseSchema)
      expect(window.offset).toBe(3)
      expect(window.limit).toBe(4)
      expect(window.total).toBe(whole.total)
      expect(window.items.map((b) => b.position)).toEqual([4, 5, 6, 7])
      expect(window.items[0]!.sadr).toBe(whole.items[3]!.sadr)

      const clamped = await get("/api/poems/16182/baits?limit=9999", PoemBaitsResponseSchema)
      expect(clamped.limit).toBe(LIMITS.maxBaitsLimit)

      const past = await get("/api/poems/16182/baits?offset=500", PoemBaitsResponseSchema)
      expect(past.items).toEqual([])
      expect(past.total).toBe(10)
    })

    it("404s an unknown poem", async () => {
      expect((await raw("/api/poems/q99999999/baits")).status).toBe(404)
    })
  })

  // ── /api/poems/:publicId/similar (amendment 9) ──────────────────────────
  describe("GET /api/poems/:publicId/similar", () => {
    it("returns same-بحر same-قافية poems, never the poem itself", async () => {
      const res = await get("/api/poems/16182/similar", SimilarPoemsResponseSchema)
      expect(res.total).toBe(res.items.length)
      expect(res.items.every((p) => p.id !== "16182")).toBe(true)
      const seed = await get("/api/poems/16182", PoemDetailResponseSchema)
      for (const p of res.items) {
        expect(p.meter?.slug).toBe(seed.poem.meter?.slug)
        expect(p.rhyme).toBe(seed.poem.rhyme)
      }
    })

    it("clamps its limit and 404s an unknown poem", async () => {
      const res = await get("/api/poems/16182/similar?limit=9999", SimilarPoemsResponseSchema)
      expect(res.items.length).toBeLessThanOrEqual(LIMITS.maxSimilarLimit)
      expect((await raw("/api/poems/q99999999/similar")).status).toBe(404)
    })
  })

  // ── /api/baits ──────────────────────────────────────────────────────────
  describe("GET /api/baits", () => {
    it("browses the playable pool with a total and no cross-page repeats", async () => {
      const res = await get("/api/baits?limit=100", BaitsResponseSchema)
      expect(res.total).toBe(scalar("SELECT COUNT(*) AS n FROM game_baits"))
      const p1 = await get("/api/baits?limit=10&page=1", BaitsResponseSchema)
      const p2 = await get("/api/baits?limit=10&page=2", BaitsResponseSchema)
      const ids = new Set(p1.items.map((b) => b.id))
      expect(p2.items.every((b) => !ids.has(b.id))).toBe(true)
      expect(p2.total).toBe(p1.total)
    })

    it("filters by first letter, روي and fame", async () => {
      const first = await get("/api/baits?first=و&limit=100", BaitsResponseSchema)
      expect(first.items.every((b) => b.firstLetter === "و")).toBe(true)
      expect(first.total).toBe(scalar("SELECT COUNT(*) AS n FROM game_baits WHERE first_letter = 'و'"))

      const rhyme = await get("/api/baits?rhyme=م&limit=100", BaitsResponseSchema)
      expect(rhyme.items.every((b) => b.rawiyy === "م")).toBe(true)

      const both = await get("/api/baits?first=و&rhyme=م&limit=100", BaitsResponseSchema)
      expect(both.total).toBeLessThanOrEqual(Math.min(first.total, rhyme.total))

      const era = await get("/api/baits?era=jahili&limit=100", BaitsResponseSchema)
      expect(era.items.every((b) => b.era?.slug === "jahili")).toBe(true)
    })

    it("returns an empty page (not a 404) for an unknown slug", async () => {
      const res = await get("/api/baits?meter=no-such-meter", BaitsResponseSchema)
      expect(res).toMatchObject({ items: [], total: 0 })
    })
  })

  // ── /api/baits/random ───────────────────────────────────────────────────
  describe("GET /api/baits/random", () => {
    it("is deterministic for a seed and respects the filter", async () => {
      const a = await get("/api/baits/random?seed=قريض", BaitDtoSchema)
      const b = await get("/api/baits/random?seed=قريض", BaitDtoSchema)
      expect(b.id).toBe(a.id)

      const c = await get("/api/baits/random?seed=آخر", BaitDtoSchema)
      expect(c.baytKey).toMatch(/^q?\d+:\d+$/)

      const filtered = await get("/api/baits/random?first=و&seed=x", BaitDtoSchema)
      expect(filtered.firstLetter).toBe("و")
    })

    it("answers without a seed too, and 404s an empty pool", async () => {
      const any = await get("/api/baits/random", BaitDtoSchema)
      expect(any.id).toBeGreaterThan(0)
      // ز has no easy-tier أبيات in the fixture (CLAUDE.md fixture probes)
      const empty = await raw("/api/baits/random?first=ز&rhyme=ظ")
      expect(empty.status).toBe(404)
      expect(empty.body).toEqual({ error: "no_bait" })
    })
  })

  // ── /api/baits/daily ────────────────────────────────────────────────────
  describe("GET /api/baits/daily", () => {
    it("is the same بيت for everyone on a given day", async () => {
      const a = await get("/api/baits/daily?date=2026-08-23", DailyResponseSchema)
      const b = await get("/api/baits/daily?date=2026-08-23", DailyResponseSchema)
      expect(b.bait.id).toBe(a.bait.id)
      expect(b.poetOfTheDay.slug).toBe(a.poetOfTheDay.slug)
      expect(a.date).toBe("2026-08-23")
      // amendment 6: the whole #/daily chain hangs off this string
      expect(a.seed).toBe("daily:2026-08-23")
      expect(a.poem.id).toBe(a.bait.poem.id)
    })

    it("moves with the date", async () => {
      const days = ["2026-01-01", "2026-03-14", "2026-07-07", "2026-11-30"]
      const picks = new Set<number>()
      for (const d of days) picks.add((await get(`/api/baits/daily?date=${d}`, DailyResponseSchema)).bait.id)
      expect(picks.size).toBeGreaterThan(1)
    })

    it("defaults to today in Asia/Riyadh and 400s a malformed date", async () => {
      const today = await get("/api/baits/daily", DailyResponseSchema)
      expect(today.date).toBe(riyadhDay())
      const bad = await raw("/api/baits/daily?date=yesterday")
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe("bad_query")
    })
  })

  // ── /api/baits/:id ──────────────────────────────────────────────────────
  describe("GET /api/baits/:id", () => {
    it("walks the قصيدة with prev/next", async () => {
      const detail = await get("/api/poems/16182", PoemDetailResponseSchema)
      const middle = detail.baits[4]!
      const res = await get(`/api/baits/${middle.id}`, BaitDetailResponseSchema)
      expect(res.bait.id).toBe(middle.id)
      expect(res.poem.id).toBe("16182")
      expect(res.poet.slug).toBe(detail.poet.slug)
      expect(res.prev?.position).toBe(middle.position - 1)
      expect(res.next?.position).toBe(middle.position + 1)

      const head = await get(`/api/baits/${detail.baits[0]!.id}`, BaitDetailResponseSchema)
      expect(head.prev).toBeNull()
      const tail = await get(`/api/baits/${detail.baits.at(-1)!.id}`, BaitDetailResponseSchema)
      expect(tail.next).toBeNull()
    })

    it("404s a missing id and a non-numeric one", async () => {
      expect((await raw("/api/baits/99999999")).status).toBe(404)
      expect((await raw("/api/baits/abc")).status).toBe(404)
    })
  })

  // ── /api/facets ─────────────────────────────────────────────────────────
  describe("GET /api/facets", () => {
    const everyValuePresent = (f: z.infer<typeof FacetsResponseSchema>) => {
      expect(f.eras.length).toBe(scalar("SELECT COUNT(*) AS n FROM eras"))
      expect(f.meters.length).toBe(scalar("SELECT COUNT(*) AS n FROM meters"))
      expect(f.themes.length).toBe(scalar("SELECT COUNT(*) AS n FROM themes"))
      expect(f.rhymes.map((r) => r.letter)).toEqual([...HIJAI_LETTERS])
      expect(f.firstLetters.map((r) => r.letter)).toEqual([...HIJAI_LETTERS])
      expect(f.langTypes.map((l) => l.value)).toEqual(["فصيح", "عامي"])
    }

    it("serves the unfiltered case from meta, zeros included", async () => {
      const f = await get("/api/facets", FacetsResponseSchema)
      everyValuePresent(f)
      expect(f.total).toBe(scalar("SELECT COUNT(*) AS n FROM poems"))
      expect(f.rhymes.some((r) => r.count === 0)).toBe(true)
      expect(f.eras.some((e) => e.count === 0)).toBe(true)
      expect(f.eras.find((e) => e.slug === "jahili")!.count).toBe(
        scalar("SELECT COUNT(*) AS n FROM poems p JOIN eras e ON e.id = p.era_id WHERE e.slug = 'jahili'"),
      )
    })

    it("keeps every value — and every zero — under a filter", async () => {
      const f = await get("/api/facets?era=jahili", FacetsResponseSchema)
      everyValuePresent(f)
      expect(f.total).toBe(
        scalar("SELECT COUNT(*) AS n FROM poems p JOIN eras e ON e.id = p.era_id WHERE e.slug = 'jahili'"),
      )
      // each dimension drops its OWN filter, so the era rail stays clickable
      const unfiltered = await get("/api/facets", FacetsResponseSchema)
      expect(f.eras).toEqual(unfiltered.eras)
      // the other dimensions ARE narrowed
      expect(f.meters.reduce((a, b) => a + b.count, 0)).toBeLessThanOrEqual(
        unfiltered.meters.reduce((a, b) => a + b.count, 0),
      )
    })

    it("counts a meter facet correctly under an era filter", async () => {
      const f = await get("/api/facets?era=jahili", FacetsResponseSchema)
      for (const m of f.meters) {
        expect(m.count).toBe(
          scalar(
            `SELECT COUNT(*) AS n FROM poems p JOIN eras e ON e.id = p.era_id JOIN meters mt ON mt.id = p.meter_id
             WHERE e.slug = 'jahili' AND mt.slug = ?`,
            m.slug,
          ),
        )
      }
    })

    it("returns a full skeleton of zeros for an impossible combination", async () => {
      const f = await get("/api/facets?meter=no-such-meter", FacetsResponseSchema)
      everyValuePresent(f)
      expect(f.total).toBe(0)
      expect(f.rhymes.every((r) => r.count === 0)).toBe(true)
      expect(f.langTypes.every((l) => l.count === 0)).toBe(true)
    })

    it("400s an illegal letter", async () => {
      expect((await raw("/api/facets?rhyme=zz")).status).toBe(400)
    })
  })

  // ── /api/train/candidates ───────────────────────────────────────────────
  describe("GET /api/train/candidates", () => {
    it("draws famous مطالع only, and honours the letter", async () => {
      const res = await get("/api/train/candidates?limit=20", TrainCandidatesResponseSchema)
      expect(res.items.length).toBeGreaterThan(0)
      expect(res.items.length).toBeLessThanOrEqual(20)
      const ids = res.items.map((b) => b.id)
      const famous = scalar(
        `SELECT COUNT(*) AS n FROM game_baits WHERE fame = 3 AND position <= 6 AND bait_id IN (${ids.map(() => "?").join(",")})`,
        ...ids,
      )
      expect(famous).toBe(ids.length)
      expect(res.total).toBe(scalar("SELECT COUNT(*) AS n FROM game_baits WHERE fame = 3 AND position <= 6"))

      const byLetter = await get("/api/train/candidates?letter=و&limit=10", TrainCandidatesResponseSchema)
      expect(byLetter.items.every((b) => b.firstLetter === "و")).toBe(true)
    })

    it("is reproducible for a seed and opens up with famous=0", async () => {
      const a = await get("/api/train/candidates?seed=drill&limit=5", TrainCandidatesResponseSchema)
      const b = await get("/api/train/candidates?seed=drill&limit=5", TrainCandidatesResponseSchema)
      expect(b.items.map((x) => x.id)).toEqual(a.items.map((x) => x.id))

      const wide = await get("/api/train/candidates?famous=0&limit=5", TrainCandidatesResponseSchema)
      expect(wide.total).toBeGreaterThanOrEqual(a.total)
    })

    it("empties out on an impossible filter instead of erroring", async () => {
      const res = await get("/api/train/candidates?meter=no-such-meter", TrainCandidatesResponseSchema)
      expect(res).toMatchObject({ items: [], total: 0 })
    })
  })

  // ── cross-cutting ───────────────────────────────────────────────────────
  describe("house rules", () => {
    it("every list route carries items+total+page+limit", async () => {
      for (const path of ["/api/poets", "/api/poems", "/api/baits", "/api/poets/mutanabi/poems"]) {
        const { body } = await raw(path)
        expect(Object.keys(body).sort(), path).toEqual(["items", "limit", "page", "total"])
      }
    })

    it("404s an unknown /api path as JSON, never the SPA shell", async () => {
      const res = await api.request("/api/nope")
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "not_found" })
    })

    it("keeps the security headers on API responses", async () => {
      const res = await api.request("/api/meta")
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    })
  })
})
