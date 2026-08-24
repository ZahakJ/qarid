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
import { MUBARAZA_EXCHANGES, THIN_POOL_WARNING } from "../../shared/constants.ts"
import { RLM } from "../../shared/format.ts"
import { clampTier, configFor, presetOf, tierAllowed, TIER_PRESETS } from "./tiers.ts"
import { poolIsThin } from "./DuelSetupView.tsx"
import { REVEAL, revealTiming, wordCount } from "./RecitationReveal.tsx"
import { ExchangeLog, poetRevealed } from "./ExchangeLog.tsx"
import { COSTS_LIFE, RejectionCard, titleOf } from "./RejectionCard.tsx"
import { LetterIndicator, clauseFor, typedLetter, verdictOf } from "./LetterIndicator.tsx"
import { arabicDay, letterRibbon, MONTHS_AR, shareText } from "./share.ts"
import { dailyConfig, playedToday, riyadhDay } from "./daily.ts"
import { headlineOf, lettersGained, poetsOf } from "./DuelSummaryView.tsx"
import { pricedHint } from "./scoring.ts"
import type { DuelState, Rejection } from "./machine.ts"
import { fromSlice, newDuel, toSlice } from "./machine.ts"

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
    poem: { id: "q77", poemId: 77, title: "قصيدة" },
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

  it("says «خرج عن القيود» on an opponent's بيت the server had to relax", () => {
    const relaxed = renderToStaticMarkup(
      createElement(ExchangeLog, { exchanges: [ex({ relaxed: true })], ended: true }),
    )
    expect(relaxed).toContain("خرج عن القيود")
    expect(relaxed).toContain("exchange__relaxed")

    const inside = renderToStaticMarkup(createElement(ExchangeLog, { exchanges: [ex()], ended: true }))
    expect(inside).not.toContain("خرج عن القيود")
  })

  it("withholds the note while the بيت is still standing — it is the شاعر's own beat", () => {
    // the same rule as the attribution: naming anything about the opponent's
    // بيت before it has been answered is a hint
    const html = renderToStaticMarkup(createElement(ExchangeLog, { exchanges: [ex({ relaxed: true })] }))
    expect(html).not.toContain("خرج عن القيود")
  })

  it("defaults `relaxed` to false, so a session written before the field parses", () => {
    expect(ex().relaxed).toBe(false)
  })
})

// ── the setup screen's thin-pool warning (amendments.md §2) ────────────────

describe("«العدد المتاح»", () => {
  it("warns off the EFFECTIVE pool, not the tier's own", () => {
    // مبتدئ is 95K أبيات but relaxes into سيف's 1.7M, so a combination that
    // looks thin at the chosen رتبة still plays
    expect(poolIsThin({ total: 10, effective: THIN_POOL_WARNING + 1, stale: false })).toBe(false)
    expect(poolIsThin({ total: 10_000_000, effective: THIN_POOL_WARNING - 1, stale: false })).toBe(true)
    expect(poolIsThin({ total: 0, effective: 0, stale: false })).toBe(true)
  })

  it("warns about nothing while the count is still unknown", () => {
    expect(poolIsThin(null)).toBe(false)
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

  it("spends a life for exactly not_found and timeout", () => {
    expect([...COSTS_LIFE].sort()).toEqual(["not_found", "timeout"])
    // amendments.md §4.3 — a network error must never cost anything
    expect(COSTS_LIFE.has("network")).toBe(false)
    expect(COSTS_LIFE.has("wrong_letter")).toBe(false)
    expect(COSTS_LIFE.has("near_miss")).toBe(false)
    // …and neither must the corpus's own damage: the بيت is real, the ديوان
    // simply holds it with no عجز
    expect(COSTS_LIFE.has("incomplete_bait")).toBe(false)
  })

  it("marks the incomplete_bait card «لا تُحتسب», with the mutilated بيت shown", () => {
    const html = renderToStaticMarkup(
      createElement(RejectionCard, {
        rejection: { kind: "incomplete_bait", bait: bait({ ajuz: null, isPartial: true }) } as Rejection,
        livesLeft: 3,
        onFill: () => {},
        onCommit: () => {},
        onDismiss: () => {},
      }),
    )
    expect(html).toContain('data-cost="none"')
    expect(html).toContain("لا تُحتسب")
    expect(html).not.toContain("−روح")
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

  /**
   * The backlog's «a duel summary that survived a reload degrades its
   * headline». `outcome` is persisted now, so the reloaded session must
   * headline with the SAME string, not with the «سلسلة من N بيتًا» fallback.
   */
  it("keeps the exact headline across a reload, for every ending", () => {
    const base = stateWith([ex(), ex({ side: "player", baytKey: "q102:1" })])
    const chain = 1
    for (const outcome of ["stumped", "defeat", "abandoned", "match"] as const) {
      const ended: DuelState = { ...base, phase: "summary", outcome, endedAt: T0 + 30_000 }
      const before = headlineOf(ended.outcome, chain)
      const reloaded = fromSlice(JSON.parse(JSON.stringify(toSlice(ended))) as never, T0 + 90_000)
      expect(reloaded.phase).toBe("summary")
      expect(headlineOf(reloaded.outcome, chain)).toBe(before)
      expect(headlineOf(reloaded.outcome, chain)).not.toContain("سلسلة")
      expect(reloaded.endedAt).toBe(T0 + 30_000)
    }
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
    expect(arabicDay("2026-08-23")).toBe("23 آب")
    expect(arabicDay("not-a-day")).toBe("not-a-day")
  })

  it("joins the chain with ← , which is «next» under RTL (amendments.md §15)", () => {
    expect(letterRibbon(["ن", "م", "ب"])).toBe("ن ← م ← ب")
  })

  it("opens EVERY line with an RLM and names the challenge on a daily block", () => {
    const text = shareText({ dayKey: "2026-08-23", letters: ["ن", "م"], chainLength: 6, score: 740 })
    expect(text.startsWith(RLM)).toBe(true)
    expect(text).toContain("قريض — تحدّي 23 آب")
    expect(text).toContain("ن ← م")
    expect(text).toContain("740")
    expect(text).toContain("6 أبيات")
    // the owner's numeral call reaches the clipboard too — no Arabic-Indic
    // digit may ride out of the app in shared text
    expect(text).not.toMatch(/[٠-٩]/)
    // client/bayt/copy.ts states the rule and formatPoem obeys it: one prefix
    // for the whole block leaves lines two and three to a Latin-first editor
    for (const line of text.split("\n")) expect(line.startsWith(RLM)).toBe(true)
  })

  it("puts the dual in the genitive after «من» — «سلسلة من بيتين»", () => {
    // «سلسلة من بيتان» shipped, and the share text is the one string that
    // leaves the app and is read by someone who never opened it.
    const two = shareText({ letters: ["ر", "م"], chainLength: 2, score: 247 })
    expect(two).toContain("سلسلة من بيتين")
    expect(two).not.toContain("بيتان")
    expect(shareText({ letters: ["ر"], chainLength: 1, score: 5 })).toContain("سلسلة من بيت واحد · 5 نقاط")
    expect(shareText({ letters: ["ر"], chainLength: 6, score: 740 })).toContain("سلسلة من 6 أبيات · 740 نقطة")
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
