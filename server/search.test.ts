/**
 * `server/search.test.ts` — GET /api/search (design-server.md §7 + §10).
 *
 * Every body is parsed through `SearchResponseSchema` before anything is
 * asserted about it, so a route that drifts from the contract fails here rather
 * than in the client. The fixture facts these tests lean on (all re-derivable
 * with `sqlite3 data/fixture.db`):
 *
 *   · `الملك` and `العليم` share ONE بيت — بيت 1 of الأمير منجك باشا's خفيف
 *     قصيدة — so `الملك العليم` is a real AND hit.
 *   · `الله` appears in 6 أبيات and `الجحيم` in 1, and never together, so
 *     `الله الجحيم` is the AND→OR fallback: 0 under AND, 7 under OR.
 *   · `من` is the fixture's commonest word (83 أبيات), which makes it the only
 *     term wide enough to slice filters and pages out of.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { Hono } from "hono"

import { stripTashkeel } from "../shared/arabic.ts"
import { SearchResponseSchema, LIMITS, type SearchResponse } from "../shared/schema.ts"
import { ensureFixtureDb, FIXTURE_DB } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { openDb, type Db } from "./db.ts"
import { searchRoutes } from "./routes/search.ts"
import { SEARCH_SCAN_CAP, SNIPPET_CLOSE, SNIPPET_OPEN, rankDecision, shouldRank } from "./search.ts"

const config = loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test" } as NodeJS.ProcessEnv)

/** The one AND hit in the fixture. */
const AND_QUERY = "الملك العليم"
/** Two words that both occur but never in the same بيت — the OR fallback. */
const FALLBACK_QUERY = "الله الجحيم"
/** The fixture's commonest word, 83 أبيات. */
const COMMON = "من"

let db: Db
let app: Hono

/** `/api/search?…` with every value percent-encoded (raw Arabic bytes 400). */
function url(params: Record<string, string | number>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&")
  return `/api/search?${qs}`
}

/**
 * A fresh source address per request. `/api/search` carries a token bucket now
 * (60 per 10 s per IP, `SEARCH_RATE_LIMIT`), and every `app.request()` in a
 * suite otherwise looks like one anonymous client — a file with fifty searches
 * in it would 429 itself halfway through and the failure would look like a
 * search bug. Same reasoning as the room suite's per-player IP.
 */
let probeIp = 0
function fromNewClient(): RequestInit {
  return { headers: { "CF-Connecting-IP": `10.9.${(probeIp >> 8) & 255}.${probeIp++ & 255}` } }
}

async function search(params: Record<string, string | number>): Promise<SearchResponse> {
  const res = await app.request(url(params), fromNewClient())
  expect(res.status).toBe(200)
  return SearchResponseSchema.parse(await res.json())
}

beforeAll(async () => {
  await ensureFixtureDb()
  db = openDb(FIXTURE_DB)
  app = createApp(config, db).app
})

afterAll(() => {
  db?.close()
})

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/search — the envelope", () => {
  it("echoes q, scope, page and limit and reports a non-negative ms", async () => {
    const body = await search({ q: AND_QUERY, page: 1, limit: 5 })
    expect(body.q).toBe(AND_QUERY)
    expect(body.scope).toBe("all")
    expect(body.page).toBe(1)
    expect(body.limit).toBe(5)
    expect(body.ms).toBeGreaterThanOrEqual(0)
  })

  it("clamps limit to the search cap of 40, not the list cap of 100", async () => {
    const body = await search({ q: COMMON, limit: 999 })
    expect(body.limit).toBe(LIMITS.maxSearchLimit)
    expect(LIMITS.maxSearchLimit).toBe(40)
  })

  it("400s on an illegal enum, because the client cannot legally emit one", async () => {
    const res = await app.request("/api/search?q=x&scope=bogus", fromNewClient())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad_query")
  })
})

describe("GET /api/search — AND", () => {
  it("finds the one بيت carrying both words and reports mode 'and'", async () => {
    const body = await search({ q: AND_QUERY, scope: "baits" })
    expect(body.mode).toBe("and")
    expect(body.total).toBe(1)
    expect(body.baits).toHaveLength(1)
    const hit = body.baits[0]!
    expect(stripTashkeel(hit.sadr)).toContain("الملك")
    expect(hit.poem.id).toBe("16182")
    expect(hit.poet.name).toContain("منجك")
  })

  it("sends the original tashkeel'd text alongside the normalized highlight", async () => {
    const hit = (await search({ q: AND_QUERY, scope: "baits" })).baits[0]!
    // the highlight is a snippet of the NORMALIZED column — no tashkeel
    expect(hit.highlight).not.toBeNull()
    expect(hit.highlight).not.toMatch(/[ً-ْ]/)
    // …while sadr/ajuz are the real thing (this fixture poem has_tashkeel=1)
    expect(hit.sadr).toMatch(/[ً-ْ]/)
  })

  it("ranks with a positive score, best first", async () => {
    const body = await search({ q: COMMON, scope: "baits", limit: 20 })
    expect(body.baits.length).toBeGreaterThan(1)
    for (const hit of body.baits) expect(hit.score).toBeGreaterThan(0)
    const scores = body.baits.map((b) => b.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })
})

describe("GET /api/search — the snippet", () => {
  it("marks the matched words with »«", async () => {
    const hit = (await search({ q: AND_QUERY, scope: "baits" })).baits[0]!
    expect(hit.highlight).toContain(SNIPPET_OPEN)
    expect(hit.highlight).toContain(SNIPPET_CLOSE)
    expect(hit.highlight).toContain(`${SNIPPET_OPEN}الملك${SNIPPET_CLOSE}`)
    expect(hit.highlight).toContain(`${SNIPPET_OPEN}العليم${SNIPPET_CLOSE}`)
  })

  it("marks poem titles and poet names too", async () => {
    const poems = (await search({ q: "الخمر", scope: "poems" })).poems
    expect(poems.length).toBeGreaterThan(0)
    expect(poems.some((p) => (p.highlight ?? "").includes(SNIPPET_OPEN))).toBe(true)

    const poets = (await search({ q: "المتنبي", scope: "poets" })).poets
    expect(poets.length).toBeGreaterThan(0)
    expect(poets.some((p) => (p.highlight ?? "").includes(SNIPPET_OPEN))).toBe(true)
  })
})

describe("GET /api/search — AND→OR fallback", () => {
  it("falls back to OR when AND finds nothing, and says so", async () => {
    const and = await search({ q: FALLBACK_QUERY, scope: "baits", mode: "and" })
    expect(and.mode).toBe("and")
    expect(and.total).toBe(0)
    expect(and.baits).toEqual([])

    const auto = await search({ q: FALLBACK_QUERY, scope: "baits" })
    expect(auto.mode).toBe("or")
    expect(auto.total).toBeGreaterThan(0)
    expect(auto.baits.length).toBeGreaterThan(0)
  })

  it("does not fall back when the client pinned a mode", async () => {
    const pinned = await search({ q: FALLBACK_QUERY, scope: "baits", mode: "and" })
    expect(pinned.mode).toBe("and")
    const or = await search({ q: FALLBACK_QUERY, scope: "baits", mode: "or" })
    expect(or.mode).toBe("or")
    expect(or.total).toBeGreaterThan(0)
  })

  it("does not fall back on a single term — there is nothing to loosen", async () => {
    const body = await search({ q: "زقزقةٌ", scope: "baits" })
    expect(body.mode).toBe("and")
    expect(body.total).toBe(0)
  })

  it("reports 'and' when the zero came from a FILTER, not from the words", async () => {
    // «من» matches plenty; era=nope names no عصر, so the empty result says
    // nothing about the query and the client must not show «لا نتيجة بكل الكلمات».
    const body = await search({ q: `${COMMON} الهوى`, scope: "baits", era: "nope" })
    expect(body.total).toBe(0)
    expect(body.mode).toBe("and")
  })
})

describe("GET /api/search — hostile input", () => {
  const hostile = [
    'AND OR NOT NEAR(x y) "unbalanced ( ) * ^ : -',
    `الملك AND NEAR(العليم) OR NOT "مبتور( * ^ : -`,
    '"""""',
    "((((()))))",
    "* ^ - : ,",
    "الملك* ^العليم",
    "a".repeat(500),
    "من OR من OR من OR من OR من OR من OR من OR من OR من OR من OR من OR من OR من OR من",
  ]

  for (const q of hostile) {
    it(`answers 200 for ${JSON.stringify(q.slice(0, 40))}`, async () => {
      const body = await search({ q })
      expect(["and", "or"]).toContain(body.mode)
      expect(body.total).toBeGreaterThanOrEqual(0)
    })
  }

  it("treats FTS operators as literal words, never as syntax", async () => {
    // the same words with operators sprinkled in must find the same بيت
    const clean = await search({ q: AND_QUERY, scope: "baits" })
    const dirty = await search({ q: `الملك AND NEAR(العليم) *`, scope: "baits" })
    // AND / NEAR are now literal WORDS that no بيت carries, so the AND pass is
    // empty and the OR fallback surfaces the same بيت among its hits — which is
    // exactly the proof that they were not parsed as operators.
    expect(dirty.mode).toBe("or")
    expect(dirty.baits.map((b) => b.baytKey)).toContain(clean.baits[0]!.baytKey)
  })
})

describe("GET /api/search — the empty query", () => {
  it("returns an empty result rather than an FTS5 syntax error", async () => {
    for (const q of ["", "   ", "،؟!", "()*^:-"]) {
      const body = await search({ q })
      expect(body.baits).toEqual([])
      expect(body.poems).toEqual([])
      expect(body.poets).toEqual([])
      expect(body.total).toBe(0)
      expect(body.mode).toBe("and")
    }
  })

  it("answers a missing q at all", async () => {
    const res = await app.request("/api/search", fromNewClient())
    expect(res.status).toBe(200)
    const body = SearchResponseSchema.parse(await res.json())
    expect(body.q).toBe("")
    expect(body.total).toBe(0)
  })

  it("does not touch SQLite for an empty query", async () => {
    // A handle that throws the moment anything prepares a statement. If the
    // route reaches SQLite at all — including for the slug maps — this fails.
    const poisoned = {
      raw: null,
      q() {
        throw new Error("SQLite was touched for an empty query")
      },
      close() {},
    } as unknown as Db
    const bare = searchRoutes(poisoned, config)
    const res = await bare.request("/?q=%20%20")
    expect(res.status).toBe(200)
    const body = SearchResponseSchema.parse(await res.json())
    expect(body.total).toBe(0)
  })
})

describe("GET /api/search — scope", () => {
  it("fills all three lists on scope=all", async () => {
    const body = await search({ q: "الله", scope: "all" })
    expect(body.scope).toBe("all")
    expect(body.baits.length).toBeGreaterThan(0)
    expect(body.poets.length).toBeGreaterThan(0)
    expect(body.total).toBe(body.baits.length + body.poems.length + body.poets.length)
  })

  it("fills only the requested list on a single scope", async () => {
    const baits = await search({ q: "الله", scope: "baits" })
    expect(baits.baits.length).toBeGreaterThan(0)
    expect(baits.poems).toEqual([])
    expect(baits.poets).toEqual([])

    const poets = await search({ q: "المتنبي", scope: "poets" })
    expect(poets.poets.length).toBeGreaterThan(0)
    expect(poets.baits).toEqual([])
    expect(poets.poems).toEqual([])

    const poems = await search({ q: "الخمر", scope: "poems" })
    expect(poems.poems.length).toBeGreaterThan(0)
    expect(poems.baits).toEqual([])
    expect(poems.poets).toEqual([])
  })

  it("searches poem titles AND poet names through poems_fts", async () => {
    const byPoet = await search({ q: "المتنبي", scope: "poems" })
    expect(byPoet.poems.length).toBeGreaterThan(0)
    for (const poem of byPoet.poems) expect(poem.poet.name).toContain("المتنبي")
  })
})

describe("GET /api/search — filters", () => {
  it("respects meter", async () => {
    const body = await search({ q: COMMON, scope: "baits", meter: "tawil", limit: 40 })
    expect(body.baits.length).toBeGreaterThan(0)
    for (const hit of body.baits) expect(hit.meter?.slug).toBe("tawil")
  })

  it("respects era", async () => {
    const body = await search({ q: COMMON, scope: "baits", era: "jahili", limit: 40 })
    expect(body.baits.length).toBeGreaterThan(0)
    for (const hit of body.baits) expect(hit.era?.slug).toBe("jahili")
  })

  it("respects poet", async () => {
    const body = await search({ q: COMMON, scope: "baits", poet: "mutanabi", limit: 40 })
    expect(body.baits.length).toBeGreaterThan(0)
    for (const hit of body.baits) expect(hit.poet.slug).toBe("mutanabi")
  })

  it("respects rhyme — on the بيت's own روي", async () => {
    const body = await search({ q: COMMON, scope: "baits", rhyme: "م", limit: 40 })
    expect(body.baits.length).toBeGreaterThan(0)
    for (const hit of body.baits) expect(hit.rawiyy).toBe("م")
  })

  it("narrows rather than widens", async () => {
    const all = await search({ q: COMMON, scope: "baits", limit: 40 })
    const filtered = await search({ q: COMMON, scope: "baits", meter: "tawil", limit: 40 })
    expect(filtered.total).toBeLessThan(all.total)
    expect(filtered.total).toBeGreaterThan(0)
  })

  it("filters the poems list on the قصيدة's own columns", async () => {
    const body = await search({ q: "المتنبي", scope: "poems", meter: "tawil", limit: 40 })
    for (const poem of body.poems) expect(poem.meter?.slug).toBe("tawil")
  })

  it("makes an unknown slug an empty result, never a 400", async () => {
    const cases: Array<Record<string, string>> = [
      { q: COMMON, era: "no-such-era" },
      { q: COMMON, meter: "no-such-meter" },
      { q: COMMON, poet: "no-such-poet" },
    ]
    for (const params of cases) {
      const body = await search({ ...params, scope: "baits" })
      expect(body.baits).toEqual([])
      expect(body.total).toBe(0)
    }
  })

  it("ignores the poem-level facets on the poets list (a شاعر has no بحر)", async () => {
    const plain = await search({ q: "المتنبي", scope: "poets" })
    const withMeter = await search({ q: "المتنبي", scope: "poets", meter: "tawil" })
    expect(withMeter.total).toBe(plain.total)
  })

  it("applies era and poet to the poets list", async () => {
    const body = await search({ q: "المتنبي", scope: "poets", poet: "mutanabi" })
    expect(body.poets).toHaveLength(1)
    expect(body.poets[0]!.slug).toBe("mutanabi")
  })
})

describe("GET /api/search — the شعراء ranking", () => {
  it("ranks a NAME match above a ترجمة match, and the famous name first", async () => {
    // bm25 normalises by the length of the whole row, so a شاعر with a long
    // ترجمة is punished for having one: on the real corpus «المتنبي» lost to
    // «المشوق الشامي صديق المتنبي», six قصائد and no bio. The fixture holds the
    // same shape — «امرؤ القيس» (canon, fame 3), «امرؤ القيس بن حجر الكندي»
    // (fame 0) and «حاتم الطائي», whose bio merely mentions القيس.
    const poets = (await search({ q: "القيس", scope: "poets" })).poets
    const names = poets.map((p) => p.name)
    expect(names[0]).toBe("امرؤ القيس")

    const named = names.filter((n) => n.includes("القيس"))
    const mentioned = names.filter((n) => !n.includes("القيس"))
    expect(named.length).toBeGreaterThan(1)
    if (mentioned.length > 0) {
      // every name hit comes before the first bio-only hit, whatever its fame
      expect(names.indexOf(mentioned[0]!)).toBeGreaterThan(names.lastIndexOf(named[named.length - 1]!))
    }
  })

  it("still ranks by fame among equals, and stays deterministic", async () => {
    const a = (await search({ q: "القيس", scope: "poets" })).poets.map((p) => p.slug)
    const b = (await search({ q: "القيس", scope: "poets" })).poets.map((p) => p.slug)
    expect(a).toEqual(b)
    const fames = (await search({ q: "القيس", scope: "poets" })).poets
      .filter((p) => p.name.includes("القيس"))
      .map((p) => p.fame)
    expect(fames).toEqual([...fames].sort((x, y) => y - x))
  })

  it("keeps that ranking on the COMBINED scope — the palette's own request", async () => {
    // The global palette (v2.md §3) asks for all three lists in one round trip
    // and promises fame-first شعراء. `scope=all` runs the same `searchPoets`,
    // so the promise is the server's, not a client-side re-sort: pinned here
    // because a "lightweight combined mode" that skipped `rankedPoetRefs`
    // would break it silently and only on that one surface.
    const combined = await search({ q: "القيس", scope: "all", limit: 5 })
    const alone = await search({ q: "القيس", scope: "poets", limit: 5 })
    expect(combined.poets.map((p) => p.slug)).toEqual(alone.poets.map((p) => p.slug))
    expect(combined.poets[0]!.name).toBe("امرؤ القيس")
  })
})

describe("GET /api/search — pagination", () => {
  it("never repeats a hit across pages and keeps total stable", async () => {
    const first = await search({ q: COMMON, scope: "baits", limit: 5, page: 1 })
    const second = await search({ q: COMMON, scope: "baits", limit: 5, page: 2 })
    expect(second.total).toBe(first.total)
    expect(first.baits).toHaveLength(5)
    const keys = new Set(first.baits.map((b) => b.baytKey))
    for (const hit of second.baits) expect(keys.has(hit.baytKey)).toBe(false)
  })

  it("returns an empty page past the end without changing total", async () => {
    const first = await search({ q: COMMON, scope: "baits", limit: 5, page: 1 })
    const far = await search({ q: COMMON, scope: "baits", limit: 5, page: 900 })
    expect(far.baits).toEqual([])
    expect(far.total).toBe(first.total)
  })

  it("never reports more than the bounded inner scan", async () => {
    const body = await search({ q: COMMON, scope: "baits", limit: 40 })
    expect(body.total).toBeLessThanOrEqual(SEARCH_SCAN_CAP)
    expect(SEARCH_SCAN_CAP).toBe(400)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The bm25 guard (server/search.ts `highDfTerms`)
// ═════════════════════════════════════════════════════════════════════════════

describe("ranking a query is optional when every word is a particle", () => {
  const HIGH: ReadonlySet<string> = new Set(["من", "في", "ما"])

  it("skips the ORDER BY when the whole AND query is high-frequency", () => {
    expect(rankDecision(HIGH, ["من"], "and")).toBe(false)
    expect(rankDecision(HIGH, ["من", "في"], "and")).toBe(false)
    // one uncommon word makes ranking affordable again — an AND costs what its
    // RAREST term costs
    expect(rankDecision(HIGH, ["من", "الخيل"], "and")).toBe(true)
  })

  it("is stricter for OR, which walks every posting of every term", () => {
    expect(rankDecision(HIGH, ["من", "الخيل"], "or")).toBe(false)
    expect(rankDecision(HIGH, ["الخيل", "السيف"], "or")).toBe(true)
  })

  it("ranks everything when the artefact never named a high-frequency term", () => {
    expect(rankDecision(new Set(), ["من"], "and")).toBe(true)
    expect(rankDecision(HIGH, [], "and")).toBe(true)
  })

  it("ranks everything on a fixture, whose commonest word is 83 أبيات", async () => {
    expect(shouldRank(db, [COMMON], "and")).toBe(true)
    const body = await search({ q: COMMON, scope: "baits" })
    expect(body.baits.length).toBeGreaterThan(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The trailing star (v2.md §2)
// ═════════════════════════════════════════════════════════════════════════════

describe("a trailing * is a prefix, and nothing else is syntax", () => {
  it("finds by prefix what the whole word finds", async () => {
    // «العليم» is one بيت of the fixture (see the header); «العلي*» must reach
    // the same بيت without the reader knowing how the word ends.
    const whole = await search({ q: "العليم", scope: "baits" })
    const starred = await search({ q: "العلي*", scope: "baits" })
    expect(whole.baits.length).toBeGreaterThan(0)
    expect(starred.baits.map((b) => b.id)).toEqual(expect.arrayContaining(whole.baits.map((b) => b.id)))
  })

  it("ignores a star too short to afford", async () => {
    // `PREFIX_MIN_LENGTH` — «ال»* costs 2,058 ms on the real corpus, so it is
    // searched as the word «ال» instead of as every word beginning with it.
    const short = await search({ q: "ال*", scope: "baits" })
    const word = await search({ q: "ال", scope: "baits" })
    expect(short.baits.map((b) => b.id)).toEqual(word.baits.map((b) => b.id))
  })

  it("still refuses every other operator", async () => {
    for (const q of ["*", "**", "NEAR(الملك العليم)", "الملك AND العليم", "^الملك"]) {
      const res = await app.request(url({ q, scope: "baits" }))
      expect(res.status, `«${q}» must not reach FTS5 as syntax`).toBe(200)
      SearchResponseSchema.parse(await res.json())
    }
  })
})
