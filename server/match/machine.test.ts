/**
 * The account-less مساجلة state machine, with no corpus and no clock: every
 * transition is fed plain data and a `now`, and the verifier's answer is
 * written by hand in the shape `verifyAnswer` returns.
 */
import { describe, expect, it } from "vitest"

import { MAX_ROOM_TURNS, type BaitDto, type ChainState, type GameVerifyResponse } from "../../shared/schema.ts"
import { normalizeMatchName } from "../../shared/match.ts"
import {
  DONE_TTL_MS,
  IDLE_TTL_MS,
  WAITING_TTL_MS,
  admitKnock,
  applyAnswer,
  chainOf,
  createMatch,
  dueAt,
  isPurgeable,
  joinMatch,
  knockMatch,
  knockView,
  newMatchCode,
  refuseKnock,
  resignMatch,
  seatFor,
  settle,
  snapshotOf,
  turnSeatOf,
  verifyInputOf,
  type MatchRecord,
} from "./machine.ts"
import { hashSecret } from "./secrets.ts"

const T0 = 1_000_000
const HOST = hashSecret("host-secret")
const GUEST = hashSecret("guest-secret")
const KEY = hashSecret("the-invite-key")

function bait(id: number, poemId = id * 10): BaitDto {
  return { id, sadr: `صدر ${id}`, ajuz: `عجز ${id}`, poem: { id: `q${poemId}`, poemId, title: "" } } as unknown as BaitDto
}

const chain: ChainState = { requiredLetter: "ب", requiredLetterSource: "rawiyy", alsoAccepted: [], mode: "rhyme", obscurity: 0 }

function accepted(id: number, letter = "د"): GameVerifyResponse {
  return {
    ok: true,
    matchKind: "exact",
    confidence: 1,
    normalized: "",
    bait: bait(id),
    poem: {} as never,
    poet: {} as never,
    ...chain,
    requiredLetter: letter,
  } as unknown as GameVerifyResponse
}

const wrongLetter: GameVerifyResponse = {
  ok: false,
  reason: "wrong_letter",
  expected: "ب",
  alsoAccepted: [],
  got: "م",
  normalized: "",
}
const notFound: GameVerifyResponse = { ok: false, reason: "not_found", normalized: "", suggestions: [] }
const tooShort: GameVerifyResponse = { ok: false, reason: "too_short", words: 1 }
const alreadyUsed = (id: number): GameVerifyResponse => ({ ok: false, reason: "already_used", bait: bait(id) })

function fresh(over: Partial<{ timerS: number | null; strikes: number }> = {}): MatchRecord {
  return createMatch({
    code: "BADIRU",
    hostSecretHash: HOST,
    joinKeyHash: KEY,
    hostName: "لبيد",
    opening: { bait: bait(1), poemId: 10, chain },
    mode: "rhyme",
    timerS: over.timerS === undefined ? 60 : over.timerS,
    strikes: over.strikes ?? 3,
    now: T0,
  })
}

function started(over: Parameters<typeof fresh>[0] = {}, at = T0 + 1000): MatchRecord {
  const out = joinMatch(fresh(over), { keyHash: KEY, secretHash: GUEST, name: "عنترة", now: at })
  if (!out.ok) throw new Error(out.code)
  return out.match
}

function answer(m: MatchRecord, seat: "host" | "guest", result: GameVerifyResponse, now: number) {
  const out = applyAnswer(m, { seat, text: "نص", result, now })
  if (!out.ok) throw new Error(out.code)
  return out
}

describe("create", () => {
  it("opens waiting, with the host seated and the opening بيت as turn 0", () => {
    const m = fresh()
    expect(m.status).toBe("waiting")
    expect(m.turns).toHaveLength(1)
    expect(m.turns[0]).toMatchObject({ turnNo: 0, seat: "host", verdict: "opening" })
    expect(m.expiresAt).toBe(T0 + WAITING_TTL_MS)
    expect(m.deadlineAt).toBeNull()
    expect(m.required?.requiredLetter).toBe("ب")
    expect(seatFor(m, HOST)).toBe("host")
    expect(seatFor(m, GUEST)).toBeNull()
  })

  it("draws a speakable code through the injected rng", () => {
    expect(newMatchCode(() => 0)).toBe("BABABA")
    let i = 0
    const seq = [1, 2, 3, 4, 5, 0]
    expect(newMatchCode(() => seq[i++]!)).toBe("DIHUKA")
  })
})

describe("join", () => {
  it("starts the clock with the right key and burns the key", () => {
    const m = started()
    expect(m.status).toBe("active")
    expect(m.startedAt).toBe(T0 + 1000)
    expect(m.deadlineAt).toBe(T0 + 1000 + 60_000)
    expect(m.expiresAt).toBeNull()
    expect(m.joinKeyHash).toBeNull()
    expect(seatFor(m, GUEST)).toBe("guest")
    expect(m.guest?.name).toBe("عنترة")
    expect(m.rev).toBe(1)
  })

  it("refuses a wrong key, a full match and a finished one", () => {
    expect(joinMatch(fresh(), { keyHash: hashSecret("nope"), secretHash: GUEST, name: null, now: T0 })).toEqual({
      ok: false,
      code: "needs_key",
    })
    expect(joinMatch(started(), { keyHash: KEY, secretHash: hashSecret("third"), name: null, now: T0 })).toEqual({
      ok: false,
      code: "match_full",
    })
    const closed = resignMatch(fresh(), "host", T0)
    if (!closed.ok) throw new Error()
    expect(joinMatch(closed.match, { keyHash: KEY, secretHash: GUEST, name: null, now: T0 })).toEqual({
      ok: false,
      code: "match_not_active",
    })
  })

  it("has no clock when the match has none", () => {
    expect(started({ timerS: null }).deadlineAt).toBeNull()
  })
})

describe("knock", () => {
  const K = hashSecret("knocker")

  it("holds one knocker, whom the host admits into the guest seat", () => {
    const k = knockMatch(fresh(), { secretHash: K, name: "طرفة", now: T0 + 5 })
    if (!k.ok) throw new Error(k.code)
    expect(knockView(k.match, K)?.status).toBe("pending")
    expect(knockMatch(k.match, { secretHash: hashSecret("second"), name: null, now: T0 })).toEqual({
      ok: false,
      code: "match_busy",
    })
    expect(snapshotOf(k.match, "host", T0).knock).toEqual({ name: "طرفة" })

    const a = admitKnock(k.match, "host", T0 + 10)
    if (!a.ok) throw new Error(a.code)
    expect(a.match.status).toBe("active")
    expect(seatFor(a.match, K)).toBe("guest")
    expect(a.match.knock).toBeNull()
    expect(knockView(a.match, K)?.status).toBe("accepted")
  })

  it("lets the host refuse, and only the host", () => {
    const k = knockMatch(fresh(), { secretHash: K, name: null, now: T0 })
    if (!k.ok) throw new Error()
    expect(refuseKnock(k.match, "guest", T0)).toEqual({ ok: false, code: "not_the_host" })
    expect(admitKnock(k.match, "guest", T0)).toEqual({ ok: false, code: "not_the_host" })
    const r = refuseKnock(k.match, "host", T0 + 1)
    if (!r.ok) throw new Error()
    expect(r.match.status).toBe("waiting")
    expect(knockView(r.match, K)?.status).toBe("rejected")
    expect(admitKnock(r.match, "host", T0)).toEqual({ ok: false, code: "no_knock" })
  })

  it("refuses the host knocking his own match, and any knock once it started", () => {
    expect(knockMatch(fresh(), { secretHash: HOST, name: null, now: T0 })).toEqual({ ok: false, code: "cannot_knock" })
    expect(knockMatch(started(), { secretHash: K, name: null, now: T0 })).toEqual({ ok: false, code: "match_full" })
  })

  it("tells a waiting knocker whose match started through the link that he was turned away", () => {
    const k = knockMatch(fresh(), { secretHash: K, name: null, now: T0 })
    if (!k.ok) throw new Error()
    const j = joinMatch(k.match, { keyHash: KEY, secretHash: GUEST, name: null, now: T0 + 1 })
    if (!j.ok) throw new Error()
    expect(knockView(j.match, K)?.status).toBe("rejected")
    expect(knockView(fresh(), K)).toBeNull()
  })
})

describe("turns", () => {
  it("the guest answers first; out of turn is refused before the verifier is asked", () => {
    const m = started()
    expect(turnSeatOf(m)).toBe("guest")
    expect(verifyInputOf(m, "host", "x")).toEqual({ ok: false, code: "not_your_turn" })
    expect(applyAnswer(m, { seat: "host", text: "x", result: accepted(2), now: T0 })).toEqual({
      ok: false,
      code: "not_your_turn",
    })
    const input = verifyInputOf(m, "guest", "نص")
    expect(input.ok && input.request).toMatchObject({ prevBaitId: 1, usedBaitIds: [1], usedPoemIds: [10], mode: "rhyme" })
  })

  it("is refused while waiting and once done", () => {
    expect(verifyInputOf(fresh(), "host", "x")).toEqual({ ok: false, code: "match_not_active" })
    const done = resignMatch(started(), "guest", T0)
    if (!done.ok) throw new Error()
    expect(verifyInputOf(done.match, "host", "x")).toEqual({ ok: false, code: "match_not_active" })
    expect(applyAnswer(done.match, { seat: "host", text: "x", result: accepted(2), now: T0 })).toEqual({
      ok: false,
      code: "match_not_active",
    })
  })

  it("an accepted بيت extends the chain, passes the turn and re-arms the clock", () => {
    const m = started()
    const out = answer(m, "guest", accepted(2, "د"), T0 + 5000)
    expect(out.persisted).toBe(true)
    expect(out.verdict).toMatchObject({ strike: false, strikesLeft: 3 })
    expect(chainOf(out.match)).toHaveLength(2)
    expect(turnSeatOf(out.match)).toBe("host")
    expect(out.match.required?.requiredLetter).toBe("د")
    expect(out.match.deadlineAt).toBe(T0 + 5000 + 60_000)
    expect(out.match.turns[1]).toMatchObject({ turnNo: 1, seat: "guest", verdict: "ok", msTaken: 4000, poemId: 20 })
    const next = verifyInputOf(out.match, "host", "x")
    expect(next.ok && next.request).toMatchObject({ prevBaitId: 2, usedBaitIds: [1, 2], usedPoemIds: [10, 20] })
  })

  it("a strike stays with the same seat, re-arms the clock and counts down", () => {
    const m = started({ strikes: 2 })
    const one = answer(m, "guest", wrongLetter, T0 + 2000)
    expect(one.persisted).toBe(true)
    expect(one.verdict).toMatchObject({ strike: true, strikesLeft: 1 })
    expect(turnSeatOf(one.match)).toBe("guest")
    expect(one.match.deadlineAt).toBe(T0 + 2000 + 60_000)
    expect(one.match.turns[1]).toMatchObject({ verdict: "wrong_letter", bait: null })
    expect(one.match.status).toBe("active")

    const two = answer(one.match, "guest", notFound, T0 + 3000)
    expect(two.verdict).toMatchObject({ strike: true, strikesLeft: 0 })
    expect(two.match).toMatchObject({ status: "done", winner: "host", endReason: "strikes", deadlineAt: null })
  })

  it("a soft refusal changes nothing", () => {
    const m = started()
    for (const result of [tooShort, alreadyUsed(1)]) {
      const out = answer(m, "guest", result, T0 + 2000)
      expect(out.persisted).toBe(false)
      expect(out.match).toBe(m)
      expect(out.verdict).toMatchObject({ strike: false, strikesLeft: 3 })
    }
  })

  it("stops a chain that reaches the cap, without a winner", () => {
    let m = started({ timerS: null })
    let seat: "host" | "guest" = "guest"
    for (let id = 2; chainOf(m).length < MAX_ROOM_TURNS; id++) {
      m = answer(m, seat, accepted(id), T0 + id).match
      seat = seat === "guest" ? "host" : "guest"
    }
    expect(m).toMatchObject({ status: "done", winner: null, endReason: "abandoned" })
  })
})

describe("time", () => {
  it("a passed deadline loses the turn for whoever owed it", () => {
    const m = started()
    expect(settle(m, m.deadlineAt! - 1).changed).toBe(false)
    const s = settle(m, m.deadlineAt!)
    expect(s.changed).toBe(true)
    expect(s.match).toMatchObject({ status: "done", winner: "host", endReason: "timeout" })
    expect(settle(s.match, m.deadlineAt! + 99).changed).toBe(false)

    const hostOwes = answer(m, "guest", accepted(2), T0 + 2000).match
    expect(settle(hostOwes, hostOwes.deadlineAt!).match.winner).toBe("guest")
  })

  it("a waiting match expires without a winner", () => {
    const m = fresh()
    expect(settle(m, T0 + WAITING_TTL_MS - 1).changed).toBe(false)
    expect(settle(m, T0 + WAITING_TTL_MS).match).toMatchObject({ status: "done", winner: null, endReason: "abandoned" })
  })

  it("an unclocked match nobody touches is closed after the idle window", () => {
    const m = started({ timerS: null })
    expect(settle(m, m.updatedAt + IDLE_TTL_MS - 1).changed).toBe(false)
    expect(settle(m, m.updatedAt + IDLE_TTL_MS).match).toMatchObject({ status: "done", endReason: "abandoned" })
  })

  it("dueAt names the next thing that can happen, and a done match purges after its TTL", () => {
    expect(dueAt(fresh())).toBe(T0 + WAITING_TTL_MS)
    const m = started()
    expect(dueAt(m)).toBe(m.deadlineAt)
    const done = resignMatch(m, "host", T0 + 5000)
    if (!done.ok) throw new Error()
    expect(dueAt(done.match)).toBe(T0 + 5000 + DONE_TTL_MS)
    expect(isPurgeable(done.match, T0 + 5000 + DONE_TTL_MS - 1)).toBe(false)
    expect(isPurgeable(done.match, T0 + 5000 + DONE_TTL_MS)).toBe(true)
    expect(isPurgeable(m, Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})

describe("resign", () => {
  it("hands the match to the other seat", () => {
    const out = resignMatch(started(), "guest", T0 + 9)
    expect(out.ok && out.match).toMatchObject({ status: "done", winner: "host", endReason: "resign", endedAt: T0 + 9 })
  })

  it("closes a waiting match for the host, and is a no-op once done", () => {
    const out = resignMatch(fresh(), "host", T0)
    if (!out.ok) throw new Error()
    expect(out.match).toMatchObject({ status: "done", winner: null, endReason: "abandoned" })
    const again = resignMatch(out.match, "host", T0 + 5)
    expect(again.ok && again.match).toBe(out.match)
    expect(resignMatch(fresh(), "guest", T0)).toEqual({ ok: false, code: "not_the_host" })
  })
})

describe("snapshot", () => {
  it("is per seat: canPlay, the knock, and nothing past the end", () => {
    const m = started()
    expect(snapshotOf(m, "guest", T0).you).toEqual({ seat: "guest", canPlay: true })
    expect(snapshotOf(m, "host", T0).you).toEqual({ seat: "host", canPlay: false })
    expect(snapshotOf(m, "host", T0).deadlineAt).toBe(m.deadlineAt)
    const done = resignMatch(m, "guest", T0)
    if (!done.ok) throw new Error()
    const s = snapshotOf(done.match, "host", T0)
    expect(s).toMatchObject({ turnSeat: null, deadlineAt: null, required: null, winner: "host" })
    expect(s.you.canPlay).toBe(false)
  })

  it("connection state changes the presence dot and nothing else", () => {
    // Reconnection is not a transition: the same record at the same instant
    // is the same match whether zero, one or both seats are connected.
    const m = started()
    const offline = snapshotOf(m, "guest", T0 + 5, { host: false, guest: false })
    const online = snapshotOf(m, "guest", T0 + 5, { host: true, guest: true })
    expect({ ...online, host: { ...online.host, connected: false }, guest: { ...online.guest!, connected: false } }).toEqual(
      offline,
    )
    expect(settle(m, T0 + 5).changed).toBe(false)
  })

  it("names both players to the seated players", () => {
    const s = snapshotOf(started(), "guest", T0)
    expect(s.host.name).toBe("لبيد")
    expect(s.guest?.name).toBe("عنترة")
  })
})

describe("normalizeMatchName", () => {
  it("trims, collapses, strips control and bidi characters, and caps the length", () => {
    expect(normalizeMatchName("  أبو   تمّام  ")).toBe("أبو تمّام")
    expect(normalizeMatchName("‮evil‬")).toBe("evil")
    expect(normalizeMatchName("a\u0000b​c")).toBe("abc")
    expect(normalizeMatchName("ｆｕｌｌ")).toBe("full")
    expect(normalizeMatchName("x".repeat(100))).toHaveLength(24)
    expect(normalizeMatchName("   ")).toBeNull()
    expect(normalizeMatchName(undefined)).toBeNull()
    expect(normalizeMatchName(42)).toBeNull()
  })
})
