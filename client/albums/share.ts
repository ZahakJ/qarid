/**
 * The text that leaves the app when a ديوان is shared — `client/duel/share.ts`'s
 * shape, for the same reasons.
 *
 *     قريض — ديوان «ما أحفظه»
 *     جَمَعه أبو الطيب · 7 قصائد و12 بيتًا
 *     https://qarid.example.com/#/diwan/BADIRUKAMO
 *
 * Pure text, pure function: no clipboard, no DOM, no `location`. The caller
 * hands in the link, this file only decides what the block SAYS. Two rules it
 * inherits and neither is decoration: the معدود goes through
 * `shared/format.ts` («بيت واحد», «بيتان», «12 بيتًا» — never «12 بيت»), and
 * EVERY line opens with U+200F, because this block lands in Latin-first chat
 * apps and a line that begins with a neutral character (the `h` of `https`)
 * otherwise flips the whole line to the wrong side.
 */
import { RLM, formatAlbumContents } from "../../shared/format.ts"

export type AlbumShareInput = {
  title: string
  /** the curator's display name — «جَمَعه فلان» is half of what a ديوان IS */
  curator: string
  /** whole قصائد on the shelf */
  poems: number
  /** single أبيات on it */
  baits: number
  /** the shelf's own link; omitted for a private shelf, which has none that works */
  url?: string | null
}

export function albumShareText({ title, curator, poems, baits, url = null }: AlbumShareInput): string {
  const lines = [`قريض — ديوان «${title}»`]
  // An empty shelf says the thing in words rather than gluing a zero to a noun
  // (the duel's share block learned the same lesson the hard way); a full one
  // counts each kind through `shared/format.ts`.
  lines.push(
    poems + baits > 0
      ? `جَمَعه ${curator} · ${formatAlbumContents(poems, baits)}`
      : `جَمَعه ${curator} · لم يُوضع فيه شيءٌ بعد`,
  )
  if (url) lines.push(url)
  return RLM + lines.join(`\n${RLM}`)
}
