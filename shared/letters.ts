/**
 * The 28 Arabic letters in هجائي order — the alphabet of the whole product.
 *
 * Every chain letter, every روي facet, every arsenal cell and every poets-index
 * section is one of these and nothing else: `foldLetter()` in arabic.ts is the
 * only door into this set. The order below is BOTH the display order and the
 * collation order, and `letters.test.ts` pins the property that makes that safe
 * — after folding, هجائي order is exactly Unicode code-point order, so
 * `ORDER BY letter` in SQLite and `HIJAI_INDEX` in the client never disagree.
 */

export const HIJAI_LETTERS = [
  "ا", "ب", "ت", "ث", "ج", "ح", "خ",
  "د", "ذ", "ر", "ز", "س", "ش", "ص",
  "ض", "ط", "ظ", "ع", "غ", "ف", "ق",
  "ك", "ل", "م", "ن", "ه", "و", "ي",
] as const

export type HijaiLetter = (typeof HIJAI_LETTERS)[number]

/** Membership test that also narrows the type. */
export function isHijaiLetter(ch: string): ch is HijaiLetter {
  return HIJAI_SET.has(ch)
}

const HIJAI_SET: ReadonlySet<string> = new Set<string>(HIJAI_LETTERS)

/** letter → 0..27, its position in the alphabet. `-1` for anything else. */
export function hijaiIndex(ch: string): number {
  const i = HIJAI_ORDER.get(ch)
  return i === undefined ? -1 : i
}

const HIJAI_ORDER: ReadonlyMap<string, number> = new Map(
  HIJAI_LETTERS.map((l, i) => [l as string, i] as const),
)

/** Comparator for any two folded letters — هجائي, not Unicode-by-accident. */
export function compareLetters(a: string, b: string): number {
  return hijaiIndex(a) - hijaiIndex(b)
}

/** The spoken name of each letter, for `aria-label` and the letter grids. */
export const LETTER_NAMES: Readonly<Record<HijaiLetter, string>> = {
  "ا": "ألف", "ب": "باء", "ت": "تاء", "ث": "ثاء", "ج": "جيم", "ح": "حاء", "خ": "خاء",
  "د": "دال", "ذ": "ذال", "ر": "راء", "ز": "زاي", "س": "سين", "ش": "شين", "ص": "صاد",
  "ض": "ضاد", "ط": "طاء", "ظ": "ظاء", "ع": "عين", "غ": "غين", "ف": "فاء", "ق": "قاف",
  "ك": "كاف", "ل": "لام", "م": "ميم", "ن": "نون", "ه": "هاء", "و": "واو", "ي": "ياء",
}

/**
 * The 7×4 grid the روي picker, the first-letter picker and the arsenal heatmap
 * all render. Four rows of seven, هجائي order, laid out RTL by the container —
 * the array order is reading order, the CSS does the mirroring.
 */
export const LETTER_ROWS: readonly (readonly HijaiLetter[])[] = [
  HIJAI_LETTERS.slice(0, 7),
  HIJAI_LETTERS.slice(7, 14),
  HIJAI_LETTERS.slice(14, 21),
  HIJAI_LETTERS.slice(21, 28),
]

/** The same four rows, labelled — used as group headings in the letter rail. */
export const LETTER_GROUPS: readonly { readonly label: string; readonly letters: readonly HijaiLetter[] }[] =
  LETTER_ROWS.map((row) => ({
    label: `${row[0]!} — ${row[row.length - 1]!}`,
    letters: row,
  }))

/**
 * The letters a قافية rarely ends on. Ending a بيت on one of these is a weapon:
 * design-server.md §8 lets `brutal` prefer them and `easy` avoid them, and
 * amendment 5 widens the set for the `tailBias` lever.
 */
export const RARE_RAWIYY: readonly HijaiLetter[] = ["ظ", "ذ", "غ", "ز", "ث", "ض", "ص"]

/** amendment 5's wider set — `tailBias:'easy'` avoids replies ending in these. */
export const RARE_RAWIYY_WIDE: readonly HijaiLetter[] = [...RARE_RAWIYY, "ط", "خ"]

export const RARE_RAWIYY_SET: ReadonlySet<string> = new Set<string>(RARE_RAWIYY)
export const RARE_RAWIYY_WIDE_SET: ReadonlySet<string> = new Set<string>(RARE_RAWIYY_WIDE)

export function isRareRawiyy(letter: string, wide = false): boolean {
  return wide ? RARE_RAWIYY_WIDE_SET.has(letter) : RARE_RAWIYY_SET.has(letter)
}
