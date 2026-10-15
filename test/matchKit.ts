/**
 * Helpers the account-less match tests share: legal answers drawn from the
 * fixture corpus, so every test plays real moves through the real verifier.
 */
import type { Db } from "../server/db.ts"
import type { MatchState } from "../shared/match.ts"

/**
 * A مطلع whose first letter is its own روي — reciting it back is then a بيت on
 * the right letter that the match has already heard, which is what the repeat
 * rule needs to be exercised.
 */
export function selfRhymingOpening(db: Db): { id: number; text: string } {
  const row = db
    .q(
      `SELECT gb.bait_id AS id, b.sadr AS sadr, b.ajuz AS ajuz FROM game_baits gb JOIN baits b ON b.id = gb.bait_id
       WHERE gb.first_letter = gb.rawiyy AND b.ajuz IS NOT NULL
       ORDER BY (SELECT count(*) FROM game_baits g2 WHERE g2.first_letter = gb.rawiyy) DESC, gb.bait_id LIMIT 1`,
    )
    .get() as { id: number; sadr: string; ajuz: string }
  return { id: Number(row.id), text: `${row.sadr} ${row.ajuz}` }
}

/**
 * Unplayed أبيات that open on `letter`, best continuations first, so a greedy
 * walk through a 200-بيت fixture keeps finding a next letter.
 */
export function candidatesOn(db: Db, letter: string, state: MatchState): string[] {
  const usedBaits = new Set(state.turns.map((t) => t.bait?.id).filter((id): id is number => typeof id === "number"))
  const usedPoems = new Set(
    state.turns.map((t) => t.bait?.poem.poemId).filter((id): id is number => typeof id === "number"),
  )
  const rows = db
    .q(
      `SELECT gb.bait_id AS id, gb.poem_id AS poem_id, b.sadr AS sadr, b.ajuz AS ajuz
       FROM game_baits gb JOIN baits b ON b.id = gb.bait_id
       WHERE gb.first_letter = ? AND b.ajuz IS NOT NULL
       ORDER BY (SELECT count(*) FROM game_baits g2 WHERE g2.first_letter = gb.rawiyy) DESC, gb.fame DESC
       LIMIT 60`,
    )
    .all(letter) as Array<Record<string, unknown>>
  return rows
    .filter((r) => !usedBaits.has(Number(r.id)) && !usedPoems.has(Number(r.poem_id)))
    .map((r) => `${String(r.sadr)} ${String(r.ajuz)}`)
}

/** Nonsense on the required letter: it reaches the corpus and is not there. */
export function unknownOn(letter: string): string {
  return `${letter}زقثغ ضظشصخ قفغعذ ثصضظ`
}

/** Any letter but the required one, at the head of a real-looking line. */
export function wrongLetterFor(letter: string): string {
  const other = letter === "م" ? "ن" : "م"
  return `${other}ا هاج شوقك من رسم ومن طلل`
}
