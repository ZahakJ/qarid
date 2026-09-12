/**
 * Display-state helpers for a بيت. Everything here delegates to
 * `shared/arabic.ts` — the ONE normalizer (CLAUDE.md invariant). There is no
 * second "strip tashkeel" in the client and there must never be one.
 *
 * `stripTashkeel` also removes tatweel and the zero-width/bidi run (U+200B–
 * U+200F), which is why anything that PREFIXES an RLM (copy.ts) must strip
 * first and prefix afterwards.
 */
import { stripTashkeel } from "../../shared/arabic.ts"

/** The text as it should be painted, given the reader's تشكيل preference. */
export function displayText(text: string, tashkeel: boolean): string {
  return tashkeel ? text : stripTashkeel(text)
}

/** Same, for the nullable عجز of a partial بيت. */
export function displayTextOrNull(text: string | null | undefined, tashkeel: boolean): string | null {
  if (text === null || text === undefined) return null
  return displayText(text, tashkeel)
}

/**
 * Does this string actually carry marks? The API's `hasTashkeel` is a
 * poem-level 3% threshold, so an individual بيت inside a "vocalized" قصيدة may
 * still be bare — the taller leading (`--lh-bayt-tashkeel`) should follow the
 * line, not the poem.
 */
export function hasMarks(text: string | null | undefined): boolean {
  if (!text) return false
  return stripTashkeel(text) !== text
}

/**
 * Is this single character a combining mark? Defined as "the normalizer eats
 * it", so it can never drift from `stripTashkeel`. Used to keep a حركة inside
 * the روي underline instead of orphaning it after the span.
 */
export function isMark(ch: string): boolean {
  return ch !== "" && stripTashkeel(ch) === ""
}
