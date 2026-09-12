/**
 * Locating the روي inside the عجز so it can carry the lapis underline
 * (design-ux.md §2: lapis touches exactly three things, and this is one).
 *
 * The server already decided WHICH letter the روي is — `BaitDto.rawiyy`, from
 * `rawiyyOf()` in shared/arabic.ts. This module only has to find WHERE that
 * letter sits in the displayed string, and it does so with the shared
 * `foldLetter`, never with a private copy of the fold table. Searching from the
 * end is exactly right: the peel only ever drops a trailing ه/ة or one
 * ا/ى/و/ي, so the last character that folds to the روي IS the روي.
 */
import { foldLetter } from "../../shared/arabic.ts"
import { isMark } from "./tashkeel.ts"

export type RawiyySplit = {
  /** everything before the روي */
  head: string
  /** the روي itself, with any حركة that belongs to it */
  letter: string
  /** the وصل / إطلاق that was peeled off, if any */
  tail: string
}

/**
 * Split `text` around its روي, or `null` when the letter is not there (a عجز
 * that is missing, or a mismatch between a cached بيت and a fresh letter).
 * Callers render the three parts and put `.rawiyy-mark` on the middle one.
 */
export function splitRawiyy(text: string | null | undefined, rawiyy: string | null | undefined): RawiyySplit | null {
  if (!text || !rawiyy) return null
  const chars = [...text]
  for (let i = chars.length - 1; i >= 0; i--) {
    if (foldLetter(chars[i]!) !== rawiyy) continue
    // keep the letter's own حركة (and a shadda before it) under the underline
    let end = i + 1
    while (end < chars.length && isMark(chars[end]!)) end++
    return {
      head: chars.slice(0, i).join(""),
      letter: chars.slice(i, end).join(""),
      tail: chars.slice(end).join(""),
    }
  }
  return null
}
