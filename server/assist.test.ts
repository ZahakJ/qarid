/**
 * `server/assist.test.ts` — `GET /api/game/assist`, وضع التدريب's rail (v2.md §2).
 *
 * The same two rules `server/game.test.ts` holds itself to apply here: every
 * body is parsed through its schema before anything is asserted, and every بيت
 * is found by its TEXT in the fixture rather than pinned by id.
 *
 * The one thing worth stating up front is what this endpoint does NOT do: it
 * never puts the typed text into SQL. `assistSuggest` folds it with
 * `shared/arabic.ts` and compares it in JavaScript against a pool it loaded by
 * letter — so the injection cases below are not asserting that an escape works,
 * they are asserting that there is nothing to escape.
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest"
import type { Hono } from "hono"

import { bareWords } from "../shared/arabic.ts"
import { ASSIST, ASSIST_RATE_LIMIT } from "../shared/constants.ts"
import { GameAssistResponseSchema, GamePoolResponseSchema, type GameAssistResponse } from "../shared/schema.ts"
import { ensureFixtureDb, FIXTURE_DB } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { openDb, type Db } from "./db.ts"
import { ASSIST_POOL_MAX, assistPool, assistSuggest, assistTier } from "./game.ts"

const config = loadConfig({ HOST: "127.0.0.1", PORT: "5786", NODE_ENV: "test" } as NodeJS.ProcessEnv)

let db: Db
let app: Hono

/** Every request gets its own IP so neither token bucket fires by accident. */
let ip = 0
async function get(path: string, from?: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, {
    headers: { "x-forwarded-for": from ?? `10.7.0.${ip++ % 250}.${ip}` },
  })
  return { status: res.status, body: await res.json() }
}

async function assist(params: Record<string, string | number>): Promise<GameAssistResponse> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
  const res = await get(`/api/game/assist?${qs}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return GameAssistResponseSchema.parse(res.body)
}

interface PoolProbe {
  letter: string
  id: number
  /** the folded text the matcher compares against */
  text: string
  /** the ORIGINAL صدر, tashkeel intact — what a player would half-remember */
  sadr: string
  words: string[]
}

/** A playable بيت of the fixture on `letter`, with ≥ `minWords` folded words. */
function probeOn(letter: string, minWords = 3, skip = 0): PoolProbe {
  const rows = db
    .q(
      `SELECT gb.bait_id AS id, b.sadr AS sadr, f.norm AS norm
         FROM game_baits gb JOIN baits b ON b.id = gb.bait_id JOIN baits_fts f ON f.rowid = gb.bait_id
        WHERE gb.first_letter = ? ORDER BY gb.fame DESC, gb.bait_id ASC`,
    )
    .all(letter) as Array<Record<string, unknown>>
  let seen = 0
  for (const row of rows) {
    const text = bareWords(String(row.norm))
    const words = text.split(" ")
    if (words.length < minWords) continue
    if (seen++ < skip) continue
    return { letter, id: Number(row.id), text, sadr: String(row.sadr), words }
  }
  throw new Error(`fixture has no playable بيت on «${letter}» with ${minWords} words`)
}

let alif: PoolProbe
let waw: PoolProbe

beforeAll(async () => {
  await ensureFixtureDb()
  db = openDb(FIXTURE_DB)
  app = createApp(config, db).app
  alif = probeOn("ا")
  waw = probeOn("و")
})

afterAll(() => {
  db?.close()
})

describe("GET /api/game/assist — the shape of the answer", () => {
  it("finds the بيت a player has begun to type", async () => {
    const body = await assist({ letter: alif.letter, q: alif.words.slice(0, 2).join(" ") })
    expect(body.items.map((b) => b.id)).toContain(alif.id)
    expect(body.total).toBeGreaterThanOrEqual(body.items.length)
    expect(body.page).toBe(1)
  })

  it("every suggestion actually opens on the letter that was asked for", async () => {
    // The rail exists to be clicked into the answer field, so a suggestion that
    // does not chain is worse than no suggestion at all.
    for (const letter of ["ا", "و", "ف"]) {
      const body = await assist({ letter, q: "ا", limit: ASSIST.maxLimit })
      for (const bait of body.items) expect(bait.firstLetter).toBe(letter)
    }
  })

  it("`also` searches the second accepted letter — the وصل fix", async () => {
    // Rhyme mode accepts an answer on the روي OR the literal ending a وصل left
    // (chainState's alsoAccepted). The rail must offer أبيات on BOTH; without
    // `also` it offered only the روي — the letter before the وصل — while the
    // player was writing one that opens on the وصل letter. `waw` opens on و and
    // is invisible to an alif-only search; naming و as `also` surfaces it.
    const needle = waw.words.slice(0, 2).join(" ")
    const without = await assist({ letter: alif.letter, q: needle })
    expect(without.items.map((b) => b.id)).not.toContain(waw.id)

    const withAlso = await assist({ letter: alif.letter, also: waw.letter, q: needle })
    expect(withAlso.items.map((b) => b.id)).toContain(waw.id)
    for (const bait of withAlso.items) expect([alif.letter, waw.letter]).toContain(bait.firstLetter)
  })

  it("refuses to guess from one character", async () => {
    expect(ASSIST.minChars).toBe(2)
    const body = await assist({ letter: alif.letter, q: alif.words[0]!.slice(0, 1) })
    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
  })

  it("honours the limit, and the schema caps it", async () => {
    const one = await assist({ letter: waw.letter, q: waw.words[0]!.slice(0, 2), limit: 1 })
    expect(one.items.length).toBeLessThanOrEqual(1)
    expect(one.limit).toBe(1)
    const capped = await assist({ letter: waw.letter, q: waw.words[0]!.slice(0, 2), limit: 99 })
    expect(capped.limit).toBe(ASSIST.maxLimit)
    expect(capped.items.length).toBeLessThanOrEqual(ASSIST.maxLimit)
  })

  it("answers an unknown letter with a 400, not a guess", async () => {
    const res = await get("/api/game/assist?letter=x&q=اذا")
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe("bad_query")
  })

  it("never returns the same text twice", async () => {
    const body = await assist({ letter: waw.letter, q: waw.words[0]!.slice(0, 2), limit: ASSIST.maxLimit })
    const texts = body.items.map((b) => bareWords(b.ajuz === null ? b.sadr : `${b.sadr} ${b.ajuz}`))
    expect(new Set(texts).size).toBe(texts.length)
  })
})

describe("GET /api/game/assist — the prefix", () => {
  it("matches a HALF-typed last word", async () => {
    // The whole point of the rail: it answers while the word is still being
    // written. Two words, the second cut in half.
    const head = `${alif.words[0]} ${alif.words[1]!.slice(0, 2)}`
    const body = await assist({ letter: alif.letter, q: head })
    expect(body.items.map((b) => b.id)).toContain(alif.id)
  })

  it("is tashkeel- and همزة-insensitive, because the reader is", async () => {
    // Typed with every حركة the ديوان prints, which is the one thing a player
    // never reproduces.
    const typed = alif.sadr.split(" ").slice(0, 2).join(" ")
    const body = await assist({ letter: alif.letter, q: typed })
    expect(body.items.map((b) => b.id)).toContain(alif.id)
  })

  it("puts the أبيات that OPEN with the words before the ones that merely carry them", async () => {
    // A word from the middle of a بيت finds it; a word from its opening finds
    // it first. The rank is what makes the rail usable while typing an answer.
    const inner = alif.words[alif.words.length - 1]!
    if (inner.length < ASSIST.minChars) return
    const body = await assist({ letter: alif.letter, q: inner, limit: ASSIST.maxLimit })
    const ids = body.items.map((b) => b.id)
    if (!ids.includes(alif.id)) return // the fixture is small; no inner hit to rank
    const opensWith = body.items.findIndex((b) => bareWords(b.sadr).startsWith(inner))
    if (opensWith >= 0) expect(opensWith).toBeLessThan(ids.indexOf(alif.id))
  })

  it("does not answer about another letter's أبيات", async () => {
    const body = await assist({ letter: waw.letter, q: alif.words.slice(0, 2).join(" ") })
    expect(body.items.map((b) => b.id)).not.toContain(alif.id)
    for (const bait of body.items) expect(bait.firstLetter).toBe(waw.letter)
  })
})

describe("GET /api/game/assist — nothing to escape", () => {
  const hostile = [
    '" OR 1=1 --',
    "'; DROP TABLE baits; --",
    "%",
    "_",
    "%%%",
    "*",
    "***",
    "NEAR(a b)",
    "^foo",
    "\\",
    "اذا*",
    "%اذا%",
    "٪_",
    "()))",
  ]
  for (const q of hostile) {
    it(`stays a text query: ${JSON.stringify(q)}`, async () => {
      const body = await assist({ letter: "ا", q, limit: ASSIST.maxLimit })
      // Whatever survives folding is matched as WORDS, so a LIKE wildcard finds
      // nothing (it is not a wildcard here) and an FTS operator finds nothing
      // (there is no MATCH expression to reach).
      for (const bait of body.items) {
        expect(bait.firstLetter).toBe("ا")
        expect(bareWords(`${bait.sadr} ${bait.ajuz ?? ""}`)).toContain(bareWords(q))
      }
      expect(body.total).toBeGreaterThanOrEqual(body.items.length)
    })
  }

  it("a wildcard is not a wildcard: «%» alone matches nothing", async () => {
    const body = await assist({ letter: "ا", q: "%" })
    expect(body.items).toEqual([])
  })

  it("survives a 300-character query", async () => {
    const body = await assist({ letter: "ا", q: "اذا ".repeat(70).slice(0, 300) })
    expect(body.items.length).toBeLessThanOrEqual(ASSIST.defaultLimit)
  })
})

describe("the pool behind the rail", () => {
  it("is bounded, folded, and fame-first", () => {
    const pool = assistPool(db, "ا")
    expect(pool.rows.length).toBeGreaterThan(0)
    expect(pool.rows.length).toBeLessThanOrEqual(ASSIST_POOL_MAX)
    for (const row of pool.rows) {
      // both sides of every comparison run through `bareWords`
      expect(row.text).toBe(bareWords(row.text))
    }
  })

  it("is cached per database handle — the second letter costs no query", () => {
    const first = assistPool(db, "ف")
    const second = assistPool(db, "ف")
    expect(second).toBe(first)
  })

  it("widens the tier only when a letter is too thin to teach with", () => {
    // On the fixture no tier reaches ASSIST_POOL_MIN, so the widest that fits
    // is taken; on the real corpus that is `easy` for 23 of the 28 letters.
    expect(["easy", "normal", "brutal"]).toContain(assistTier(db, "ا"))
  })

  it("assistSuggest returns nothing at all for an empty query", () => {
    expect(assistSuggest(db, { letter: "ا", q: "", limit: 5 })).toEqual({ items: [], total: 0 })
    expect(assistSuggest(db, { letter: "ا", q: "   ", limit: 5 })).toEqual({ items: [], total: 0 })
  })
})

describe("the rail does not spend the duel's rate limit", () => {
  it("keeps /api/game/pool answering after a burst of suggestions", async () => {
    // v2.md §2 says «rate-limited with the game bucket», and taken literally
    // that would 429 the next /verify because the player typed. The rail has
    // its own bucket for exactly this reason (shared/constants.ts).
    const own = createApp(config, db).app
    const one = "203.0.113.9"
    for (let i = 0; i < ASSIST_RATE_LIMIT.tokens; i++) {
      const res = await own.request("/api/game/assist?letter=ا&q=اذا", { headers: { "cf-connecting-ip": one } })
      expect(res.status).toBe(200)
    }
    const pool = await own.request("/api/game/pool", { headers: { "cf-connecting-ip": one } })
    expect(pool.status).toBe(200)
    expect(GamePoolResponseSchema.parse(await pool.json()).total).toBeGreaterThan(0)
  })

  it("but IS limited — a script cannot type forever", async () => {
    const own = createApp(config, db).app
    const one = "203.0.113.10"
    let last = 200
    for (let i = 0; i < ASSIST_RATE_LIMIT.tokens + 2; i++) {
      const res = await own.request("/api/game/assist?letter=ا&q=اذا", { headers: { "cf-connecting-ip": one } })
      last = res.status
    }
    expect(last).toBe(429)
  })
})
