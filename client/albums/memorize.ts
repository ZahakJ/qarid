/**
 * «أضِفه إلى التحفيظ» — a ديوان's أبيات as SRS cards, and the sentence that
 * reports what actually happened.
 *
 * Pure, and separate from the panel that calls it, because the two things worth
 * getting right here are both testable without a screen:
 *
 *  • WHICH أبيات become cards. Only the RESOLVED ones: an entry today's
 *    artefact cannot find still renders on the shelf from its snapshot, but it
 *    has no `baytKey`, no poem to open and no عجز the drill can rule a blank
 *    for — so it is not a card, and the count says so by simply not counting it.
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
import type { AlbumEntry } from "../../shared/schema.ts"
import { seedOf, type CardSeed } from "../training/schedule.ts"

/** The shelf's أبيات that today's artefact can still answer, as card seeds. */
export function memorizeSeeds(entries: readonly AlbumEntry[]): CardSeed[] {
  const seeds: CardSeed[] = []
  const taken = new Set<string>()
  for (const entry of entries) {
    if (entry.bait === null) continue
    // A shelf can hold the same بيت once (UNIQUE(album_id, h_full)), but two
    // anchors CAN resolve to one copy after a rebuild folded a duplicate
    // قصيدة — and `introduce` would then be handed the same id twice and count
    // the second as «already yours».
    if (taken.has(entry.bait.baytKey)) continue
    taken.add(entry.bait.baytKey)
    seeds.push(seedOf(entry.bait))
  }
  return seeds
}

/** «أُضيف 24 بيتًا، و6 أبيات عندك من قبل» — and every degenerate case. */
export function importedMessage(added: number, already: number): string {
  if (added === 0) {
    if (already === 0) return "لا أبيات هنا تصلح للتحفيظ"
    return "كلّ أبيات هذا الديوان في تحفيظك أصلًا"
  }
  if (already === 0) return `أُضيف ${formatBaits(added)} إلى التحفيظ`
  // «عندك من قبل», not «كانت عندك»: a VERB would have to agree with the معدود
  // in number and gender («بيتٌ كان», «بيتان كانا», «أبياتٌ كانت»), and the one
  // thing this module exists to prevent is a phrase assembled out of parts that
  // do not agree. A شبه جملة agrees with nothing and is true for every count.
  return `أُضيف ${formatBaits(added)}، و${formatBaits(already)} عندك من قبل`
}
