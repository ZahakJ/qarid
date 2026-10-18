/**
 * The shareable block (design-ux.md §5 Daily):
 *
 *     قريض — تحدّي 23 آب
 *     ن ← م ← ب ← ر
 *     سلسلة من 6 أبيات · 740 نقطة
 *
 * Pure text, pure functions: no clipboard, no DOM, no clock. The caller
 * supplies the day and the exchanges; this file only decides what the block
 * says. Numbers go through `shared/format.ts` so the digits match the rest of
 * the UI, and the arrow is `←` because under RTL that is the one that means
 * "next" (amendments.md §15).
 */
import {
  arabicDay,
  BAYT_FORMS,
  NUQTA_FORMS,
  countedNounGenitive,
  copyableBayt,
  countedNoun,
  countedUnit,
  formatCount,
  RLM,
} from "../../shared/format.ts"
import type { RoomSeat } from "../../shared/schema.ts"
import { displayText, displayTextOrNull } from "../bayt/tashkeel.ts"

/** The chain, oldest first, joined with the RTL "next" arrow. */
export function letterRibbon(letters: readonly string[]): string {
  return letters.join(" ← ")
}

export type ShareInput = {
  /** null for a normal duel — only the daily challenge is dated */
  dayKey?: string | null
  letters: readonly string[]
  /** أبيات the PLAYER landed */
  chainLength: number
  score: number
  /** «أفحمتَ الخصم» */
  stumped?: boolean
  /**
   * The شاعر the duel was scoped to («القيود»), by NAME — `config.poetName`.
   *
   * A مساجلة في ديوان المتنبي is a different feat from a مساجلة against the
   * whole corpus (his ديوان answers on four letters where the ديوان answers on
   * twenty-eight), so the block that leaves the app has to say which one it was
   * or the number under it means nothing. The عصر and البحر قيود are NOT in
   * this line on purpose: they narrow a pool, while a شاعر names an opponent,
   * and «مساجلة في العصر العباسي من الطويل» is a filter read aloud rather than
   * something to say.
   */
  poetName?: string | null
  /**
   * The ديوان a reader COMPILED, when the مساجلة was played inside one
   * (`config.album.title`). It wins over `poetName` for the same reason that
   * one wins over عصر and بحر: it is the closest thing to naming an opponent —
   * these are the أبيات somebody chose, and answering them is a different feat
   * from answering the corpus.
   */
  albumTitle?: string | null
}

export function shareText(input: ShareInput): string {
  const lines = [shareHead(input)]
  if (input.letters.length) lines.push(letterRibbon(input.letters))
  lines.push(shareTail(input))
  // The block lands in Latin-first chat apps, so EVERY line opens with U+200F,
  // exactly as client/bayt/copy.ts requires of every copy path — one prefix for
  // the whole block leaves lines two and three unprotected the moment one of
  // them starts with a neutral character.
  return RLM + lines.join(`\n${RLM}`)
}

/** «قريض — مساجلة في ديوان المتنبي» / «قريض — تحدّي 23 آب». */
export function shareHead({ dayKey, poetName = null, albumTitle = null }: Pick<ShareInput, "dayKey" | "poetName" | "albumTitle">): string {
  const scoped = albumTitle ? `مساجلة في ديوان «${albumTitle}»` : poetName ? `مساجلة في ديوان ${poetName}` : "مساجلة"
  return dayKey ? `قريض — تحدّي ${arabicDay(dayKey)}` : `قريض — ${scoped}`
}

/** «سلسلة من 6 أبيات · 740 نقطة», with «أفحمتُ الخصم» when it was. */
export function shareTail({ chainLength, score, stumped = false }: Pick<ShareInput, "chainLength" | "score" | "stumped">): string {
  /* `countedNounGenitive(0, …)` returns «لا أبيات» — a whole CLAUSE, not a
     معدود — so «سلسلة من» glued in front of it produced «سلسلة من لا أبيات»,
     in the one string that LEAVES the app. DuelSummaryView guards the same
     call («لم تبدأ المساجلة»); this one did not. */
  const chain = chainLength > 0 ? `سلسلة من ${countedNounGenitive(chainLength, BAYT_FORMS)} · ` : "لم أبلغ بيتًا · "
  const tail = `${chain}${formatCount(score)} ${countedUnit(score, NUQTA_FORMS)}`
  return stumped ? `${tail} · أفحمتُ الخصم` : tail
}

export type TranscriptTurn = {
  /** who SAID it — a display name, «الخصم», never the شاعر */
  who: string
  sadr: string
  ajuz: string | null
  /** who WROTE it; the line is dropped when the corpus has no name */
  poet: string | null
}

export type TranscriptInput = {
  /** «قريض — مساجلة: …», already worded by the caller */
  head: string
  turns: readonly TranscriptTurn[]
  /** how it ended, one line: «الغلبة: كرم · 6 أبيات» */
  tail?: string | null
}

/**
 * The whole مساجلة as text — every بيت under the name of whoever said it:
 *
 *     ‏قريض — مساجلة: كرم وزيد
 *     ‏
 *     ‏كرم:
 *     ‏الخيل والليل والبيداء تعرفني … والسيف والرمح والقرطاس والقلم
 *     ‏— المتنبي
 *     ‏
 *     ‏الغلبة: كرم · 6 أبيات
 *
 * Each بيت is `formatBaytWithPoet`'s two lines (client/bayt/copy.ts) under a
 * speaker line, because a بيت in a مساجلة has TWO names and the copy must not
 * merge them: «كرم — المتنبي» reads as one person. A strike is not a بيت and
 * is not in the block. The caller passes text AS DISPLAYED (rule 3); every
 * line, blank ones included, opens with U+200F (rule 1).
 */
export function transcriptText({ head, turns, tail = null }: TranscriptInput): string {
  const lines = [head.trim()]
  for (const t of turns) {
    lines.push("", `${t.who.trim()}:`, baytOf(t.sadr, t.ajuz))
    const poet = t.poet?.trim()
    if (poet) lines.push(`— ${poet}`)
  }
  if (tail?.trim()) lines.push("", tail.trim())
  return RLM + lines.join(`\n${RLM}`)
}

/** `صدر … عجز` on one line, unprefixed — the prefix is the block's (rule 2). */
function baytOf(sadr: string, ajuz: string | null): string {
  return copyableBayt(sadr.trim(), ajuz?.trim() ? ajuz.trim() : null).slice(RLM.length)
}

/**
 * «قريض — مساجلة: كرم وزيد»; «قريض — مساجلة» until there are two names. Not
 * «بين كرم وأبو فهد»: after بين the name is مجرور and الأسماء الخمسة show it,
 * so names stay bare behind a colon (the share-text invariant again).
 */
export function betweenHead(a: string | null, b: string | null): string {
  const names = [a, b].map((n) => n?.trim() ?? "").filter(Boolean)
  if (names.length < 2) return "قريض — مساجلة"
  // و joins the word after it — unless that word does not open on an Arabic
  // letter, which nothing can join to (the `lamPrefix` rule, shared/format.ts)
  const second = /^[\u0621-\u064a]/.test(names[1]!) ? `و${names[1]}` : `و ${names[1]}`
  return `قريض — مساجلة: ${names[0]} ${second}`
}

export type SeatTurn = {
  seat: RoomSeat
  /** null on a strike — which the block leaves out */
  bait: { sadr: string; ajuz: string | null; poet: { name: string } | null } | null
}

/**
 * A finished room or match, two people by name — the one builder RoomView and
 * MatchView share, so «شارك الأبيات» says the same thing on both. `winner` is
 * the winning seat's NAME, or null when nobody won.
 */
export function seatTranscript({
  turns,
  nameOf,
  winner,
  tashkeel,
}: {
  turns: readonly SeatTurn[]
  nameOf: (seat: RoomSeat) => string
  winner: string | null
  tashkeel: boolean
}): string {
  const said = turns.filter((t): t is SeatTurn & { bait: NonNullable<SeatTurn["bait"]> } => t.bait !== null)
  const count = countedNoun(said.length, BAYT_FORMS)
  return transcriptText({
    head: betweenHead(nameOf("host"), nameOf("guest")),
    turns: said.map((t) => ({
      who: nameOf(t.seat),
      sadr: displayText(t.bait.sadr, tashkeel),
      ajuz: displayTextOrNull(t.bait.ajuz, tashkeel),
      poet: t.bait.poet?.name ?? null,
    })),
    // bare after a colon, never «ل» + name: «لأبو فهد» (docs/internals.md, the
    // share-text invariant)
    tail: winner ? `الغلبة: ${winner} · ${count}` : `انتهت المساجلة · ${count}`,
  })
}
