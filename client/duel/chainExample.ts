/**
 * «الروي أم الحرف الأخير؟» — the setup screen's live example (v2.md §1).
 *
 * The chain-mode switch is the option the owner could not parse, and no wording
 * fixes that on its own: «يُقشَر حرف الوصل» explains a peel to someone who
 * already knows what a peel is. What explains it is a REAL بيت with its two
 * answers side by side — «الزُلالا ← الرويّ ل، والحرف الأخير ا» — so the two
 * segments of the control stop being two words and become two letters.
 *
 * Everything here is derived, never written down: `rawiyyOf` from
 * shared/arabic.ts is the same function the server chains on (CLAUDE.md's
 * one-normalizer invariant), so the example on the setup screen cannot drift
 * from the rule the duel enforces — the way `RulesView`'s peel table cannot.
 *
 * The بيت itself comes from the corpus when the corpus offers a useful one
 * (بيت اليوم, one cached request the home screen has usually already made) and
 * from `FALLBACK_EXAMPLE` when it does not: roughly half of all أبيات have no
 * peel at all — their روي IS their last letter — and an example where both
 * modes give the same answer teaches nothing about the difference between them.
 */
import { cleanText, rawiyyOf } from "../../shared/arabic.ts"
import type { BaitDto } from "../../shared/schema.ts"

export interface ChainExample {
  /** the whole بيت, for the caller that wants to show it */
  sadr: string
  ajuz: string
  /** the last WORD of the عجز — where both letters come from */
  word: string
  /** الروي, after the peel — what «الروي» mode demands */
  rawiyy: string
  /** the final letter as written — what «الحرف الأخير» mode demands */
  lastLetter: string
  /** do the two modes actually differ on this بيت? */
  peeled: boolean
  poet: string | null
}

/**
 * المتنبي, and a وصل ألف that peels cleanly: «الزُلالا» ends on ا, its روي is ل.
 * Vetted by hand against the artefact (poet «المتنبي», fame 3) — the same rule
 * `client/data/flavor.ts` follows: an attribution is printed only where it is
 * certain.
 */
export const FALLBACK_EXAMPLE: ChainExample = derive(
  "وَمَن يَكُ ذا فَمٍ مُرٍّ مَريضٍ",
  "يَجِد مُرّاً بِهِ الماءَ الزُلالا",
  "المتنبي",
)

/** The last word of a hemistich, tashkeel intact — what the example points at. */
export function lastWordOf(text: string): string {
  const words = cleanText(text).split(" ").filter((w) => w !== "")
  return words[words.length - 1] ?? ""
}

function derive(sadr: string, ajuz: string, poet: string | null): ChainExample {
  const { rawiyy, lastLetter } = rawiyyOf(ajuz)
  return {
    sadr: cleanText(sadr),
    ajuz: cleanText(ajuz),
    word: lastWordOf(ajuz),
    rawiyy: rawiyy ?? "",
    lastLetter: lastLetter ?? rawiyy ?? "",
    peeled: rawiyy !== null && lastLetter !== null && rawiyy !== lastLetter,
    poet,
  }
}

/**
 * A بيت off the wire as an example, or `null` when it cannot teach the
 * difference — no عجز (an `isPartial` بيت), or no peel to show.
 *
 * `null` is not a failure: it is the caller's cue to keep `FALLBACK_EXAMPLE`,
 * which always peels.
 */
export function exampleFrom(bait: BaitDto | null | undefined): ChainExample | null {
  if (!bait || bait.ajuz === null || bait.ajuz.trim() === "") return null
  const example = derive(bait.sadr, bait.ajuz, bait.poet.name)
  if (!example.peeled || example.word === "") return null
  return example
}
