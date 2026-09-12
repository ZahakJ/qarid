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
  countedUnit,
  formatCount,
  RLM,
} from "../../shared/format.ts"

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

export function shareText({
  dayKey,
  letters,
  chainLength,
  score,
  stumped = false,
  poetName = null,
  albumTitle = null,
}: ShareInput): string {
  const scoped = albumTitle ? `مساجلة في ديوان «${albumTitle}»` : poetName ? `مساجلة في ديوان ${poetName}` : "مساجلة"
  const head = dayKey ? `قريض — تحدّي ${arabicDay(dayKey)}` : `قريض — ${scoped}`
  const lines = [head]
  if (letters.length) lines.push(letterRibbon(letters))
  /* `countedNounGenitive(0, …)` returns «لا أبيات» — a whole CLAUSE, not a
     معدود — so «سلسلة من» glued in front of it produced «سلسلة من لا أبيات»,
     in the one string that LEAVES the app. DuelSummaryView guards the same
     call («لم تبدأ المساجلة»); this one did not. */
  const chain = chainLength > 0 ? `سلسلة من ${countedNounGenitive(chainLength, BAYT_FORMS)} · ` : "لم أبلغ بيتًا · "
  const tail = `${chain}${formatCount(score)} ${countedUnit(score, NUQTA_FORMS)}`
  lines.push(stumped ? `${tail} · أفحمتُ الخصم` : tail)
  // The block lands in Latin-first chat apps, so EVERY line opens with U+200F,
  // exactly as client/bayt/copy.ts requires of every copy path — one prefix for
  // the whole block leaves lines two and three unprotected the moment one of
  // them starts with a neutral character.
  return RLM + lines.join(`\n${RLM}`)
}
