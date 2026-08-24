/**
 * The duel's UI layer, headless. Everything under test here is either a pure
 * function (tiers, timings, share text, the daily rules) or a component that
 * paints its first frame from props alone — so `react-dom/server` is enough
 * and no DOM is needed, the same bargain BaytPlate.test.ts strikes.
 *
 * Written with `createElement` rather than JSX so the file stays a `.ts` and
 * matches vite.config.ts's `*.test.ts` include glob.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { HINT_COSTS, ExchangeSchema, TIER_DIFFICULTY, type Exchange } from "../../shared/schema.ts"
import { MUBARAZA_EXCHANGES } from "../../shared/constants.ts"
import { RLM } from "../../shared/format.ts"
import { clampTier, configFor, presetOf, tierAllowed, TIER_PRESETS } from "./tiers.ts"
import { REVEAL, revealTiming, wordCount } from "./RecitationReveal.tsx"
import { ExchangeLog, poetRevealed } from "./ExchangeLog.tsx"
import { COSTS_LIFE, RejectionCard, titleOf } from "./RejectionCard.tsx"
import { LetterIndicator, clauseFor, typedLetter, verdictOf } from "./LetterIndicator.tsx"
import { arabicDay, letterRibbon, MONTHS_AR, shareText } from "./share.ts"
import { dailyConfig, playedToday, riyadhDay } from "./daily.ts"
import { headlineOf, lettersGained, poetsOf } from "./DuelSummaryView.tsx"
import { pricedHint } from "./scoring.ts"
import type { DuelState, Rejection } from "./machine.ts"
import { newDuel } from "./machine.ts"

// ── fixtures ────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000

function ex(over: Partial<Exchange> = {}): Exchange {
  return ExchangeSchema.parse({
    side: "opponent",
    baytKey: "q101:1",
    sadr: "عَلى قَدرِ أَهلِ العَزمِ تَأتي العَزائِمُ",
    ajuz: "وَتَأتي عَلى قَدرِ الكِرامِ المَكارِمُ",
    poemId: "q101",
    poet: { slug: "mutanabi", name: "المتنبي" },
    requiredLetter: "م",
    ...over,
  })
}

function bait(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    baytKey: "q77:2",
    position: 2,
    sadr: "ما كُلُّ ما يَتَمَنّى المَرءُ يُدرِكُهُ",
    ajuz: "تَجري الرِياحُ بِما لا تَشتَهي السُفُنُ",
    rawiyy: "ن",
    lastLetter: "ن",
    firstLetter: "م",
    isPartial: false,
    poem: { id: "q77", title: "قصيدة" },
    poet: { slug: "mutanabi", name: "المتنبي" },
    meter: { slug: "basit", name: "البسيط", variant: null },
    era: null,
    ...over,
  } as never
}

function stateWith(exchanges: Exchange[]): DuelState {
  const s = newDuel(configFor("poet", { timer: true, format: "endless", chainMode: "rhyme", filters: {} }), "seed", T0)
  return { ...s, exchanges }
}

// ── tiers (design-ux.md §4 Setup) ──────────────────────────────────────────

describe("the four رتب", () => {
  it("carries the doc's parameters, in order", () => {
    expect(TIER_PRESETS.map((t) => t.tier)).toEqual(["beginner", "poet", "champion", "sword"])
    expect(TIER_PRESETS.map((t) => t.seconds)).toEqual([60, 40, 25, 15])
    expect(TIER_PRESETS.map((t) => t.lives)).toEqual([3, 3, 2, 1])
  })

  it("maps every رتبة to the server difficulty schema.ts declares", () => {
    for (const t of TIER_PRESETS) expect(t.difficulty).toBe(TIER_DIFFICULTY[t.tier])
  })

  it("sets tailBias as the real difficulty lever (amendments.md §5)", () => {
    expect(presetOf("beginner").tailBias).toBe("easy")
    expect(presetOf("poet").tailBias).toBe("none")
    expect(presetOf("champion").tailBias).toBe("hard")
    expect(presetOf("sword").tailBias).toBe("hard")
  })

  it("prices hints per tier: مبتدئ half, فحل double, سيف none", () => {
    expect(pricedHint("poet", "beginner")).toBe(HINT_COSTS.poet / 2)
    expect(pricedHint("poet", "champion")).toBe(HINT_COSTS.poet * 2)
    expect(presetOf("sword").hints).toContain("لا همس")
  })

  it("turning the clock off forbids فحل and سيف, and demotes to شاعر", () => {
    expect(tierAllowed("champion", true)).toBe(true)
    expect(tierAllowed("champion", false)).toBe(false)
    expect(clampTier("sword", false)).toBe("poet")
    expect(clampTier("beginner", false)).toBe("beginner")
  })

  it("builds a whole config from a رتبة plus the three switches", () => {
    const c = configFor("champion", { timer: true, format: "match", chainMode: "literal", filters: { era: "abbasi" } })
    expect(c).toMatchObject({
      tier: "champion",
      difficulty: "hard",
      tailBias: "hard",
      turnSeconds: 25,
      lives: 2,
      format: "match",
      chainMode: "literal",
      filters: { era: "abbasi" },
    })
  })

  it("a clock-less سيف silently becomes a clock-less شاعر, not a 15s سيف", () => {
    const c = configFor("sword", { timer: false, format: "endless", chainMode: "rhyme", filters: {} })
    expect(c.tier).toBe("poet")
    expect(c.lives).toBe(3)
    expect(c.timer).toBe(false)
  })
})

// ── the recitation (design-ux.md §4 Play) ──────────────────────────────────

describe("progressive reveal timing", () => {
  it("counts words the way the mask steps", () => {
    expect(wordCount("  عَلى   قَدرِ أَهلِ ")).toBe(3)
    expect(wordCount(null)).toBe(0)
  })

  it("is 55ms/word + a 180ms fade, with a 400ms caesura between الشطرين", () => {
    const t = revealTiming("واحد اثنان ثلاثة", "أربعة خمسة")
    expect(t.sadrWords).toBe(3)
    expect(t.ajuzWords).toBe(2)
    expect(t.sadrMs).toBe(3 * REVEAL.perWord + REVEAL.fade)
    expect(t.caesuraMs).toBe(REVEAL.caesura)
    expect(t.totalMs).toBe(t.sadrMs + t.caesuraMs + t.ajuzMs)
  })

  it("has no caesura and no second sweep when there is no عجز", () => {
    const t = revealTiming("شطر وحيد", null)
    expect(t.ajuzMs).toBe(0)
    expect(t.caesuraMs).toBe(0)
    expect(t.totalMs).toBe(t.sadrMs)
  })

  it("never lets a whole بيت take longer than a turn's grace", () => {
    // the longest hemistich in the corpus is 80 chars ≈ 14 words (PLAYABLE)
    expect(revealTiming("و ".repeat(14), "و ".repeat(14)).totalMs).toBeLessThan(3000)
  })
})

// ── the transcript ─────────────────────────────────────────────────────────

describe("the exchange log", () => {
  it("hides the شاعر of the بيت still standing, and names it once answered", () => {
    const rows = [ex(), ex({ side: "player", baytKey: "q102:1", requiredLetter: "ن" }), ex({ baytKey: "q103:1" })]
    expect(poetRevealed(rows, 0, false)).toBe(true) // the player answered it
    expect(poetRevealed(rows, 2, false)).toBe(false) // this one is still standing
    expect(poetRevealed(rows, 2, true)).toBe(true) // …until the duel ends
  })

  it("renders the opponent with the lapis side and «الخصم» before it resolves", () => {
    const html = renderToStaticMarkup(createElement(ExchangeLog, { exchanges: [ex()] }))
    expect(html).toContain('data-side="them"')
    expect(html).toContain("الخصم")
    expect(html).not.toContain("المتنبي")
  })

  it("renders your بيت with the gold side, the شاعر and the award", () => {
    const html = renderToStaticMarkup(
      createElement(ExchangeLog, { exchanges: [ex({ side: "player", award: 140 })], ended: true }),
    )
    expect(html).toContain('data-side="you"')
    expect(html).toContain("المتنبي")
    // scores are Latin tabular-nums (design-ux.md §2), unlike verse numbers
    expect(html).toContain("+140")
  })

  it("keys every plate by baytKey so a rejection can scroll back to it", () => {
    const html = renderToStaticMarkup(createElement(ExchangeLog, { exchanges: [ex()] }))
    expect(html).toContain('data-exchange-key="q101:1"')
  })
})

// ── the letter indicator (the most important element) ──────────────────────

describe("the letter indicator", () => {
  it("derives the typed letter through the ONE normalizer", () => {
    expect(typedLetter("أَحْمَدُ")).toBe("ا")
    expect(typedLetter("   ")).toBe(null)
  })

  it("accepts the required letter and the leniency set, and only those", () => {
    expect(verdictOf("م", [], "م")).toBe("match")
    expect(verdictOf("م", ["ه"], "ه")).toBe("lenient")
    expect(verdictOf("م", ["ه"], "ن")).toBe("miss")
    expect(verdictOf("م", [], null)).toBe("empty")
  })

  it("says the وصل clause only when a وصل was actually peeled", () => {
    expect(clauseFor("ب", "rawiyy", [], "rhyme")).toBe(null)
    expect(clauseFor("ب", "peeled", ["ه"], "rhyme")).toContain("هاءً")
    expect(clauseFor("ب", "rawiyy", [], "literal")).toContain("الحرف الأخير")
  })

  it("paints the required letter and the ghost chips", () => {
    const html = renderToStaticMarkup(
      createElement(LetterIndicator, {
        required: "م",
        source: "peeled",
        alsoAccepted: ["ه"],
        mode: "rhyme",
        draft: "مَن ذا",
        msLeft: 12_000,
        turnMs: 40_000,
      }),
    )
    expect(html).toContain('data-verdict="match"')
    expect(html).toContain("letter-well__glyph")
    expect(html).toContain("letter-ghost")
    expect(html).toContain("letter-arc")
  })

  it("marks the danger tone in the last two seconds", () => {
    const html = renderToStaticMarkup(
      createElement(LetterIndicator, {
        required: "م",
        source: "rawiyy",
        alsoAccepted: [],
        mode: "rhyme",
        draft: "",
        msLeft: 1_500,
        turnMs: 40_000,
      }),
    )
    expect(html).toContain('data-tone="danger"')
  })
})

// ── rejections ─────────────────────────────────────────────────────────────

const REJECTIONS: Rejection[] = [
  { kind: "wrong_letter", expected: "ن", alsoAccepted: [], got: "م", normalized: "ما كل ما يتمنى" },
  { kind: "already_used", bait: bait() },
  { kind: "not_found", normalized: "بيت لا اعرفه", suggestions: [bait()] },
  { kind: "near_miss", normalized: "ما كل ما يتمنى", suggestion: bait(), score: 0.44, acceptCost: HINT_COSTS.accept_near_miss },
  { kind: "ambiguous", normalized: "ما كل", candidates: [bait(), bait({ id: 8, baytKey: "q78:1" })] },
  { kind: "incomplete_bait", bait: bait() },
  { kind: "too_short", words: 1 },
  { kind: "timeout", bait: bait() },
  { kind: "network", message: "تعذّر الاتصال بالخادم" },
  { kind: "no_bait", letter: "ظ" },
]

describe("the rejection card", () => {
  it("has Arabic copy for every tag the machine can produce", () => {
    for (const r of REJECTIONS) expect(titleOf(r)).toMatch(/\p{Script=Arabic}/u)
  })

  it("spends a life for exactly not_found, incomplete_bait and timeout", () => {
    expect([...COSTS_LIFE].sort()).toEqual(["incomplete_bait", "not_found", "timeout"])
    // amendments.md §4.3 — a network error must never cost anything
    expect(COSTS_LIFE.has("network")).toBe(false)
    expect(COSTS_LIFE.has("wrong_letter")).toBe(false)
    expect(COSTS_LIFE.has("near_miss")).toBe(false)
  })

  it("renders each tag without throwing, and marks the cost honestly", () => {
    for (const r of REJECTIONS) {
      const html = renderToStaticMarkup(
        createElement(RejectionCard, {
          rejection: r,
          livesLeft: 2,
          onFill: () => {},
          onCommit: () => {},
          onDismiss: () => {},
        }),
      )
      expect(html).toContain(`data-kind="${r.kind}"`)
      expect(html).toContain(COSTS_LIFE.has(r.kind) ? 'data-cost="life"' : 'data-cost="none"')
    }
  })

  it("puts the near-miss price on its own button (amendments.md §7)", () => {
    const html = renderToStaticMarkup(
      createElement(RejectionCard, {
        rejection: REJECTIONS[3]!,
        livesLeft: 3,
        onFill: () => {},
        onCommit: () => {},
        onDismiss: () => {},
      }),
    )
    expect(html).toContain("اقبل هذا البيت")
    expect(html).toContain("25")
  })

  it("shows the normalized reading on a not_found — «هذا ما فهمتُه»", () => {
    const html = renderToStaticMarkup(
      createElement(RejectionCard, {
        rejection: REJECTIONS[2]!,
        livesLeft: 1,
        onFill: () => {},
        onCommit: () => {},
        onDismiss: () => {},
      }),
    )
    expect(html).toContain("بيت لا اعرفه")
    expect(html).toContain("هل تقصد؟")
  })
})

// ── the summary ────────────────────────────────────────────────────────────

describe("the summary's reads", () => {
  it("headlines each outcome", () => {
    expect(headlineOf("stumped", 4)).toBe("أفحمتَ الخصم")
    expect(headlineOf("defeat", 4)).toBe("انقضت الأرواح")
    expect(headlineOf("abandoned", 4)).toBe("انسحبتَ")
    expect(headlineOf("match", 10)).toBe("انتهت المبارزة")
    expect(headlineOf(null, 6)).toContain("سلسلة")
  })

  it("lists شعراء once each, in the order they were recited", () => {
    const s = stateWith([
      ex(),
      ex({ side: "player", baytKey: "q102:1", poet: { slug: "shawqi", name: "أحمد شوقي" } }),
      ex({ baytKey: "q103:1" }),
    ])
    expect(poetsOf(s).map((p) => p.slug)).toEqual(["mutanabi", "shawqi"])
  })

  it("counts only YOUR letters into the arsenal", () => {
    const s = stateWith([
      ex({ sadr: "نامَت نَواطيرُ مِصرَ" }),
      ex({ side: "player", baytKey: "q102:1", sadr: "مَن ذا الَّذي" }),
      ex({ side: "player", baytKey: "q103:1", sadr: "مِثلُكَ لا يُنسى" }),
    ])
    expect(lettersGained(s)).toEqual(["م"])
  })
})

// ── the share block (design-ux.md §5) ──────────────────────────────────────

describe("the share block", () => {
  it("writes the day in the Levantine month names the doc uses", () => {
    expect(MONTHS_AR).toHaveLength(12)
    expect(arabicDay("2026-08-23")).toBe("٢٣ آب")
    expect(arabicDay("not-a-day")).toBe("not-a-day")
  })

  it("joins the chain with ← , which is «next» under RTL (amendments.md §15)", () => {
    expect(letterRibbon(["ن", "م", "ب"])).toBe("ن ← م ← ب")
  })

  it("opens with an RLM and names the challenge on a daily block", () => {
    const text = shareText({ dayKey: "2026-08-23", letters: ["ن", "م"], chainLength: 6, score: 740 })
    expect(text.startsWith(RLM)).toBe(true)
    expect(text).toContain("قريض — تحدّي ٢٣ آب")
    expect(text).toContain("ن ← م")
    expect(text).toContain("٧٤٠")
  })

  it("says أفحمتُ الخصم only when the opponent actually ran dry", () => {
    const won = shareText({ letters: ["ر"], chainLength: 3, score: 900, stumped: true })
    expect(won).toContain("أفحمتُ الخصم")
    expect(shareText({ letters: ["ر"], chainLength: 3, score: 900 })).not.toContain("أفحمتُ")
  })
})

// ── تحدّي اليوم ─────────────────────────────────────────────────────────────

describe("the daily challenge", () => {
  it("turns over on the Riyadh calendar, like the server's بيت اليوم", () => {
    // 2026-08-23T22:00Z is already the 24th in Riyadh (UTC+3)
    expect(riyadhDay(new Date("2026-08-23T22:00:00Z"))).toBe("2026-08-24")
    expect(riyadhDay(new Date("2026-08-23T10:00:00Z"))).toBe("2026-08-23")
  })

  it("is one life, no clock, and the شاعر tier", () => {
    const c = dailyConfig()
    expect(c.lives).toBe(1)
    expect(c.timer).toBe(false)
    expect(c.tier).toBe("poet")
  })

  it("knows whether today has already been played", () => {
    const profile = {
      dailyResults: {
        "2026-08-23": { date: "2026-08-23", score: 10, chainLength: 1, letters: [], completedAt: 0 },
      },
    } as never
    expect(playedToday(profile, "2026-08-23")).toBe(true)
    expect(playedToday(profile, "2026-08-24")).toBe(false)
  })
})

// ── the one number the two formats disagree about ──────────────────────────

describe("المبارزة", () => {
  it("is ten أبيات, from the shared constant, not a literal in a view", () => {
    expect(MUBARAZA_EXCHANGES).toBe(10)
  })
})
