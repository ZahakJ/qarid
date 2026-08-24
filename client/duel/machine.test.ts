/**
 * The duel reducer, headless (design-ux.md §9 Phase 3: "machine.ts+tests
 * headless first"). Every transition in the §4.3 diagram is exercised here,
 * plus the four rules that are easy to get wrong: the paused clock, the time
 * given back after a slow verify, network errors costing no life, and hints
 * being charged exactly once.
 */
import { describe, expect, it } from "vitest"
import {
  DuelConfigSchema,
  DuelSessionSliceSchema,
  HINT_COSTS,
  type ArabicLetter,
  type BaitDto,
  type DuelConfig,
  type GameVerifyResponse,
  type PoemSummary,
  type PoetSummary,
} from "../../shared/schema.ts"
import { MUBARAZA_EXCHANGES } from "../../shared/constants.ts"
import {
  currentBait,
  displayScore,
  fromSlice,
  internalPoemId,
  letterChain,
  newDuel,
  playerTurns,
  reduce,
  replyLetter,
  timeLeft,
  toSlice,
  type DuelAction,
  type DuelState,
  type ServedBait,
} from "./machine.ts"
import { STUMP_BONUS } from "./scoring.ts"

// ── fixtures ────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000

function config(over: Partial<DuelConfig> = {}): DuelConfig {
  return DuelConfigSchema.parse({ turnSeconds: 40, lives: 3, timer: true, ...over })
}

let baitSeq = 100

function bait(over: Partial<BaitDto> = {}): BaitDto {
  const id = over.id ?? baitSeq++
  const poemId = over.poem?.id ?? `q${id * 7}`
  return {
    id,
    baytKey: `${poemId}:1`,
    position: 1,
    sadr: "وما نيلُ المطالبِ بالتمنّي",
    ajuz: "ولكن تُؤخذُ الدنيا غِلابا",
    rawiyy: "ب",
    lastLetter: "ا",
    firstLetter: "و",
    isPartial: false,
    poem: { id: poemId, title: "قصيدة" },
    poet: { slug: "ahmed-shawqi", name: "أحمد شوقي" },
    meter: { slug: "wafir", name: "الوافر", variant: null },
    era: null,
    ...over,
  }
}

function poem(id: string): PoemSummary {
  return {
    id,
    title: "قصيدة",
    poet: { slug: "ahmed-shawqi", name: "أحمد شوقي" },
    meter: { slug: "wafir", name: "الوافر", variant: null },
    theme: null,
    era: null,
    langType: "فصيح",
    rhyme: "ب",
    rhymeShare: 1,
    firstLetter: "و",
    baitCount: 12,
    hasTashkeel: true,
    previewSadr: null,
    previewAjuz: null,
  }
}

function poet(over: Partial<PoetSummary> = {}): PoetSummary {
  return {
    slug: "ahmed-shawqi",
    name: "أحمد شوقي",
    letter: "ش",
    era: null,
    location: null,
    description: null,
    fame: 3,
    poemCount: 1000,
    baitCount: 9000,
    ...over,
  }
}

/** A served بيت whose روي is `letter` — that is what the answerer must use. */
function served(letter: ArabicLetter = "ب", over: Partial<BaitDto> = {}): ServedBait {
  const b = bait(over)
  return {
    bait: b,
    poem: poem(b.poem.id),
    poet: poet(),
    requiredLetter: letter,
    requiredLetterSource: "rawiyy",
    alsoAccepted: [],
    mode: "rhyme",
    obscurity: 0,
  }
}

function okVerify(s: ServedBait): GameVerifyResponse {
  return {
    ok: true,
    matchKind: "exact",
    confidence: 1,
    normalized: "وما نيل المطالب بالتمني ولكن توخذ الدنيا غلابا",
    bait: s.bait,
    poem: s.poem,
    poet: s.poet,
    requiredLetter: s.requiredLetter,
    requiredLetterSource: s.requiredLetterSource,
    alsoAccepted: s.alsoAccepted,
    mode: s.mode,
    obscurity: s.obscurity,
  }
}

/** Run a script of actions from a fresh duel. */
function run(actions: DuelAction[], cfg: DuelConfig = config()): DuelState {
  let s = newDuel(cfg, "seed:1", T0)
  for (const a of actions) s = reduce(s, a)
  return s
}

/** dealt + revealed: the state a player actually types into. */
function awaiting(cfg: DuelConfig = config(), s0: ServedBait = served("ن")): DuelState {
  return run([
    { type: "DEALT", served: s0, now: T0 },
    { type: "REVEAL_DONE", now: T0 + 2_000 },
  ], cfg)
}

// ── the machine ─────────────────────────────────────────────────────────────

describe("newDuel", () => {
  it("starts in dealing with the config's lives and nothing said", () => {
    const s = newDuel(config({ lives: 2 }), "seed:1", T0)
    expect(s.phase).toBe("dealing")
    expect(s.lives).toBe(2)
    expect(s.exchanges).toEqual([])
    expect(s.score).toBe(0)
    expect(s.deadline).toBeNull()
    expect(s.startedAt).toBe(T0)
  })

  it("START from any phase begins a clean duel", () => {
    const mid = awaiting()
    const s = reduce(mid, { type: "START", config: config(), seed: "seed:2", now: T0 + 9_000 })
    expect(s.phase).toBe("dealing")
    expect(s.exchanges).toEqual([])
    expect(s.seed).toBe("seed:2")
  })
})

describe("dealing → reciting → awaiting", () => {
  it("DEALT pushes the opponent's بيت, sets the required letter, and does NOT start the clock", () => {
    const s0 = served("ن")
    const s = run([{ type: "DEALT", served: s0, now: T0 }])
    expect(s.phase).toBe("reciting")
    expect(s.required.letter).toBe("ن")
    expect(s.required.source).toBe("rawiyy")
    expect(s.exchanges).toHaveLength(1)
    expect(s.exchanges[0]!.side).toBe("opponent")
    expect(s.deadline).toBeNull()
    expect(timeLeft(s, T0 + 5_000)).toBeNull()
    expect(currentBait(s)?.baitId).toBe(s0.bait.id)
  })

  it("the opponent's بيت is immediately unusable by either side", () => {
    const s0 = served("ن", { id: 501, poem: { id: "q77", title: "ت" } })
    const s = run([{ type: "DEALT", served: s0, now: T0 }])
    expect(s.usedBaitIds).toEqual([501])
    expect(s.usedKeys).toEqual(["q77:1"])
    expect(s.usedPoemIds).toEqual([77])
  })

  it("an aldiwan public id contributes no internal poem id (and never a wrong one)", () => {
    expect(internalPoemId("q16182")).toBe(16182)
    expect(internalPoemId("16182")).toBeNull()
    expect(internalPoemId(null)).toBeNull()
    const s = run([{ type: "DEALT", served: served("ن", { poem: { id: "16182", title: "ت" } }), now: T0 }])
    expect(s.usedPoemIds).toEqual([])
    expect(s.usedBaitIds).toHaveLength(1)
  })

  it("REVEAL_DONE starts the wall-clock deadline; SKIP does the same", () => {
    const a = awaiting()
    expect(a.phase).toBe("awaiting")
    expect(a.deadline).toBe(T0 + 2_000 + 40_000)
    expect(timeLeft(a, T0 + 2_000)).toBe(40_000)
    expect(timeLeft(a, T0 + 12_000)).toBe(30_000)

    const skipped = run([
      { type: "DEALT", served: served("ن"), now: T0 },
      { type: "SKIP", now: T0 + 300 },
    ])
    expect(skipped.phase).toBe("awaiting")
    expect(skipped.deadline).toBe(T0 + 300 + 40_000)
  })

  it("with the timer off there is no deadline at all", () => {
    const a = awaiting(config({ timer: false }))
    expect(a.deadline).toBeNull()
    expect(timeLeft(a, T0 + 10_000_000)).toBeNull()
    expect(reduce(a, { type: "TICK", now: T0 + 10_000_000 })).toBe(a)
  })

  it("DEAL_FAILED lands in failed, and RETRY deals again", () => {
    const s = run([{ type: "DEAL_FAILED", message: "تعذّر", now: T0 }])
    expect(s.phase).toBe("failed")
    expect(s.error).toBe("تعذّر")
    expect(reduce(s, { type: "RETRY", now: T0 + 1 }).phase).toBe("dealing")
  })
})

describe("awaiting → verifying", () => {
  it("SUBMIT pauses the clock without moving the deadline", () => {
    const a = awaiting()
    const v = reduce(a, { type: "SUBMIT", text: "بيت", now: T0 + 12_000 })
    expect(v.phase).toBe("verifying")
    expect(v.pausedAt).toBe(T0 + 12_000)
    expect(v.deadline).toBe(a.deadline)
    // frozen: two different `now`s read the same remaining time
    expect(timeLeft(v, T0 + 12_000)).toBe(30_000)
    expect(timeLeft(v, T0 + 25_000)).toBe(30_000)
  })

  it("SUBMIT is ignored in any other phase", () => {
    const r = run([{ type: "DEALT", served: served("ن"), now: T0 }])
    expect(reduce(r, { type: "SUBMIT", text: "x", now: T0 + 1 })).toBe(r)
  })

  it("DRAFT keeps the typed text and returns the same object when unchanged", () => {
    const a = awaiting()
    const d = reduce(a, { type: "DRAFT", text: "نظرت" })
    expect(d.draft).toBe("نظرت")
    expect(reduce(d, { type: "DRAFT", text: "نظرت" })).toBe(d)
  })
})

describe("verifying → accepted", () => {
  const s0 = served("ن")
  const answer = served("ب", { id: 900, poem: { id: "q900", title: "جوابك" } })

  it("scores the بيت, pushes it, and lifts the streak", () => {
    const a = awaiting(config(), s0)
    const v = reduce(a, { type: "SUBMIT", text: "…", now: T0 + 12_000 })
    const acc = reduce(v, { type: "VERIFIED", response: okVerify(answer), now: T0 + 12_400 })
    expect(acc.phase).toBe("accepted")
    expect(acc.streak).toBe(1)
    expect(acc.best).toBe(1)
    // 100 base + 10 streak + 30s × 2 = 170
    expect(acc.score).toBe(170)
    expect(acc.lastAward?.total).toBe(170)
    expect(playerTurns(acc)).toBe(1)
    expect(acc.exchanges.at(-1)!.side).toBe("player")
    expect(acc.exchanges.at(-1)!.award).toBe(170)
    expect(acc.exchanges.at(-1)!.ms).toBe(10_400)
    expect(acc.deadline).toBeNull()
    expect(acc.draft).toBe("")
  })

  it("the time bonus is measured at SUBMIT, not at the response", () => {
    const a = awaiting(config(), s0)
    const v = reduce(a, { type: "SUBMIT", text: "…", now: T0 + 12_000 })
    const slow = reduce(v, { type: "VERIFIED", response: okVerify(answer), now: T0 + 40_000 })
    expect(slow.score).toBe(170)
  })

  it("the answer's روي becomes what the OPPONENT owes", () => {
    const a = awaiting(config(), s0)
    const acc = reduce(reduce(a, { type: "SUBMIT", text: "…", now: T0 + 1_000 }), {
      type: "VERIFIED",
      response: okVerify(answer),
      now: T0 + 1_100,
    })
    expect(replyLetter(acc)).toBe("ب")
    // the player still sees the letter THEY were asked for until the opponent answers
    expect(acc.required.letter).toBe("ن")
    expect(letterChain(acc)).toEqual([
      { letter: "ن", side: "opponent" },
      { letter: "ب", side: "player" },
    ])
  })

  it("CONTINUE moves to computerThinking; REPLIED recites again", () => {
    const acc = reduce(reduce(awaiting(config(), s0), { type: "SUBMIT", text: "…", now: T0 + 3_000 }), {
      type: "VERIFIED",
      response: okVerify(answer),
      now: T0 + 3_200,
    })
    const think = reduce(acc, { type: "CONTINUE", now: T0 + 4_000 })
    expect(think.phase).toBe("computerThinking")
    const next = reduce(think, { type: "REPLIED", served: served("د", { id: 950 }), now: T0 + 5_200 })
    expect(next.phase).toBe("reciting")
    expect(next.required.letter).toBe("د")
    expect(next.deadline).toBeNull()
    expect(next.exchanges).toHaveLength(3)
  })

  it("NO_REPLY is the victory: +500 and a summary", () => {
    const acc = reduce(reduce(awaiting(config(), s0), { type: "SUBMIT", text: "…", now: T0 + 3_000 }), {
      type: "VERIFIED",
      response: okVerify(answer),
      now: T0 + 3_200,
    })
    const think = reduce(acc, { type: "CONTINUE", now: T0 + 4_000 })
    const win = reduce(think, { type: "NO_REPLY", letter: "ب", now: T0 + 5_000 })
    expect(win.phase).toBe("summary")
    expect(win.outcome).toBe("stumped")
    expect(win.score).toBe(acc.score + STUMP_BONUS)
    expect(win.endedAt).toBe(T0 + 5_000)
  })

  it("REPLY_ERROR keeps the phase and lets the caller retry", () => {
    const think = reduce(
      reduce(reduce(awaiting(config(), s0), { type: "SUBMIT", text: "…", now: T0 + 1_000 }), {
        type: "VERIFIED",
        response: okVerify(answer),
        now: T0 + 1_100,
      }),
      { type: "CONTINUE", now: T0 + 1_200 },
    )
    const failed = reduce(think, { type: "REPLY_ERROR", message: "تعذّر الاتصال", now: T0 + 2_000 })
    expect(failed.phase).toBe("computerThinking")
    expect(failed.error).toBe("تعذّر الاتصال")
    expect(reduce(failed, { type: "RETRY", now: T0 + 2_100 }).error).toBeNull()
  })

  it("المبارزة ends after ten أبيات; الوصال does not", () => {
    let s = awaiting(config({ format: "match", timer: false }))
    for (let i = 0; i < MUBARAZA_EXCHANGES; i++) {
      s = reduce(s, { type: "SUBMIT", text: "…", now: T0 + i })
      s = reduce(s, { type: "VERIFIED", response: okVerify(served("ب", { id: 1000 + i })), now: T0 + i })
      if (i < MUBARAZA_EXCHANGES - 1) {
        s = reduce(s, { type: "CONTINUE", now: T0 + i })
        s = reduce(s, { type: "REPLIED", served: served("ن", { id: 2000 + i }), now: T0 + i })
        s = reduce(s, { type: "REVEAL_DONE", now: T0 + i })
      }
    }
    expect(playerTurns(s)).toBe(MUBARAZA_EXCHANGES)
    const end = reduce(s, { type: "CONTINUE", now: T0 + 99_000 })
    expect(end.phase).toBe("summary")
    expect(end.outcome).toBe("match")
  })
})

describe("verifying → rejected (soft: costs nothing)", () => {
  const wrong: GameVerifyResponse = {
    ok: false,
    reason: "wrong_letter",
    expected: "ن",
    alsoAccepted: ["ه"],
    got: "م",
    normalized: "من ذا الذي",
  }

  it("wrong_letter keeps the life, the streak, the draft and the clock", () => {
    const a = awaiting()
    const acc0 = { ...a, streak: 4, score: 500 }
    const v = reduce(acc0, { type: "SUBMIT", text: "من ذا الذي", now: T0 + 10_000 })
    const rej = reduce(v, { type: "VERIFIED", response: wrong, now: T0 + 10_400 })
    expect(rej.phase).toBe("rejected")
    expect(rej.lives).toBe(3)
    expect(rej.streak).toBe(4)
    expect(rej.score).toBe(500)
    expect(rej.draft).toBe("من ذا الذي")
    expect(rej.rejection).toEqual({ kind: "wrong_letter", expected: "ن", alsoAccepted: ["ه"], got: "م", normalized: "من ذا الذي" })
    expect(rej.lastResult?.kind).toBe("wrong_letter")
  })

  it("RESOLVE gives back every ms the round trip cost (amendment 7)", () => {
    const a = awaiting()
    const v = reduce(a, { type: "SUBMIT", text: "x", now: T0 + 10_000 })
    const rej = reduce(v, { type: "VERIFIED", response: wrong, now: T0 + 10_400 })
    const back = reduce(rej, { type: "RESOLVE", now: T0 + 13_000 })
    expect(back.phase).toBe("awaiting")
    expect(back.pausedAt).toBeNull()
    // 3s were spent verifying + reading the card; the deadline moved 3s later
    expect(back.deadline).toBe(a.deadline! + 3_000)
    expect(timeLeft(back, T0 + 13_000)).toBe(32_000)
    expect(back.rejection).toBeNull()
  })

  it("already_used, too_short, near_miss and no_bait are all soft", () => {
    const cases: GameVerifyResponse[] = [
      { ok: false, reason: "already_used", bait: bait({ id: 601 }) },
      { ok: false, reason: "too_short", words: 1 },
      { ok: false, reason: "near_miss", normalized: "ن", suggestion: bait({ id: 602 }), score: 0.5, acceptCost: HINT_COSTS.accept_near_miss },
      { ok: false, reason: "no_bait", letter: "ظ" },
    ]
    for (const response of cases) {
      const v = reduce(awaiting(), { type: "SUBMIT", text: "x", now: T0 + 5_000 })
      const rej = reduce(v, { type: "VERIFIED", response, now: T0 + 5_100 })
      expect(rej.phase, response.ok ? "" : response.reason).toBe("rejected")
      expect(rej.lives).toBe(3)
      expect(rej.rejection?.kind).toBe(response.ok ? "" : response.reason)
    }
  })

  it("a network error is a soft rejection, never a life", () => {
    const v = reduce(awaiting(), { type: "SUBMIT", text: "x", now: T0 + 5_000 })
    const rej = reduce(v, { type: "VERIFY_ERROR", message: "تعذّر الاتصال بالخادم", now: T0 + 7_000 })
    expect(rej.phase).toBe("rejected")
    expect(rej.lives).toBe(3)
    expect(rej.streak).toBe(0)
    expect(rej.rejection).toEqual({ kind: "network", message: "تعذّر الاتصال بالخادم" })
    expect(rej.lastResult?.kind).toBe("network")
    // and the clock still gives the time back
    const back = reduce(rej, { type: "RESOLVE", now: T0 + 9_000 })
    expect(back.deadline).toBe(awaiting().deadline! + 4_000)
  })
})

describe("verifying → penalising (costs a life)", () => {
  const notFound: GameVerifyResponse = { ok: false, reason: "not_found", normalized: "لا شيء", suggestions: [bait({ id: 701 })] }

  it("not_found takes a life and breaks the streak", () => {
    const a = { ...awaiting(), streak: 6, score: 900 }
    const v = reduce(a, { type: "SUBMIT", text: "لا شيء", now: T0 + 6_000 })
    const pen = reduce(v, { type: "VERIFIED", response: notFound, now: T0 + 6_300 })
    expect(pen.phase).toBe("penalising")
    expect(pen.lives).toBe(2)
    expect(pen.streak).toBe(0)
    expect(pen.score).toBe(900)
    expect(pen.rejection?.kind).toBe("not_found")
  })

  it("incomplete_bait costs a life too", () => {
    const v = reduce(awaiting(), { type: "SUBMIT", text: "x", now: T0 + 1_000 })
    const pen = reduce(v, { type: "VERIFIED", response: { ok: false, reason: "incomplete_bait", bait: bait({ id: 702 }) }, now: T0 + 1_100 })
    expect(pen.phase).toBe("penalising")
    expect(pen.lives).toBe(2)
  })

  it("RESOLVE hands back a WHOLE fresh turn on the same letter", () => {
    const a = awaiting()
    const v = reduce(a, { type: "SUBMIT", text: "x", now: T0 + 6_000 })
    const pen = reduce(v, { type: "VERIFIED", response: notFound, now: T0 + 6_300 })
    const back = reduce(pen, { type: "RESOLVE", now: T0 + 9_000 })
    expect(back.phase).toBe("awaiting")
    expect(back.required.letter).toBe("ن")
    expect(back.deadline).toBe(T0 + 9_000 + 40_000)
    expect(back.pausedAt).toBeNull()
  })

  it("the last life ends the duel in defeat, and keeps the card that killed it", () => {
    const a = { ...awaiting(config({ lives: 1 })), lives: 1 }
    const v = reduce(a, { type: "SUBMIT", text: "x", now: T0 + 2_000 })
    const dead = reduce(v, { type: "VERIFIED", response: notFound, now: T0 + 2_400 })
    expect(dead.phase).toBe("summary")
    expect(dead.outcome).toBe("defeat")
    expect(dead.lives).toBe(0)
    expect(dead.endedAt).toBe(T0 + 2_400)
    expect(dead.rejection?.kind).toBe("not_found")
  })
})

describe("the clock", () => {
  it("TICK before the deadline changes nothing at all (same object)", () => {
    const a = awaiting()
    expect(reduce(a, { type: "TICK", now: T0 + 20_000 })).toBe(a)
  })

  it("TICK past the deadline times out: −1 life, streak 0, same letter", () => {
    const a = { ...awaiting(), streak: 3 }
    const out = reduce(a, { type: "TICK", now: a.deadline! + 1 })
    expect(out.phase).toBe("penalising")
    expect(out.lives).toBe(2)
    expect(out.streak).toBe(0)
    expect(out.rejection).toEqual({ kind: "timeout", bait: null })
    expect(out.lastResult?.kind).toBe("timeout")
  })

  it("TIMEOUT can carry the بيت that would have worked", () => {
    const a = awaiting()
    const shown = bait({ id: 808 })
    const out = reduce(a, { type: "TIMEOUT", now: a.deadline!, bait: shown })
    expect(out.rejection).toEqual({ kind: "timeout", bait: shown })
  })

  it("a timeout cannot fire while verifying (the clock is paused)", () => {
    const v = reduce(awaiting(), { type: "SUBMIT", text: "x", now: T0 + 5_000 })
    expect(reduce(v, { type: "TICK", now: T0 + 10_000_000 })).toBe(v)
  })
})

describe("disambiguation", () => {
  const ambiguous: GameVerifyResponse = {
    ok: false,
    reason: "ambiguous",
    normalized: "ن",
    candidates: [bait({ id: 401 }), bait({ id: 402 })],
  }

  it("VERIFIED(ambiguous) opens the picker without cost", () => {
    const v = reduce(awaiting(), { type: "SUBMIT", text: "x", now: T0 + 4_000 })
    const dis = reduce(v, { type: "VERIFIED", response: ambiguous, now: T0 + 4_200 })
    expect(dis.phase).toBe("disambiguating")
    expect(dis.lives).toBe(3)
    expect(dis.rejection?.kind).toBe("ambiguous")
  })

  it("CANCEL returns to awaiting with the paused time given back", () => {
    const a = awaiting()
    const v = reduce(a, { type: "SUBMIT", text: "x", now: T0 + 4_000 })
    const dis = reduce(v, { type: "VERIFIED", response: ambiguous, now: T0 + 4_200 })
    const back = reduce(dis, { type: "CANCEL", now: T0 + 8_000 })
    expect(back.phase).toBe("awaiting")
    expect(back.deadline).toBe(a.deadline! + 4_000)
  })

  it("RESUBMIT sends the picked candidate back through verify", () => {
    const v = reduce(awaiting(), { type: "SUBMIT", text: "x", now: T0 + 4_000 })
    const dis = reduce(v, { type: "VERIFIED", response: ambiguous, now: T0 + 4_200 })
    const again = reduce(dis, { type: "RESUBMIT", text: "الصدر … العجز", penalty: 0, now: T0 + 6_000 })
    expect(again.phase).toBe("verifying")
    expect(again.draft).toBe("الصدر … العجز")
    expect(again.pausedAt).toBe(T0 + 4_000)
    expect(again.rejection).toBeNull()
  })

  it("«اقبل هذا البيت» resubmits with the near-miss cost attached", () => {
    const v = reduce(awaiting(), { type: "SUBMIT", text: "x", now: T0 + 4_000 })
    const near = reduce(v, {
      type: "VERIFIED",
      response: { ok: false, reason: "near_miss", normalized: "ن", suggestion: bait({ id: 610 }), score: 0.5, acceptCost: HINT_COSTS.accept_near_miss },
      now: T0 + 4_200,
    })
    const again = reduce(near, { type: "RESUBMIT", text: "البيت المقترح", penalty: HINT_COSTS.accept_near_miss, now: T0 + 5_000 })
    expect(again.hintSpend).toBe(HINT_COSTS.accept_near_miss)
    const acc = reduce(again, { type: "VERIFIED", response: okVerify(served("ب", { id: 610 })), now: T0 + 5_100 })
    // 100 + 10 + 2×36s − 25
    expect(acc.lastAward!.hintPenalty).toBe(25)
    expect(acc.score).toBe(acc.lastAward!.total)
  })
})

describe("hints", () => {
  it("a hint is charged exactly once — pending in displayScore, settled in the award", () => {
    const a = awaiting(config({ timer: false }))
    const h = reduce(a, { type: "HINT", kind: "poet", cost: HINT_COSTS.poet, reveal: { poet: "المتنبي" }, now: T0 + 3_000 })
    expect(h.phase).toBe("awaiting")
    expect(h.hints).toEqual(["poet"])
    expect(h.hintSpend).toBe(40)
    expect(h.score).toBe(0)
    expect(displayScore(h)).toBe(-40)
    expect(h.hintReveals.poet).toBe("المتنبي")

    const acc = reduce(reduce(h, { type: "SUBMIT", text: "x", now: T0 + 4_000 }), {
      type: "VERIFIED",
      response: okVerify(served("ب", { id: 990 })),
      now: T0 + 4_100,
    })
    // 100 + 10 − 40, and NOT charged a second time
    expect(acc.score).toBe(70)
    expect(displayScore(acc)).toBe(70)
    expect(acc.hintSpend).toBe(0)
    expect(acc.exchanges.at(-1)!.hints).toEqual(["poet"])
  })

  it("a lost exchange still pays for its hints", () => {
    const a = awaiting(config({ timer: false }))
    const h = reduce(a, { type: "HINT", kind: "first_word", cost: HINT_COSTS.first_word, now: T0 + 1_000 })
    const pen = reduce(reduce(h, { type: "SUBMIT", text: "x", now: T0 + 2_000 }), {
      type: "VERIFIED",
      response: { ok: false, reason: "not_found", normalized: "ن", suggestions: [] },
      now: T0 + 2_100,
    })
    expect(pen.score).toBe(-60)
    expect(pen.hintSpend).toBe(0)
    expect(pen.hints).toEqual([])
  })

  it("the same hint cannot be bought twice", () => {
    const h = reduce(awaiting(), { type: "HINT", kind: "meter", cost: 20, now: T0 + 3_000 })
    expect(reduce(h, { type: "HINT", kind: "meter", cost: 20, now: T0 + 4_000 })).toBe(h)
  })

  it("«بدّل الحرف» recites a new بيت, resets the streak and charges its price", () => {
    const a = { ...awaiting(), streak: 5 }
    const fresh = served("ل", { id: 555, poem: { id: "q555", title: "بديل" } })
    const sw = reduce(a, { type: "HINT_SWITCH", served: fresh, cost: HINT_COSTS.switch_letter, now: T0 + 8_000 })
    expect(sw.phase).toBe("reciting")
    expect(sw.required.letter).toBe("ل")
    expect(sw.streak).toBe(0)
    expect(sw.hintSpend).toBe(HINT_COSTS.switch_letter)
    expect(sw.hints).toContain("switch_letter")
    expect(sw.deadline).toBeNull()
    expect(sw.usedBaitIds).toContain(555)
  })

  it("hints are refused outside awaiting", () => {
    const v = reduce(awaiting(), { type: "SUBMIT", text: "x", now: T0 + 1_000 })
    expect(reduce(v, { type: "HINT", kind: "poet", cost: 40, now: T0 + 1_100 })).toBe(v)
  })
})

describe("leaving", () => {
  it("ABANDON summarises whatever happened so far", () => {
    const s = reduce(awaiting(), { type: "ABANDON", now: T0 + 30_000 })
    expect(s.phase).toBe("summary")
    expect(s.outcome).toBe("abandoned")
    expect(s.endedAt).toBe(T0 + 30_000)
    expect(s.deadline).toBeNull()
  })

  it("PLAY_AGAIN keeps the config and drops everything else", () => {
    const done = reduce(awaiting(), { type: "ABANDON", now: T0 + 30_000 })
    const again = reduce(done, { type: "PLAY_AGAIN", seed: "seed:9", now: T0 + 31_000 })
    expect(again.phase).toBe("dealing")
    expect(again.config).toEqual(done.config)
    expect(again.exchanges).toEqual([])
    expect(again.score).toBe(0)
    expect(again.seed).toBe("seed:9")
  })

  it("EXIT parks the machine in idle", () => {
    expect(reduce(awaiting(), { type: "EXIT" }).phase).toBe("idle")
  })
})

describe("persistence", () => {
  it("toSlice is exactly the persisted shape (transients dropped)", () => {
    const s = awaiting()
    const slice = toSlice(s)
    expect(DuelSessionSliceSchema.parse(slice)).toEqual(slice)
    expect(Object.keys(slice)).not.toContain("rejection")
    expect(Object.keys(slice)).not.toContain("draft")
  })

  it("a reload mid-turn hands back a whole fresh turn", () => {
    const s = awaiting()
    const back = fromSlice(toSlice(s), T0 + 600_000)
    expect(back.phase).toBe("awaiting")
    expect(back.required.letter).toBe("ن")
    expect(back.deadline).toBe(T0 + 600_000 + 40_000)
    expect(back.exchanges).toHaveLength(1)
  })

  it("a reload while verifying never strands the player and never costs a life", () => {
    const v = reduce(awaiting(), { type: "SUBMIT", text: "x", now: T0 + 5_000 })
    const back = fromSlice(toSlice(v), T0 + 900_000)
    expect(back.phase).toBe("awaiting")
    expect(back.lives).toBe(3)
    expect(back.pausedAt).toBeNull()
  })

  it("a reload during the reveal replays the reveal", () => {
    const r = run([{ type: "DEALT", served: served("ن"), now: T0 }])
    expect(fromSlice(toSlice(r), T0 + 60_000).phase).toBe("reciting")
  })

  it("a reload with no lives left goes straight to the summary", () => {
    const s = { ...awaiting(), lives: 0 }
    const back = fromSlice(toSlice(s), T0 + 60_000)
    expect(back.phase).toBe("summary")
    expect(back.outcome).toBe("defeat")
  })

  it("a finished duel stays finished", () => {
    const done = reduce(awaiting(), { type: "ABANDON", now: T0 + 30_000 })
    const back = fromSlice(toSlice(done), T0 + 90_000)
    expect(back.phase).toBe("summary")
    expect(back.deadline).toBeNull()
  })

  it("survives a round trip through JSON and the zod schema", () => {
    const s = awaiting()
    const raw = JSON.parse(JSON.stringify(toSlice(s))) as unknown
    const parsed = DuelSessionSliceSchema.parse(raw)
    expect(fromSlice(parsed, T0 + 1_000).required.letter).toBe("ن")
  })
})

describe("guards", () => {
  it("every action is inert in the phase it does not belong to", () => {
    const dealing = newDuel(config(), "seed:1", T0)
    const cases: [DuelState, DuelAction][] = [
      [dealing, { type: "REVEAL_DONE", now: T0 }],
      [dealing, { type: "VERIFIED", response: okVerify(served()), now: T0 }],
      [dealing, { type: "RESOLVE", now: T0 }],
      [dealing, { type: "CONTINUE", now: T0 }],
      [dealing, { type: "REPLIED", served: served(), now: T0 }],
      [dealing, { type: "NO_REPLY", letter: "ب", now: T0 }],
      [dealing, { type: "TIMEOUT", now: T0 }],
      [dealing, { type: "CANCEL", now: T0 }],
      [awaiting(), { type: "DEALT", served: served(), now: T0 }],
      [awaiting(), { type: "DEAL_FAILED", message: "x", now: T0 }],
      [awaiting(), { type: "VERIFY_ERROR", message: "x", now: T0 }],
      [awaiting(), { type: "RESUBMIT", text: "x", penalty: 0, now: T0 }],
      [awaiting(), { type: "RETRY", now: T0 }],
    ]
    for (const [state, action] of cases) expect(reduce(state, action), action.type).toBe(state)
  })
})
