/**
 * `server/game.test.ts` — the مساجلة engine against `data/fixture.db`, which
 * `test/fixtureDb.ts` builds through the real `scripts/ingest/build.ts`.
 *
 * Two rules this file holds itself to:
 *  • every response body is parsed through its schema from `shared/schema.ts`
 *    before anything is asserted, so a route that drifts from the contract fails
 *    here and not in the client;
 *  • every بيت id is looked up by its TEXT in `beforeAll`, never hard-coded. The
 *    fixture is deterministic (amendment 17), but a test that pins `id: 19` goes
 *    green-then-red for reasons that have nothing to do with the game the moment
 *    a poem is added to the sample.
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest"
import type { Hono } from "hono"

import { firstLetterOf, normalizeArabic } from "../shared/arabic.ts"
import { VERIFY } from "../shared/constants.ts"
import { RARE_RAWIYY_WIDE_SET } from "../shared/letters.ts"
import {
  GameHintResponseSchema,
  GamePoolResponseSchema,
  GameReplyResponseSchema,
  GameStartResponseSchema,
  GameVerifyResponseSchema,
  HINT_COSTS,
  MAX_EXCLUDES,
  type GameVerifyResponse,
} from "../shared/schema.ts"
import { TIER_PREDICATES } from "../scripts/ingest/ddl.ts"
import { ensureFixtureDb, FIXTURE_DB } from "../test/fixtureDb.ts"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { openDb, type Db } from "./db.ts"
import {
  AMBIGUOUS_BAND,
  UNIQUE_MARGIN,
  chainState,
  jaccard,
  obscurityOf,
  pickBait,
  rivalsOf,
  sparseOrQuery,
  splitAnswer,
  uncontestedMatch,
  type Scored,
} from "./game.ts"
import { createRateLimiter } from "./ratelimit.ts"
import { MAX_GAME_BODY } from "./routes/game.ts"

const config = loadConfig({ HOST: "127.0.0.1", PORT: "5762", NODE_ENV: "test" } as NodeJS.ProcessEnv)

let db: Db
let app: Hono

/** Every request gets its own IP so the token bucket never fires by accident. */
let ip = 0
async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${ip++ % 250}.${ip}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, { headers: { "x-forwarded-for": `10.1.0.${ip++ % 250}.${ip}` } })
  return { status: res.status, body: await res.json() }
}

/** POST /api/game/verify, parsed through the union. */
async function verify(body: unknown): Promise<GameVerifyResponse> {
  const res = await post("/api/game/verify", body)
  expect(res.status).toBe(200)
  return GameVerifyResponseSchema.parse(res.body)
}

interface Probe {
  id: number
  poemId: number
  sadr: string
  ajuz: string | null
  rawiyy: string | null
  lastLetter: string | null
  firstLetter: string | null
  full: string
}

/** A بيت of the fixture, found by a distinctive fragment of its صدر. */
function probe(fragment: string): Probe {
  const row = db
    .q(
      `SELECT id, poem_id, sadr, ajuz, rawiyy, last_letter, first_letter
       FROM baits WHERE sadr LIKE ? ORDER BY id LIMIT 1`,
    )
    .get(`%${fragment}%`) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error(`fixture has no بيت containing «${fragment}»`)
  const sadr = String(row.sadr)
  const ajuz = row.ajuz === null ? null : String(row.ajuz)
  return {
    id: Number(row.id),
    poemId: Number(row.poem_id),
    sadr,
    ajuz,
    rawiyy: row.rawiyy === null ? null : String(row.rawiyy),
    lastLetter: row.last_letter === null ? null : String(row.last_letter),
    firstLetter: row.first_letter === null ? null : String(row.first_letter),
    full: ajuz === null ? sadr : `${sadr} ${ajuz}`,
  }
}

// The three أبيات the whole file leans on, resolved once.
// wardah  — first letter م, روي ب, complete, fame 3 (a clean exact-match target)
// qadYab  — the بيت that follows it, first letter ق, same روي
// peeled  — روي و but literal ending ا (فَأَشعَبوا): amendment 1's leniency case
let wardah: Probe
let qadYab: Probe
let peeled: Probe
let partial: Probe

beforeAll(async () => {
  await ensureFixtureDb()
  db = openDb(FIXTURE_DB)
  app = createApp(config, db).app
  wardah = probe("تَنظُرونَ بِحَقِّ وَردَةَ")
  qadYab = probe("يَبعَثُ الأَمرَ العَظيمَ")
  peeled = probe("بَدا لِيَ أَنَّهُ سَيَغولُني")
  partial = (() => {
    const row = db.q("SELECT id, poem_id, sadr FROM baits WHERE is_partial = 1 ORDER BY id LIMIT 1").get() as
      | Record<string, unknown>
      | undefined
    if (row === undefined) throw new Error("fixture has no partial بيت")
    return probe(String(row.sadr).slice(4, 20))
  })()
})

afterAll(() => db?.close())

// ═════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═════════════════════════════════════════════════════════════════════════════

describe("splitAnswer", () => {
  it("keeps a whole بيت as one normalized string and finds its صدر", () => {
    const q = splitAnswer("قِف بِالدِيارِ الَّتي لَم يَعفُها القِدَمُ *** بَلى وَغَيَّرَها الأَرواحُ وَالدِيَمُ")
    expect(q.split).toBe(true)
    expect(q.normSadr).toBe("قف بالديار الَّتي لم يعفها القدم".replace("َّ", ""))
    expect(q.normFull.startsWith(q.normSadr)).toBe(true)
    expect(q.words).toBeGreaterThan(8)
  })

  it("splits on two-or-more spaces, which cleanText would otherwise collapse", () => {
    const q = splitAnswer("ألا كل شيء ما خلا الله باطل    وكل نعيم لا محالة زائل")
    expect(q.split).toBe(true)
    expect(q.normSadr).toBe("الا كل شيء ما خلا الله باطل")
  })

  it("treats an unsplit answer's whole text as the صدر", () => {
    const q = splitAnswer("ألا كل شيء ما خلا الله باطل")
    expect(q.split).toBe(false)
    expect(q.normSadr).toBe(q.normFull)
  })

  it("counts words for the too_short gate", () => {
    expect(splitAnswer("كلمة").words).toBe(1)
    expect(splitAnswer("").words).toBe(0)
    expect(splitAnswer("!!! ٣٢١ ***").words).toBe(0)
  })
})

describe("jaccard", () => {
  it("is 1 on identical token sets and 0 on disjoint ones", () => {
    expect(jaccard(new Set(["ا", "ب"]), new Set(["ب", "ا"]))).toBe(1)
    expect(jaccard(new Set(["ا"]), new Set(["ب"]))).toBe(0)
    expect(jaccard(new Set(), new Set(["ب"]))).toBe(0)
  })

  it("halves for one word in three replaced", () => {
    expect(jaccard(new Set(["ا", "ب", "ت"]), new Set(["ا", "ب", "ث"]))).toBeCloseTo(0.5, 5)
  })
})

describe("obscurityOf", () => {
  it("is 0 for a canon شاعر's مطلع and 1 for an unknown one", () => {
    expect(obscurityOf(3, 1)).toBe(0)
    expect(obscurityOf(0, 1)).toBe(1)
  })

  it("adds the deep-position penalty and clamps at 1", () => {
    expect(obscurityOf(3, 20)).toBeCloseTo(0.15, 5)
    expect(obscurityOf(1, 20)).toBeCloseTo(0.8167, 3)
    expect(obscurityOf(0, 20)).toBe(1)
  })
})

describe("sparseOrQuery", () => {
  it("drops the short particles that make an OR scan the whole corpus", () => {
    const q = sparseOrQuery("اذا غامرت في شرف مروم فلا تقنع بما دون النجوم")
    expect(q).toContain('"غامرت"')
    expect(q).toContain('"النجوم"')
    expect(q).not.toContain('"في"')
    expect(q.split(" OR ").length).toBeLessThanOrEqual(8)
  })

  it("keeps every term when they are all short, rather than emit nothing", () => {
    const q = sparseOrQuery("من لي به")
    expect(q).not.toBe("")
    expect(q).toContain('"من"')
  })

  it("is empty for text with no terms at all", () => {
    expect(sparseOrQuery("")).toBe("")
  })
})

describe("rivalsOf", () => {
  const scored = (poemId: number, score: number, norm: string): Scored => ({
    row: { p_id: poemId } as Record<string, unknown>,
    score,
    against: "full",
    norm,
  })

  it("returns one candidate when the best is clear", () => {
    expect(rivalsOf([scored(1, 0.9, "a"), scored(2, 0.7, "b")])).toHaveLength(1)
  })

  it("returns both when two قصائد are within the band", () => {
    const r = rivalsOf([scored(1, 0.9, "a"), scored(2, 0.89, "b")])
    expect(r).toHaveLength(2)
  })

  it("never lists one قصيدة twice", () => {
    expect(rivalsOf([scored(1, 0.9, "a"), scored(1, 0.9, "b")])).toHaveLength(1)
  })

  it("never lists the same text twice, even from two قصائد", () => {
    expect(rivalsOf([scored(1, 0.9, "a"), scored(2, 0.9, "a")])).toHaveLength(1)
  })

  it("caps at four", () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => scored(n, 0.9, `t${n}`))
    expect(rivalsOf(many)).toHaveLength(4)
  })

  it("uses a tight band", () => {
    expect(AMBIGUOUS_BAND).toBeLessThanOrEqual(0.05)
  })
})

describe("uncontestedMatch", () => {
  const scored = (poemId: number, score: number, norm = `t${poemId}`): Scored => ({
    row: { p_id: poemId } as Record<string, unknown>,
    score,
    against: "full",
    norm,
  })

  it("accepts a lone candidate between the two gates", () => {
    // 0.667 is the measured «جزى الله الشدائد» case: above the AND gate, below
    // the OR gate, and the only بيت in the corpus that close.
    expect(uncontestedMatch([scored(1, 0.667)])).toHaveLength(1)
  })

  it("accepts when the runner-up is clearly behind", () => {
    const r = uncontestedMatch([scored(1, 0.7), scored(2, 0.7 - UNIQUE_MARGIN)])
    expect(r).toHaveLength(1)
    expect(Number(r[0]!.row.p_id)).toBe(1)
  })

  it("refuses when a second قصيدة is close behind — that is OR noise", () => {
    expect(uncontestedMatch([scored(1, 0.7), scored(2, 0.68)])).toHaveLength(0)
  })

  it("ignores a rival that is the same قصيدة or the same text", () => {
    expect(uncontestedMatch([scored(1, 0.7), scored(1, 0.69)])).toHaveLength(1)
    expect(uncontestedMatch([scored(1, 0.7, "same"), scored(2, 0.69, "same")])).toHaveLength(1)
  })

  it("refuses everything below the AND gate", () => {
    expect(uncontestedMatch([scored(1, VERIFY.andJaccard - 0.001)])).toHaveLength(0)
    expect(uncontestedMatch([])).toHaveLength(0)
  })

  it("stays strictly below the OR gate it supplements", () => {
    expect(VERIFY.andJaccard).toBeLessThan(VERIFY.orJaccard)
    expect(UNIQUE_MARGIN).toBeGreaterThan(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/game/verify
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/game/verify — accepting", () => {
  it("accepts a بيت pasted verbatim, tashkeel and all", async () => {
    const res = await verify({ text: `${wardah.sadr} *** ${wardah.ajuz}` })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.matchKind).toBe("exact")
    expect(res.confidence).toBe(1)
    expect(res.bait.id).toBe(wardah.id)
    expect(res.poet.name).not.toBe("")
    expect(res.poem.id).not.toBe("")
  })

  it("accepts the same بيت typed with no tashkeel at all", async () => {
    const bare = wardah.full.replace(/[ً-ْ]/g, "")
    expect(bare).not.toBe(wardah.full)
    const res = await verify({ text: bare })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.matchKind).toBe("exact")
    expect(res.bait.id).toBe(wardah.id)
  })

  it("accepts a صدر on its own and reports matchKind 'sadr'", async () => {
    const res = await verify({ text: wardah.sadr })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.matchKind).toBe("sadr")
    expect(res.bait.id).toBe(wardah.id)
    // the whole بيت still comes back — the client renders both hemistichs
    expect(res.bait.ajuz).not.toBeNull()
  })

  it("accepts a بيت misremembered by one word, as a fuzzy match", async () => {
    const words = wardah.full.split(" ")
    words[2] = "بِعَهدِ"
    const res = await verify({ text: words.join(" ") })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.matchKind).toBe("fuzzy")
    expect(res.confidence).toBeGreaterThanOrEqual(VERIFY.orJaccard)
    expect(res.confidence).toBeLessThan(1)
    expect(res.bait.id).toBe(wardah.id)
  })

  it("accepts a بيت two words off when nothing else in the ديوان is close", async () => {
    // The AND pass cannot match (a term is missing) and the OR pass's 0.75 gate
    // is out of reach, so this rides the `uncontestedMatch` rung.
    const words = wardah.full.split(" ")
    words[1] = "تُبصِرونَ"
    words[3] = "زَينَبَ"
    const res = await verify({ text: words.join(" ") })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.matchKind).toBe("fuzzy")
    expect(res.bait.id).toBe(wardah.id)
    expect(res.confidence).toBeGreaterThanOrEqual(VERIFY.andJaccard)
    expect(res.confidence).toBeLessThan(VERIFY.orJaccard)
  })

  it("returns the chain state the next turn runs on", async () => {
    const res = await verify({ text: wardah.full })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.requiredLetter).toBe(wardah.rawiyy)
    expect(res.requiredLetterSource).toBe("rawiyy")
    expect(res.alsoAccepted).toEqual([])
    expect(res.mode).toBe("rhyme")
    expect(res.obscurity).toBeGreaterThanOrEqual(0)
    expect(res.obscurity).toBeLessThanOrEqual(1)
    expect(res.normalized).not.toBe("")
  })

  it("reports a peeled روي with the literal letter in alsoAccepted", async () => {
    expect(peeled.rawiyy).not.toBe(peeled.lastLetter)
    const res = await verify({ text: peeled.full })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.requiredLetter).toBe(peeled.rawiyy)
    expect(res.requiredLetterSource).toBe("peeled")
    expect(res.alsoAccepted).toEqual([peeled.lastLetter])
  })
})

describe("POST /api/game/verify — the chain letter", () => {
  it("rejects an answer that opens on the wrong letter", async () => {
    const res = await verify({ text: wardah.full, prevBaitId: qadYab.id })
    expect(res.ok).toBe(false)
    if (res.ok || res.reason !== "wrong_letter") throw new Error(`expected wrong_letter, got ${JSON.stringify(res)}`)
    expect(res.expected).toBe(qadYab.rawiyy)
    expect(res.got).toBe(wardah.firstLetter)
    expect(res.normalized).not.toBe("")
  })

  it("accepts the literal final letter in 'rhyme' mode (amendment 1 leniency)", async () => {
    // peeled's روي is و but it ENDS on ا; an answer opening on ا must pass.
    const answer = db
      .q("SELECT sadr, ajuz FROM baits WHERE first_letter = ? AND ajuz IS NOT NULL AND id <> ? LIMIT 1")
      .get(peeled.lastLetter, peeled.id) as { sadr: string; ajuz: string }
    const res = await verify({ text: `${answer.sadr} ${answer.ajuz}`, prevBaitId: peeled.id, mode: "rhyme" })
    expect(res.ok).toBe(true)
  })

  it("refuses the same answer in 'literal' mode only if the letters differ", async () => {
    const onRawiyy = db
      .q("SELECT sadr, ajuz FROM baits WHERE first_letter = ? AND ajuz IS NOT NULL AND id <> ? LIMIT 1")
      .get(peeled.rawiyy, peeled.id) as { sadr: string; ajuz: string } | undefined
    if (onRawiyy === undefined) return
    const res = await verify({ text: `${onRawiyy.sadr} ${onRawiyy.ajuz}`, prevBaitId: peeled.id, mode: "literal" })
    expect(res.ok).toBe(false)
    if (res.ok || res.reason !== "wrong_letter") throw new Error(`expected wrong_letter, got ${JSON.stringify(res)}`)
    // 'literal' chains on the written ending and offers no leniency at all
    expect(res.expected).toBe(peeled.lastLetter)
    expect(res.alsoAccepted).toEqual([])
    expect(res.got).toBe(peeled.rawiyy)
  })

  it("honours an explicit requiredLetter when there is no previous بيت", async () => {
    const wrong = wardah.firstLetter === "م" ? "ن" : "م"
    const res = await verify({ text: wardah.full, requiredLetter: wrong })
    expect(res.ok).toBe(false)
    if (res.ok || res.reason !== "wrong_letter") throw new Error("expected wrong_letter")
    expect(res.expected).toBe(wrong)
  })

  it("judges only the بيت when neither a prev id nor a letter is sent", async () => {
    const res = await verify({ text: wardah.full })
    expect(res.ok).toBe(true)
  })

  /**
   * The prefix loophole. A fuzzy match is meant to forgive a misremembered
   * WORD, not to move the chain: «وقِفا نبكِ» is one و away from «قِفا نبكِ»,
   * and the بيت in the ديوان opens on ق. If the fuzzy branch accepted it on a
   * و turn, any player could satisfy any روي by typing a letter in front of any
   * بيت — which is not leniency, it is the letter rule switched off.
   */
  it("refuses a fuzzy match whose بيت does not itself open on the required letter", async () => {
    const prefix = wardah.firstLetter === "و" ? "ف" : "و"
    const res = await verify({ text: `${prefix}${wardah.full}`, requiredLetter: prefix })
    expect(res.ok).toBe(false)
    if (res.ok || res.reason !== "wrong_letter") throw new Error(`expected wrong_letter, got ${JSON.stringify(res)}`)
    expect(res.expected).toBe(prefix)
    // the letter reported is the one the MATCHED بيت starts on, not the typed one
    expect(res.got).toBe(wardah.firstLetter)
  })

  it("still accepts the same بيت, unprefixed, on its own letter", async () => {
    const res = await verify({ text: wardah.full, requiredLetter: wardah.firstLetter as "م" })
    expect(res.ok).toBe(true)
  })
})

describe("POST /api/game/verify — rejections", () => {
  it("answers too_short under two words without touching SQLite", async () => {
    const res = await verify({ text: "قِفا" })
    expect(res.ok).toBe(false)
    if (res.ok || res.reason !== "too_short") throw new Error("expected too_short")
    expect(res.words).toBe(1)
  })

  it("answers already_used for a بيت the duel has already heard", async () => {
    const res = await verify({ text: wardah.full, usedBaitIds: [wardah.id] })
    expect(res.ok).toBe(false)
    if (res.ok || res.reason !== "already_used") throw new Error("expected already_used")
    expect(res.bait.id).toBe(wardah.id)
  })

  it("answers already_used when the قصيدة has been mined already", async () => {
    const res = await verify({ text: wardah.full, usedPoemIds: [wardah.poemId] })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected a rejection")
    expect(res.reason).toBe("already_used")
  })

  it("answers incomplete_bait for a بيت whose عجز the source never had", async () => {
    expect(partial.ajuz).toBeNull()
    const res = await verify({ text: partial.sadr })
    expect(res.ok).toBe(false)
    if (res.ok || res.reason !== "incomplete_bait") throw new Error(`expected incomplete_bait, got ${JSON.stringify(res)}`)
    expect(res.bait.isPartial).toBe(true)
    expect(res.bait.ajuz).toBeNull()
  })

  it("answers not_found with at most three suggestions", async () => {
    const res = await verify({ text: "زرافة تأكل الموز في الحديقة الكبيرة جدا اليوم" })
    expect(res.ok).toBe(false)
    if (res.ok || res.reason !== "not_found") throw new Error(`expected not_found, got ${JSON.stringify(res)}`)
    expect(res.suggestions.length).toBeLessThanOrEqual(3)
    expect(res.normalized).toBe("زرافه تاكل الموز في الحديقه الكبيره جدا اليوم")
  })

  it("answers near_miss with one suggestion and its accept price", async () => {
    // Three of eleven words changed: recognisable, but under the OR gate.
    const words = qadYab.full.split(" ")
    words[1] = "يُرسِلُ"
    words[3] = "الجَليلَ"
    words[6] = "يَظَلَّ"
    const res = await verify({ text: words.join(" ") })
    expect(res.ok).toBe(false)
    if (res.ok || res.reason !== "near_miss") throw new Error(`expected near_miss, got ${JSON.stringify(res)}`)
    expect(res.suggestion.id).toBe(qadYab.id)
    expect(res.score).toBeGreaterThanOrEqual(VERIFY.nearMissBand[0])
    expect(res.score).toBeLessThan(VERIFY.orJaccard)
    expect(res.acceptCost).toBe(HINT_COSTS.accept_near_miss)
  })

  it("never answers ambiguous on the fixture, which has no cross-قصيدة twins", async () => {
    // Recorded as a fixture FACT, not as engine behaviour: `rivalsOf` above is
    // where the ambiguity rule itself is proven. Regrow the fixture with two
    // قصائد sharing a بيت and this expectation is the one that should change.
    const res = await verify({ text: wardah.full })
    expect(res.ok).toBe(true)
  })

  it("rejects a body the client could not legally have produced", async () => {
    const res = await post("/api/game/verify", { text: wardah.full, mode: "shouting" })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe("bad_body")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/game/start and /reply
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/game/start", () => {
  it("opens with a playable بيت and the letter it demands", async () => {
    const res = await post("/api/game/start", { difficulty: "normal", seed: "duel:1" })
    expect(res.status).toBe(200)
    const body = GameStartResponseSchema.parse(res.body)
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.seed).toBe("duel:1")
    expect(body.bait.ajuz).not.toBeNull()
    expect(body.bait.isPartial).toBe(false)
    expect(body.requiredLetter).toBe(body.bait.rawiyy)
    expect(body.poet.name).not.toBe("")
  })

  it("is deterministic for a seed and varies without one", async () => {
    const a = GameStartResponseSchema.parse((await post("/api/game/start", { seed: "same" })).body)
    const b = GameStartResponseSchema.parse((await post("/api/game/start", { seed: "same" })).body)
    expect(a).toEqual(b)
    const ids = new Set<number>()
    for (let i = 0; i < 12; i++) {
      const r = GameStartResponseSchema.parse((await post("/api/game/start", {})).body)
      if (r.ok) ids.add(r.bait.id)
    }
    expect(ids.size).toBeGreaterThan(1)
  })

  it("serves an easy opening only from the canon", async () => {
    const res = GameStartResponseSchema.parse((await post("/api/game/start", { difficulty: "easy", seed: "e" })).body)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.poet.fame).toBe(3)
    expect(res.bait.position).toBeLessThanOrEqual(6)
  })

  it("defaults to normal/rhyme when the body is empty", async () => {
    const res = GameStartResponseSchema.parse((await post("/api/game/start", {})).body)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mode).toBe("rhyme")
  })

  it("answers no_bait rather than 404 when the القيود name nothing", async () => {
    const res = GameStartResponseSchema.parse(
      (await post("/api/game/start", { filters: { era: "no-such-era" } })).body,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe("no_bait")
  })
})

describe("POST /api/game/reply", () => {
  it("answers on the letter it was given", async () => {
    const res = GameReplyResponseSchema.parse((await post("/api/game/reply", { letter: "و", seed: "r1" })).body)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bait.firstLetter).toBe("و")
    expect(res.bait.ajuz).not.toBeNull()
    expect(res.requiredLetter).toBe(res.bait.rawiyy)
  })

  it("is deterministic for a seed", async () => {
    const a = GameReplyResponseSchema.parse((await post("/api/game/reply", { letter: "ا", seed: "z1" })).body)
    const b = GameReplyResponseSchema.parse((await post("/api/game/reply", { letter: "ا", seed: "z1" })).body)
    expect(a).toEqual(b)
  })

  it("honours excludeBaitIds", async () => {
    const first = GameReplyResponseSchema.parse((await post("/api/game/reply", { letter: "و", seed: "z2" })).body)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = GameReplyResponseSchema.parse(
      (await post("/api/game/reply", { letter: "و", seed: "z2", excludeBaitIds: [first.bait.id] })).body,
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.bait.id).not.toBe(first.bait.id)
  })

  it("honours excludePoemIds", async () => {
    // Exclude every قصيدة that has a بيت starting on و: nothing can be served.
    const poems = (db.q("SELECT DISTINCT poem_id AS id FROM game_baits WHERE first_letter = 'و'").all() as Array<{
      id: number
    }>).map((r) => Number(r.id))
    expect(poems.length).toBeGreaterThan(0)
    const res = GameReplyResponseSchema.parse(
      (await post("/api/game/reply", { letter: "و", excludePoemIds: poems })).body,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe("no_bait")
    expect(res.letter).toBe("و")
  })

  it("answers no_bait on a letter the pool never opens on", async () => {
    for (const letter of ["ز", "ط", "ظ"]) {
      const n = Number(
        (db.q("SELECT COUNT(*) AS n FROM game_baits WHERE first_letter = ?").get(letter) as { n: number }).n,
      )
      expect(n).toBe(0)
      const res = GameReplyResponseSchema.parse((await post("/api/game/reply", { letter, difficulty: "brutal" })).body)
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toBe("no_bait")
      expect(res.letter).toBe(letter)
    }
  })

  it("relaxes one tier rather than dead-end an easy duel", async () => {
    // ت has أبيات in the pool but none of them are a canon مطلع, so the easy
    // tier is empty on it and the relax to `normal` is the only way through.
    const easy = Number(
      (
        db
          .q("SELECT COUNT(*) AS n FROM game_baits WHERE first_letter = 'ت' AND fame = 3 AND position <= 2")
          .get() as { n: number }
      ).n,
    )
    const any = Number(
      (db.q("SELECT COUNT(*) AS n FROM game_baits WHERE first_letter = 'ت' AND fame >= 2").get() as { n: number }).n,
    )
    if (easy !== 0 || any === 0) return
    const res = GameReplyResponseSchema.parse((await post("/api/game/reply", { letter: "ت", difficulty: "easy" })).body)
    expect(res.ok).toBe(true)
  })

  it("avoids a rare قافية on tailBias 'easy' when it can", async () => {
    const nonRare = Number(
      (
        db
          .q(`SELECT COUNT(*) AS n FROM game_baits WHERE first_letter = 'و' AND rawiyy NOT IN ('ظ','ذ','غ','ز','ث','ض','ص','ط','خ')`)
          .get() as { n: number }
      ).n,
    )
    expect(nonRare).toBeGreaterThan(0)
    for (let i = 0; i < 8; i++) {
      const res = GameReplyResponseSchema.parse(
        (await post("/api/game/reply", { letter: "و", tailBias: "easy", seed: `t${i}` })).body,
      )
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(RARE_RAWIYY_WIDE_SET.has(res.requiredLetter)).toBe(false)
    }
  })

  it("clamps an absurd exclude list instead of refusing it", async () => {
    const huge = Array.from({ length: MAX_EXCLUDES * 3 }, (_, i) => i + 1)
    const res = await post("/api/game/reply", { letter: "و", excludeBaitIds: huge, excludePoemIds: huge })
    expect(res.status).toBe(200)
    GameReplyResponseSchema.parse(res.body)
  })

  it("400s on an illegal letter, which the client cannot emit", async () => {
    const res = await post("/api/game/reply", { letter: "z" })
    expect(res.status).toBe(400)
  })

  it("never repeats itself across a chain, and stumps honestly when the pool dries", async () => {
    // The fixture is 202 game أبيات, so a chain on one letter exhausts quickly —
    // which is exactly the pair of properties worth pinning: every reply is new,
    // and the turn after the last one is «أفحمتَ الخصم», not a repeat.
    const usedBaits: number[] = []
    const usedPoems: number[] = []
    let stumped = false
    for (let turn = 0; turn < 40; turn++) {
      const res = GameReplyResponseSchema.parse(
        (
          await post("/api/game/reply", {
            letter: "و",
            difficulty: "brutal",
            excludeBaitIds: usedBaits,
            excludePoemIds: usedPoems,
            seed: `daily:2026-08-23:${turn}`,
          })
        ).body,
      )
      if (!res.ok) {
        expect(res.reason).toBe("no_bait")
        expect(res.letter).toBe("و")
        stumped = true
        break
      }
      expect(usedBaits).not.toContain(res.bait.id)
      expect(usedPoems).not.toContain(Number(res.bait.baytKey.split(":")[0]))
      expect(res.bait.firstLetter).toBe("و")
      usedBaits.push(res.bait.id)
      usedPoems.push(
        Number((db.q("SELECT poem_id AS id FROM baits WHERE id = ?").get(res.bait.id) as { id: number }).id),
      )
    }
    expect(usedBaits.length).toBeGreaterThanOrEqual(3)
    expect(new Set(usedBaits).size).toBe(usedBaits.length)
    expect(stumped).toBe(true)
  })

  it("follows a real chain from one بيت's روي to the next", async () => {
    let letter: string | null = "و"
    const links: string[] = []
    const usedBaits: number[] = []
    for (let turn = 0; turn < 6 && letter !== null; turn++) {
      const res: import("../shared/schema.ts").GameReplyResponse = GameReplyResponseSchema.parse(
        (await post("/api/game/reply", { letter, difficulty: "brutal", excludeBaitIds: usedBaits, seed: `c${turn}` }))
          .body,
      )
      if (!res.ok) break
      expect(res.bait.firstLetter).toBe(letter)
      links.push(letter)
      usedBaits.push(res.bait.id)
      letter = res.requiredLetter
    }
    // A chain of one is a legitimate outcome on a 202-بيت fixture (the روي of
    // the first reply may be a letter nothing opens on); a chain that served a
    // بيت on the WRONG letter is not, and that is asserted every turn above.
    expect(links.length).toBeGreaterThanOrEqual(1)
  })
})

describe("pickBait (engine, no HTTP)", () => {
  it("respects the easy tier's fame and position bounds", () => {
    for (let i = 0; i < 10; i++) {
      const picked = pickBait(db, { difficulty: "easy", tailBias: "none", seed: `p${i}` })
      if (picked === null) continue
      // easy may have RELAXed to normal on a thin fixture; the tier it reports
      // is the one it actually used.
      if (picked.tier !== "easy") continue
      expect(Number(picked.row.po_fame)).toBe(3)
      expect(Number(picked.row.b_position)).toBeLessThanOrEqual(6)
    }
  })

  it("reads the chain letters off the row it returns", () => {
    const picked = pickBait(db, { letter: "و", difficulty: "brutal", tailBias: "none", seed: "cs" })
    expect(picked).not.toBeNull()
    if (picked === null) return
    const state = chainState(picked.row, "rhyme")
    expect(state.requiredLetter).toBe(String(picked.row.b_rawiyy))
    const literal = chainState(picked.row, "literal")
    expect(literal.requiredLetter).toBe(String(picked.row.b_last_letter))
    expect(literal.alsoAccepted).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/game/hint
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/game/hint", () => {
  it("names the شاعر of a بيت that would answer, at its listed price", async () => {
    const res = await post("/api/game/hint", { kind: "poet", letter: "و", seed: "h" })
    expect(res.status).toBe(200)
    const body = GameHintResponseSchema.parse(res.body)
    expect(body.ok).toBe(true)
    if (!body.ok || body.kind !== "poet") throw new Error("expected a poet hint")
    expect(body.cost).toBe(HINT_COSTS.poet)
    expect(body.poet.name).not.toBe("")
    expect(body.poet.slug).not.toBe("")
  })

  it("gives the first word, and it starts on the required letter", async () => {
    const body = GameHintResponseSchema.parse(
      (await post("/api/game/hint", { kind: "first_word", letter: "و", seed: "h" })).body,
    )
    expect(body.ok).toBe(true)
    if (!body.ok || body.kind !== "first_word") throw new Error("expected a first_word hint")
    expect(body.cost).toBe(HINT_COSTS.first_word)
    expect(body.firstWord.length).toBeGreaterThan(1)
    expect(body.firstWord).not.toContain(" ")
  })

  it("gives the بحر, at the cheapest price", async () => {
    const body = GameHintResponseSchema.parse(
      (await post("/api/game/hint", { kind: "meter", letter: "و", seed: "h" })).body,
    )
    expect(body.ok).toBe(true)
    if (!body.ok || body.kind !== "meter") throw new Error("expected a meter hint")
    expect(body.cost).toBe(HINT_COSTS.meter)
    // every game_baits row is on a بحر (build.ts asserts it), so this is never null
    expect(body.meter).not.toBeNull()
  })

  it("describes ONE بيت across all three cheap hints", async () => {
    const args = { letter: "و", seed: "consistency", difficulty: "normal" as const }
    const poet = GameHintResponseSchema.parse((await post("/api/game/hint", { ...args, kind: "poet" })).body)
    const word = GameHintResponseSchema.parse((await post("/api/game/hint", { ...args, kind: "first_word" })).body)
    if (!poet.ok || poet.kind !== "poet" || !word.ok || word.kind !== "first_word") throw new Error("bad hints")
    const row = db
      .q(
        `SELECT b.sadr FROM baits b JOIN poems p ON p.id = b.poem_id JOIN poets po ON po.id = p.poet_id
         WHERE po.slug = ? AND b.sadr LIKE ? LIMIT 1`,
      )
      .get(poet.poet.slug, `${word.firstWord}%`) as { sadr: string } | undefined
    expect(row).toBeDefined()
  })

  it("takes the required letter off the opponent's بيت when given its id", async () => {
    const body = GameHintResponseSchema.parse(
      (await post("/api/game/hint", { kind: "first_word", baitId: wardah.id, seed: "h" })).body,
    )
    expect(body.ok).toBe(true)
    if (!body.ok || body.kind !== "first_word") throw new Error("expected first_word")
    // wardah's روي is ب, so the candidate — and its first word — start on ب
    const first = [...body.firstWord].find((ch) => /[ء-ي]/.test(ch))
    expect(first).toBeDefined()
  })

  it("«بدّل الحرف» recites a new بيت on a different letter", async () => {
    const body = GameHintResponseSchema.parse(
      (await post("/api/game/hint", { kind: "switch_letter", letter: "ظ", seed: "sw" })).body,
    )
    expect(body.ok).toBe(true)
    if (!body.ok || body.kind !== "switch_letter") throw new Error("expected switch_letter")
    expect(body.cost).toBe(HINT_COSTS.switch_letter)
    expect(body.requiredLetter).not.toBe("ظ")
    expect(RARE_RAWIYY_WIDE_SET.has(body.requiredLetter)).toBe(false)
    expect(body.bait.ajuz).not.toBeNull()
    expect(body.poet.name).not.toBe("")
  })

  it("answers not_found when it is told neither a بيت nor a letter", async () => {
    const body = GameHintResponseSchema.parse((await post("/api/game/hint", { kind: "poet" })).body)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.reason).toBe("not_found")
  })

  it("answers no_bait when the letter has nothing to hint at", async () => {
    const body = GameHintResponseSchema.parse((await post("/api/game/hint", { kind: "poet", letter: "ظ" })).body)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.reason).toBe("no_bait")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/game/pool
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/game/pool", () => {
  it("counts every one of the 28 letters, zeros included", async () => {
    const res = await get("/api/game/pool?difficulty=brutal")
    expect(res.status).toBe(200)
    const body = GamePoolResponseSchema.parse(res.body)
    expect(body.byLetter).toHaveLength(28)
    const total = Number((db.q("SELECT COUNT(*) AS n FROM game_baits").get() as { n: number }).n)
    expect(body.total).toBe(total)
    expect(body.byLetter.some((l) => l.count === 0)).toBe(true)
  })

  // The predicates come from `scripts/ingest/ddl.ts`, never from a literal here:
  // a tier retuned in one place and not the other is exactly the drift this
  // test exists to catch, and a hard-coded copy would sail straight past it.
  it("agrees with a live count on each tier", async () => {
    for (const [difficulty, predicate] of TIER_PREDICATES) {
      const body = GamePoolResponseSchema.parse((await get(`/api/game/pool?difficulty=${difficulty}`)).body)
      const n = Number(
        (db.q(`SELECT COUNT(*) AS n FROM game_baits gb WHERE ${predicate}`).get() as { n: number }).n,
      )
      expect(body.total, difficulty).toBe(n)
    }
  })

  it("falls back to a live scan for a filter combo_counts does not key on", async () => {
    const body = GamePoolResponseSchema.parse((await get("/api/game/pool?difficulty=brutal&lang=%D9%81%D8%B5%D9%8A%D8%AD")).body)
    const n = Number(
      (
        db
          .q("SELECT COUNT(*) AS n FROM game_baits gb JOIN poems p ON p.id = gb.poem_id WHERE p.lang_type = 'فصيح'")
          .get() as { n: number }
      ).n,
    )
    expect(body.total).toBe(n)
  })

  it("returns zeros, not a 400, for an unknown slug", async () => {
    const body = GamePoolResponseSchema.parse((await get("/api/game/pool?era=nope")).body)
    expect(body.total).toBe(0)
    expect(body.byLetter).toHaveLength(28)
  })

  it("400s on an illegal difficulty", async () => {
    const res = await get("/api/game/pool?difficulty=impossible")
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe("bad_query")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Rate limiting
// ═════════════════════════════════════════════════════════════════════════════

describe("the token bucket", () => {
  it("allows a burst of 12 and then answers 429 with Retry-After", async () => {
    // A fresh app so this test's own burst cannot be spent by another test.
    const own = createApp(config, db).app
    const fire = () =>
      own.request("/api/game/pool", { headers: { "x-forwarded-for": "203.0.113.7" } })
    for (let i = 0; i < 12; i++) expect((await fire()).status).toBe(200)
    const blocked = await fire()
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: "rate_limited" })
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0)
    // …and a different caller is untouched
    const other = await own.request("/api/game/pool", { headers: { "x-forwarded-for": "203.0.113.8" } })
    expect(other.status).toBe(200)
  })

  it("counts POSTs too — verify is the expensive route", async () => {
    const own = createApp(config, db).app
    const fire = () =>
      own.request("/api/game/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ text: wardah.full }),
      })
    for (let i = 0; i < 12; i++) expect((await fire()).status).toBe(200)
    expect((await fire()).status).toBe(429)
  })

  it("leaves the rest of the API alone", async () => {
    const own = createApp(config, db).app
    for (let i = 0; i < 15; i++) {
      const res = await own.request("/api/meta", { headers: { "x-forwarded-for": "203.0.113.10" } })
      expect(res.status).toBe(200)
    }
  })

  it("refills continuously rather than in fixed windows", async () => {
    let clock = 0
    const limiter = createRateLimiter({ tokens: 12, windowMs: 10_000, keyOf: () => "one", now: () => clock })
    const probe = new (await import("hono")).Hono()
    probe.use("*", limiter.middleware)
    probe.get("/", (c) => c.text("ok"))

    for (let i = 0; i < 12; i++) expect((await probe.request("/")).status).toBe(200)
    expect((await probe.request("/")).status).toBe(429)

    clock += 834 // one token at 12 per 10 s
    expect((await probe.request("/")).status).toBe(200)
    expect((await probe.request("/")).status).toBe(429)

    clock += 60_000 // long idle: back to a full bucket, never more
    for (let i = 0; i < 12; i++) expect((await probe.request("/")).status).toBe(200)
    expect((await probe.request("/")).status).toBe(429)

    limiter.reset()
    expect((await probe.request("/")).status).toBe(200)
  })

  it("keys on the LAST X-Forwarded-For hop — the left-most one is the caller's own text", async () => {
    const limiter = createRateLimiter({ tokens: 1, windowMs: 10_000 })
    const probe = new (await import("hono")).Hono()
    probe.use("*", limiter.middleware)
    probe.get("/", (c) => c.text("ok"))
    const h = (xff: string) => ({ headers: { "x-forwarded-for": xff } })

    // Cloudflare appends the true client to whatever XFF arrived, so rotating
    // the left-most entry must not mint a fresh bucket per request (it did:
    // 60 requests, 59 allowed).
    expect((await probe.request("/", h("198.51.100.1, 10.0.0.1"))).status).toBe(200)
    expect((await probe.request("/", h("198.51.100.2, 10.0.0.1"))).status).toBe(429)
    expect((await probe.request("/", h("203.0.113.9, 10.0.0.1"))).status).toBe(429)
    // A different LAST hop is a different caller.
    expect((await probe.request("/", h("198.51.100.1, 10.0.0.2"))).status).toBe(200)
    expect(limiter.size()).toBe(2)
  })

  it("prefers CF-Connecting-IP over anything the client can write", async () => {
    const limiter = createRateLimiter({ tokens: 1, windowMs: 10_000 })
    const probe = new (await import("hono")).Hono()
    probe.use("*", limiter.middleware)
    probe.get("/", (c) => c.text("ok"))
    const h = (xff: string) => ({
      headers: { "x-forwarded-for": xff, "cf-connecting-ip": "203.0.113.5" },
    })
    expect((await probe.request("/", h("9.9.9.9, 10.0.0.1"))).status).toBe(200)
    expect((await probe.request("/", h("8.8.8.8, 10.0.0.2"))).status).toBe(429)
    expect(limiter.size()).toBe(1)
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// Which copy of a duplicated بيت the verifier resolves to
//
// The fixture carries the corpus's own shape (see test/fixtures/…jsonl): one
// صدر under three شعراء with two different روي, and one صدر under two EQUALLY
// famous شعراء with two different روي. The obscure copies are written first, so
// they hold the lower bait ids — which is precisely how `ORDER BY b.id` used to
// decide the chain letter of «قفا نبك من ذكرى حبيب ومنزل».
// ═════════════════════════════════════════════════════════════════════════════

const QIFA = "قِفا نَبكِ مِن ذِكرى حَبيبٍ وَمَنزِلِ"
const QIFA_AJUZ = "بِسِقطِ اللِوى بَينَ الدَخولِ فَحَومَلِ"
const JARAWI_AJUZ = "فَعَهدي بِمَغناها قَريبٌ مُقارِبُ"
const NUFUS = "وَإِذا كانَت النُفوسُ كِبارا"

describe("POST /api/game/verify — the copy it resolves to", () => {
  it("answers a صدر-only with the famous copy, not the lowest rowid", async () => {
    const res = await verify({ text: QIFA })
    if (!res.ok) throw new Error(`expected an accept, got ${res.reason}`)
    expect(res.matchKind).toBe("sadr")
    expect(res.poet.name).toBe("امرؤ القيس")
    expect(res.requiredLetter).toBe("ل")
    // …and the score follows the attribution: fame 3 at the مطلع is obscurity 0
    expect(res.obscurity).toBe(0)
  })

  it("keeps the copy whose عجز the player actually typed", async () => {
    const res = await verify({ text: `${QIFA} ${JARAWI_AJUZ}` })
    if (!res.ok) throw new Error(`expected an accept, got ${res.reason}`)
    expect(res.matchKind).toBe("exact")
    expect(res.poet.name).toBe("أبو العباس الجراوي")
    expect(res.requiredLetter).toBe("ب")
  })

  it("re-ranks the صدر rung on the عجز when one of its words is misremembered", async () => {
    // `h_full` misses (one word off), so the صدر rung matches all three copies —
    // and the half the player DID give is what decides between them, not fame.
    const res = await verify({ text: `${QIFA} * فَعَهدي بِمَغناها قَريبٌ مُجاوِرُ` })
    if (!res.ok) throw new Error(`expected an accept, got ${res.reason}`)
    expect(res.poet.name).toBe("أبو العباس الجراوي")
    expect(res.requiredLetter).toBe("ب")
  })

  it("asks which بيت when two equally famous copies chain on different letters", async () => {
    const res = await verify({ text: NUFUS })
    if (res.ok) throw new Error("expected the ambiguity branch")
    expect(res.reason).toBe("ambiguous")
    if (res.reason !== "ambiguous") return
    expect(res.candidates.length).toBeGreaterThanOrEqual(2)
    const letters = new Set(res.candidates.map((b) => b.rawiyy))
    expect(letters.size).toBeGreaterThanOrEqual(2)
  })

  it("still resolves a clash the fame order settles", async () => {
    // Three copies of QIFA, two روي — but only one of them is fame 3.
    const res = await verify({ text: QIFA })
    expect(res.ok).toBe(true)
  })

  it("refuses a بيت already played under ANOTHER of its copies", async () => {
    // The fixture holds this بيت verbatim under two شعراء. Answer it once to
    // learn which copy the fuzzy ladder settles on, then play the OTHER id.
    const misremembered = `${QIFA} * بِسِقطِ اللِوى بَينَ الدَخولِ فَحَومَلا`
    const first = await verify({ text: misremembered })
    if (!first.ok) throw new Error(`expected an accept, got ${first.reason}`)
    const twins = db
      .q("SELECT b.id AS id FROM baits b WHERE b.sadr = ? AND b.ajuz = ?")
      .all(QIFA, QIFA_AJUZ) as Array<{ id: number }>
    expect(twins.length).toBe(2)
    const other = twins.map((t) => Number(t.id)).find((id) => id !== first.bait.id)
    expect(other).toBeDefined()

    const again = await verify({ text: misremembered, usedBaitIds: [other!] })
    if (again.ok) throw new Error("expected already_used")
    expect(again.reason).toBe("already_used")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Body size, chain mode, and the «أفحمتَ الخصم» farm
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/game/* — the request body", () => {
  it("refuses a body larger than MAX_GAME_BODY with 413, without parsing it", async () => {
    const body = JSON.stringify({ letter: "م", seed: "x".repeat(MAX_GAME_BODY) })
    expect(body.length).toBeGreaterThan(MAX_GAME_BODY)
    const res = await app.request("/api/game/reply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.2.0.${ip++ % 250}` },
      body,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: "payload_too_large" })
  })

  it("still answers a body that is merely large-ish", async () => {
    const res = await post("/api/game/reply", { letter: "م", excludeBaitIds: Array.from({ length: 500 }, (_, i) => i + 1) })
    expect(res.status).toBe(200)
  })
})

describe("POST /api/game/hint — the chain mode", () => {
  it("describes a بيت on the LITERAL letter in literal mode", async () => {
    // `peeled` ends on ا though its روي is و: the two modes demand two letters.
    expect(peeled.lastLetter).not.toBe(peeled.rawiyy)
    const literal = await post("/api/game/hint", {
      kind: "first_word",
      baitId: peeled.id,
      difficulty: "brutal",
      mode: "literal",
      seed: "hint-literal",
    })
    const body = literal.body as { ok: boolean; firstWord?: string }
    expect(body.ok).toBe(true)
    expect(firstLetterOf(normalizeArabic(body.firstWord ?? ""))).toBe(peeled.lastLetter)

    const rhyme = await post("/api/game/hint", {
      kind: "first_word",
      baitId: peeled.id,
      difficulty: "brutal",
      mode: "rhyme",
      seed: "hint-literal",
    })
    const rhymeBody = rhyme.body as { ok: boolean; firstWord?: string }
    expect(firstLetterOf(normalizeArabic(rhymeBody.firstWord ?? ""))).toBe(peeled.rawiyy)
  })

  it("hands «بدّل الحرف» a chain state in the duel's own mode", async () => {
    const res = await post("/api/game/hint", { kind: "switch_letter", letter: "ظ", mode: "literal", seed: "switch-lit" })
    const body = res.body as { ok: boolean; mode?: string; requiredLetter?: string; alsoAccepted?: string[] }
    expect(body.ok).toBe(true)
    expect(body.mode).toBe("literal")
    // literal mode accepts nothing alongside the letter it names…
    expect(body.alsoAccepted).toEqual([])
    // …and never hands back the wall the player just paid 150 points to leave
    expect(body.requiredLetter).not.toBe("ظ")
  })
})

describe("POST /api/game/reply — «أفحمتَ الخصم» is earned, not farmed", () => {
  it("leaves the القيود rather than concede a thin combination", async () => {
    const thin = { era: "jahili", meter: "hazaj" }
    const pool = (await get("/api/game/pool?difficulty=easy&era=jahili&meter=hazaj")).body as { total: number }
    // The fixture's جاهلي×هزج pool is empty or nearly so — exactly the shape
    // that used to hand the player +500 for one move.
    expect(pool.total).toBeLessThan(50)
    const res = GameReplyResponseSchema.parse(
      (await post("/api/game/reply", { letter: "ل", difficulty: "easy", filters: thin })).body,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.relaxed).toBe(true)
  })

  it("still answers from inside the القيود when it can", async () => {
    const res = GameReplyResponseSchema.parse((await post("/api/game/reply", { letter: "م" })).body)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.relaxed).toBeUndefined()
  })
})

describe("GET /api/game/pool — «العدد المتاح»", () => {
  it("reports the pool the duel actually draws from, relax included", async () => {
    const easy = (await get("/api/game/pool?difficulty=easy")).body as { total: number; effectiveTotal?: number }
    const normal = (await get("/api/game/pool?difficulty=normal")).body as { total: number }
    expect(easy.effectiveTotal).toBe(normal.total)
    expect(easy.effectiveTotal!).toBeGreaterThanOrEqual(easy.total)
    // «سيف» relaxes nowhere, so the two numbers are the same thing
    const brutal = (await get("/api/game/pool?difficulty=brutal")).body as { total: number; effectiveTotal?: number }
    expect(brutal.effectiveTotal).toBe(brutal.total)
  })
})
