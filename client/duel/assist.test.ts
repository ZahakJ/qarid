/**
 * `client/duel/assist.test.ts` — what وضع التدريب asks the server for, and (the
 * part that matters) what it refuses to ask for.
 *
 * The hook itself needs a DOM and this suite runs on node, so what is tested
 * here is the whole decision: `assistPlan` is the function that turns a
 * keystroke into "nothing", "an answer I already have" or "one request", and
 * `useAssist` only wires it to a timer and a fetch.
 */
import { describe, expect, it } from "vitest"
import { ASSIST } from "../../shared/constants.ts"
import type { BaitDto } from "../../shared/schema.ts"
import {
  acceptedKey,
  assistFillText,
  assistNeedle,
  assistPlan,
  knownEmpty,
  needleKey,
  newAssistMemo,
  rememberAssist,
} from "./assist.ts"

const bait = (id: number, sadr: string, ajuz: string | null): BaitDto =>
  ({
    id,
    baytKey: `p${id}:1`,
    position: 1,
    sadr,
    ajuz,
    rawiyy: "ل",
    lastLetter: "ل",
    firstLetter: "ل",
    isPartial: ajuz === null,
    poem: { id: "q1", title: null, poemId: 1 },
    poet: { slug: "mutanabi", name: "المتنبي" },
    meter: null,
    era: null,
  }) as unknown as BaitDto

const ON = { enabled: true, required: "ل", also: null }

describe("assistNeedle — the same fold the server compares with", () => {
  it("drops tashkeel, punctuation and doubled spaces", () => {
    expect(assistNeedle("لا خَيلَ  عِندَكَ،")).toBe("لا خيل عندك")
    expect(assistNeedle("   ")).toBe("")
  })
})

describe("assistPlan — one request per pause, and not one more", () => {
  it("asks for nothing at all in a normal duel", () => {
    // v2.md §2: "In normal mode the rail does NOT exist". Not "exists empty".
    expect(assistPlan(newAssistMemo(), { enabled: false, required: "ل", also: null, draft: "لا خيل" })).toEqual({
      kind: "idle",
    })
  })

  it("asks for nothing before there is a letter to chain on", () => {
    expect(assistPlan(newAssistMemo(), { enabled: true, required: null, also: null, draft: "لا خيل" })).toEqual({
      kind: "idle",
    })
  })

  it("asks for nothing under the minimum", () => {
    expect(ASSIST.minChars).toBe(2)
    expect(assistPlan(newAssistMemo(), { ...ON, draft: "ل" })).toEqual({ kind: "idle" })
    expect(assistPlan(newAssistMemo(), { ...ON, draft: "لَ" })).toEqual({ kind: "idle" })
    expect(assistPlan(newAssistMemo(), { ...ON, draft: "لا" })).toEqual({
      kind: "fetch",
      letter: "ل",
      also: null,
      needle: "لا",
    })
  })

  it("searches the وصل letter too, and keeps its answers apart from the روي's", () => {
    // Rhyme mode, a بيت whose روي ب sits under a وصل ه: an answer may open on ب
    // OR ه, so the rail must offer أبيات on both. The bug this fixes: it offered
    // only ب — the letter BEFORE the وصل — while the player wrote a ه-بيت.
    const memo = newAssistMemo()
    expect(assistPlan(memo, { enabled: true, required: "ب", also: "ه", draft: "هبت" })).toEqual({
      kind: "fetch",
      letter: "ب",
      also: "ه",
      needle: "هبت",
    })
    // «ب» alone and «ب + ه» are different questions: an answer cached for the
    // lone روي must not surface for the two-letter search, or vice versa.
    expect(acceptedKey("ب", "ه")).toBe("ب+ه")
    expect(acceptedKey("ب", null)).toBe("ب")
    rememberAssist(memo, acceptedKey("ب", null), "هبت", [bait(9, "بها", "بها")])
    expect(assistPlan(memo, { enabled: true, required: "ب", also: "ه", draft: "هبت" })).toEqual({
      kind: "fetch",
      letter: "ب",
      also: "ه",
      needle: "هبت",
    })
    // a وصل that repeats the روي (ب/ب) is no second letter at all
    expect(assistPlan(newAssistMemo(), { enabled: true, required: "ب", also: "ب", draft: "بها" })).toEqual({
      kind: "fetch",
      letter: "ب",
      also: null,
      needle: "بها",
    })
  })

  it("answers from memory when the same words come round again", () => {
    const memo = newAssistMemo()
    const items = [bait(1, "لا خيل عندك تهديها ولا مال", "فليسعد النطق")]
    rememberAssist(memo, "ل", "لا خيل", items)
    expect(assistPlan(memo, { ...ON, draft: "لا خيل" })).toEqual({ kind: "cached", items })
    // …and typing the same thing with تشكيل is the same question
    expect(assistPlan(memo, { ...ON, draft: "لا خَيلَ" })).toEqual({ kind: "cached", items })
  })

  it("never re-asks about a prefix that already answered with nothing", () => {
    // The server's best match is `startsWith`, so an empty answer is monotone:
    // if «لا خيل» found no بيت, «لا خيلَ عندك» cannot find one either. This is
    // what keeps typing a whole بيت down to one or two requests.
    const memo = newAssistMemo()
    rememberAssist(memo, "ل", "لا خيل", [])
    expect(assistPlan(memo, { ...ON, draft: "لا خيل" })).toEqual({ kind: "cached", items: [] })
    expect(assistPlan(memo, { ...ON, draft: "لا خيل عندك" })).toEqual({ kind: "cached", items: [] })
    expect(assistPlan(memo, { ...ON, draft: "لا خيلي" })).toEqual({ kind: "cached", items: [] })
    // …but a SHORTER needle is a different question, and so is another letter
    expect(assistPlan(memo, { ...ON, draft: "لا" })).toEqual({ kind: "fetch", letter: "ل", also: null, needle: "لا" })
    expect(assistPlan(memo, { enabled: true, required: "ا", also: null, draft: "لا خيل عندك" })).toEqual({
      kind: "fetch",
      letter: "ا",
      also: null,
      needle: "لا خيل عندك",
    })
  })

  it("keeps the two letters' answers apart", () => {
    const memo = newAssistMemo()
    const items = [bait(2, "لا تحسب المجد تمرا أنت آكله", "لن تبلغ المجد")]
    rememberAssist(memo, "ل", "لا تحسب", items)
    expect(memo.hits.has(needleKey("ل", "لا تحسب"))).toBe(true)
    expect(assistPlan(memo, { enabled: true, required: "ا", also: null, draft: "لا تحسب" })).toEqual({
      kind: "fetch",
      letter: "ا",
      also: null,
      needle: "لا تحسب",
    })
  })

  it("knownEmpty walks prefixes, not the whole set", () => {
    const memo = newAssistMemo()
    expect(knownEmpty(memo, "ل", "لا خيل")).toBe(false)
    rememberAssist(memo, "ل", "لا", [])
    expect(knownEmpty(memo, "ل", "لا خيل عندك تهديها")).toBe(true)
    expect(knownEmpty(memo, "و", "لا خيل عندك تهديها")).toBe(false)
  })
})

describe("assistFillText — what a click puts in the field", () => {
  it("is the whole بيت, so the exact-hash lookup hits `h_full`", () => {
    expect(assistFillText(bait(1, "لا خيل عندك", "فليسعد النطق"))).toBe("لا خيل عندك فليسعد النطق")
  })

  it("is the صدر alone for a بيت the source left without an عجز", () => {
    expect(assistFillText(bait(1, "لا خيل عندك", null))).toBe("لا خيل عندك")
  })
})
