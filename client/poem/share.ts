/**
 * The text that leaves the app when a قصيدة is shared — `client/albums/share.ts`'s
 * shape, for the same reasons.
 *
 *     قريض — قصيدة «على قدر أهل العزم تأتي العزائم»
 *     أبو الطيب المتنبي · 41 بيتًا
 *     https://qarid.example.com/p/16182
 *
 * Pure text, pure function: no clipboard, no DOM, no `location`. The caller
 * hands in the link, this file only decides what the block SAYS.
 *
 * Why a BLOCK and not the bare URL: «نسخ القصيدة» already exists and puts all
 * 41 أبيات in the chat window, which is the thing a reader is trying NOT to do
 * when he shares a long قصيدة. A bare link is the other extreme and says
 * nothing about what is behind it. Three lines name the قصيدة, its شاعر and
 * its length, and then point at it.
 *
 * Four rules it inherits, none of them decoration:
 *  1. EVERY line opens with U+200F. The block lands in Latin-first chat apps,
 *     and a line that begins with a neutral character (the `h` of `https`)
 *     otherwise flips end to end.
 *  2. The معدود goes through `shared/format.ts` — «بيت واحد», «بيتان»,
 *     «41 بيتًا», never «41 بيت».
 *  3. The شاعر is named BARE, with no لام of attribution — see below.
 *  4. Western digits, like every other number in the app.
 */
import { BAYT_FORMS, RLM, countedNoun } from "../../shared/format.ts"

export type PoemShareInput = {
  /** the page's own heading — عنوان, or the مطلع standing in for a missing one */
  heading: string
  /** true when `heading` is that مطلع rather than a real عنوان */
  isMatla: boolean
  /** the شاعر's name, as displayed */
  poet: string
  /** أبيات in the whole قصيدة, not the page that happens to be loaded */
  count: number
  /** the قصيدة's link; omitted only by a caller that has none to give */
  url?: string | null
}

/**
 * `headingOf` hangs an ellipsis on a مطلع so the PAGE reads as a heading rather
 * than a truncated sentence. Inside «…» quotes in a chat window that ellipsis
 * is noise, so it comes off here rather than every caller having to know.
 */
function undecorate(heading: string): string {
  return heading.replace(/\s*[…]+\s*$/u, "").trim()
}

/**
 * The قصيدة's shareable address — `/p/<id>`, a real PATH and not the app's own
 * `#/poem/<id>`.
 *
 * A hash fragment never reaches a server, so a hash link cannot be given that
 * قصيدة's preview tags and unfurls as the same generic card as the other
 * 238,732. This path can, and folds straight back into the hash route at boot
 * (server/share.ts, client/router.ts).
 *
 * The origin is passed in because this module must not read `location`: inside
 * the APK that is `https://localhost` and the link would be born dead. The
 * caller uses `shareOrigin()`.
 */
export function poemShareUrl(origin: string, id: string): string {
  return `${origin.replace(/\/+$/, "")}/p/${encodeURIComponent(id)}`
}

export function poemShareText({ heading, isMatla, poet, count, url = null }: PoemShareInput): string {
  const name = undecorate(heading)
  /* An untitled قصيدة is named by its مطلع, and «قصيدة مطلعها «…»» is how that
     is said out loud. «قصيدة «…»» over a first hemistich claims a عنوان the
     قصيدة has not got — which is the very thing the مطلع is standing in for. */
  const lines = [name ? (isMatla ? `قريض — قصيدة مطلعها «${name}»` : `قريض — قصيدة «${name}»`) : "قريض — قصيدة"]

  /* The شاعر is named bare — «أبو الطيب المتنبي», the attribution idiom
     `formatBaytWithPoet` already uses — and NOT through `lamPrefix`.

     The لام is a preposition, so what follows it is مجرور, and these names are
     stored in the nominative: `lamPrefix` renders «لأبو الطيب» where the Arabic
     is «لأبي الطيب». It is right for «للأرجاني» and wrong for every أبو/أخو
     name in the corpus — الأسماء الخمسة decline in the LETTERS, not in an
     unwritten vowel — and أبو تمام، أبو نواس، أبو العلاء، أبو فراس are a good
     part of this canon. `lamPrefix`'s one caller puts it in front of a COUNT
     («لـ6,941 شاعرًا»), where nothing has to agree; a name is not that, and
     declining one properly is not a job for a formatter. */
  const credit = poet.trim()
  /* `countedNoun(0, …)` returns «لا أبيات» — a whole clause, not a معدود — so a
     zero drops the segment instead of gluing that onto the شاعر. The ingest
     keeps no verse-less قصيدة, but the duel's block shipped «سلسلة من لا أبيات»
     by trusting exactly this sort of "cannot happen". */
  const length = count > 0 ? countedNoun(count, BAYT_FORMS) : ""
  const second = [credit, length].filter(Boolean).join(" · ")
  if (second) lines.push(second)

  if (url) lines.push(url)
  return RLM + lines.join(`\n${RLM}`)
}
