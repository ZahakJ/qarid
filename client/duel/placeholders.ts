/**
 * The rotating placeholder in the answer field (design-ux.md §4 Play).
 *
 * DELIBERATE DEVIATION: §4 says the placeholder rotates "real corpus openings
 * with the required letter". A real opening on the required letter IS a
 * winning answer — it would hand the player for free what «أول كلمة» charges
 * 60 points for. So the rotation runs over famous مطالع that show the SHAPE of
 * an answer (صدر … عجز on one line) without ever standing on the letter in
 * play, and the field says «مثال» so nobody mistakes it for a hint.
 *
 * سيف (brutal) gets no placeholder at all, exactly as §4 requires.
 */
import { rngFrom } from "../../shared/rng.ts"

/** مطالع every reader of Arabic knows — used as typing examples only. */
export const OPENINGS: readonly string[] = [
  "قِفا نَبكِ مِن ذِكرى حَبيبٍ وَمَنزِلِ",
  "عَلى قَدرِ أَهلِ العَزمِ تَأتي العَزائِمُ",
  "الخَيلُ وَاللَيلُ وَالبَيداءُ تَعرِفُني",
  "أَراكَ عَصِيَّ الدَمعِ شيمَتُكَ الصَبرُ",
  "إِذا الشَعبُ يَوماً أَرادَ الحَياةَ",
  "وَما نَيلُ المَطالِبِ بِالتَمَنّي",
  "سَلامٌ مِن صَبا بَرَدى أَرَقُّ",
  "أَلا لَيتَ الشَبابَ يَعودُ يَوماً",
  "وَإِذا كانَتِ النُفوسُ كِباراً",
  "بِلادي وَإِن جارَت عَلَيَّ عَزيزَةٌ",
]

/**
 * Deterministic per (seed, turn) so the same duel replays identically and a
 * re-render never shuffles the field out from under the player.
 *
 * v2.md §1 wants the placeholder to SHOW that a صدر alone is enough, not merely
 * to be one: every string in `OPENINGS` was already a صدر with no عجز after it,
 * and a reader has no way to know that the missing half is missing on purpose.
 * So the example is labelled — «صدرٌ وحده يكفي — مثال: …» — and the field's own
 * helper line under it says the same thing in a sentence (`SADR_HELP`).
 *
 * `narrow` is the docked field on a phone. A placeholder is the one string CSS
 * cannot shorten — it clips mid-word, and a textarea cannot even ellipsise it —
 * so the label and the example do not both fit on one line of a composer that
 * is one line tall, and `SADR_HELP` under the field is gone there too (there is
 * no room for prose between the thumb and the verse). What survives is the
 * SHORTER half of the same promise, said as an instruction: «اكتب صدرًا — يكفي».
 * Same rule as `OMNIBOX_PLACEHOLDER_NARROW` and `PALETTE_PLACEHOLDER_NARROW`.
 */
export const ANSWER_PLACEHOLDER_NARROW = "اكتب بيتًا — ويكفي صدره"

export function placeholderFor(seed: string, turn: number, tier: string, narrow = false): string | undefined {
  if (tier === "sword") return undefined
  if (narrow) return ANSWER_PLACEHOLDER_NARROW
  const rng = rngFrom(`${seed}:placeholder:${turn}`)
  const i = Math.floor(rng() * OPENINGS.length) % OPENINGS.length
  return `صدرٌ وحده يكفي — مثال: ${OPENINGS[i]!}`
}
