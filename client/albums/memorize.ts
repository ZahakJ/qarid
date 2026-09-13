/**
 * «أضِفه إلى التحفيظ» — a ديوان's أبيات as SRS cards, and the sentence that
 * reports what actually happened.
 *
 * Pure, and separate from the panel that calls it, because the three things
 * worth getting right here are all testable without a screen:
 *
 *  • WHICH أبيات are gathered. A shelf is a playlist — its entries are whole
 *    قصائد and single أبيات — so the أبيات have to be COLLECTED first, in the
 *    shelf's order: a بيت entry brings its one live row, a قصيدة entry brings
 *    its أبيات through the fetcher the caller hands in (the panel's is
 *    `getPoemBaits`; the test's is a table). Only the RESOLVED entries count —
 *    one today's artefact cannot find still renders from its snapshot, but it
 *    has no `baytKey`, no poem to open and no عجز the drill can rule a blank
 *    for, so it is not a card. And the gathering stops at `ALBUM_LIMITS.memorize`
 *    أبيات, because a playlist of long قصائد would otherwise drop a thousand
 *    cards into a deck at once, all of them due.
 *  • WHICH become cards. One per بيت: a shelf can hold the same بيت under a
 *    single entry and inside a قصيدة, and `introduce` would then be handed the
 *    same id twice and count the second as «already yours».
 *  • WHAT THE TOAST SAYS. The deck is local and the reader may have met these
 *    أبيات in a duel, in the drill, or in this same ديوان last week; a flat
 *    «أُضيف 30» over a deck that took six would be a lie the reader can check.
 *    So the split is honest — «أُضيف 24 بيتًا، و6 أبيات عندك من قبل» — and العدد
 *    والمعدود go through `shared/format.ts` like every other counted phrase.
 *
 * The dedupe itself is `trainingStore.introduce`'s: it skips a seed whose `id`
 * is already a card and returns only the cards it MADE. That id is the
 * `baytKey`, produced by the one `seedOf` in `client/training/schedule.ts`, so a
 * بيت imported from a shelf and the same بيت offered by the drill are one card.
 */

import { formatBaits } from "../../shared/format.ts"
import { ALBUM_LIMITS, type AlbumEntry, type BaitDto } from "../../shared/schema.ts"
import { seedOf, type CardSeed } from "../training/schedule.ts"

/** How a قصيدة entry's أبيات are fetched — `getPoemBaits`'s shape, narrowed. */
export type PoemBaitsFetcher = (publicId: string, limit: number) => Promise<readonly BaitDto[]>

export type Gathered = {
  /** the أبيات, in shelf order, at most `ALBUM_LIMITS.memorize` */
  baits: BaitDto[]
  /** how many the shelf holds past the cap — said in the toast, never hidden */
  left: number
}

/** The shelf's أبيات that today's artefact can answer, in shelf order, capped. */
export async function gatherAlbumBaits(
  entries: readonly AlbumEntry[],
  fetchPoem: PoemBaitsFetcher,
  cap: number = ALBUM_LIMITS.memorize,
): Promise<Gathered> {
  const baits: BaitDto[] = []
  let left = 0
  for (const entry of entries) {
    if (entry.kind === "bait") {
      if (entry.bait === null) continue
      if (baits.length >= cap) left += 1
      else baits.push(entry.bait)
      continue
    }
    if (entry.poem === null) continue
    const room = cap - baits.length
    if (room <= 0) {
      left += entry.poem.baitCount
      continue
    }
    // Ask for exactly what fits: a 951-بيت قصيدة behind a 300-card cap is one
    // request for 300, not four for 951 and a slice.
    const rows = await fetchPoem(entry.poem.id, Math.min(room, entry.poem.baitCount))
    const taken = [...rows].sort((x, y) => x.position - y.position).slice(0, room)
    baits.push(...taken)
    left += Math.max(0, entry.poem.baitCount - taken.length)
  }
  return { baits, left }
}

/** One seed per بيت — the same بيت reached twice is one card. */
export function memorizeSeeds(baits: readonly BaitDto[]): CardSeed[] {
  const seeds: CardSeed[] = []
  const taken = new Set<string>()
  for (const bait of baits) {
    if (taken.has(bait.baytKey)) continue
    taken.add(bait.baytKey)
    seeds.push(seedOf(bait))
  }
  return seeds
}

/** «أُضيف 24 بيتًا، و6 أبيات عندك من قبل» — and every degenerate case. */
export function importedMessage(added: number, already: number, left = 0): string {
  let text: string
  if (added === 0) {
    if (already === 0) return "لا أبيات هنا تصلح للتحفيظ"
    text = "كلّ أبيات هذا الديوان في تحفيظك أصلًا"
  } else if (already === 0) {
    text = `أُضيف ${formatBaits(added)} إلى التحفيظ`
  } else {
    // «عندك من قبل», not «كانت عندك»: a VERB would have to agree with the معدود
    // in number and gender («بيتٌ كان», «بيتان كانا», «أبياتٌ كانت»), and the one
    // thing this module exists to prevent is a phrase assembled out of parts that
    // do not agree. A شبه جملة agrees with nothing and is true for every count.
    text = `أُضيف ${formatBaits(added)}، و${formatBaits(already)} عندك من قبل`
  }
  // The cap, said rather than hidden: the deck took what fits in one sitting.
  return left > 0 ? `${text} — وبقي ${formatBaits(left)} خارج الحدّ` : text
}
