/**
 * Copying a بيت out of قريض and into anywhere else (design-ux.md §3, Poem →
 * Copy).
 *
 * The two primitives — the U+200F prefix and the `صدر … عجز` join — belong to
 * `shared/format.ts`, because the share card and the daily-chain text block
 * need the identical string. This module is the CLIENT's copy vocabulary built
 * on top of them: the three menu formats and the clipboard call.
 *
 * Three rules, all of them load-bearing:
 *  1. Every line is prefixed with U+200F RIGHT-TO-LEFT MARK. Paste a bare
 *     Arabic hemistich into a Latin-first editor and the leading «و» jumps to
 *     the wrong end of the line; the RLM pins the paragraph direction.
 *  2. The two hemistichs are joined by « … » on ONE line. A newline between
 *     them turns a بيت into two orphan شطر in every chat client there is.
 *  3. The caller passes the text AS DISPLAYED. If the reader turned تشكيل off,
 *     what they see is what they copy — so strip first (tashkeel.ts) and
 *     prefix afterwards, because `stripTashkeel` also eats U+200F.
 */

import { RLM, copyableBayt } from "../../shared/format.ts"

/** U+200F RIGHT-TO-LEFT MARK — re-exported so a caller needs one import. */
export { RLM }

/**
 * The separator `copyableBayt` puts between صدر and عجز. Declared here only so
 * the tests can pin that the two modules still agree on it.
 */
export const HEMISTICH_SEP = " … "

function rtl(line: string): string {
  return `${RLM}${line}`
}

/**
 * `صدر … عجز` on one line, WITHOUT the RLM — the raw joined form, for anything
 * that embeds a بيت inside a larger already-RTL block (share cards, toasts).
 * A partial بيت (odd hemistich count → `ajuz: null`) is just its صدر.
 */
export function baytLine(sadr: string, ajuz?: string | null): string {
  return formatBayt(sadr, ajuz).slice(RLM.length)
}

/** «البيت» — one RLM-prefixed line, straight from the shared formatter. */
export function formatBayt(sadr: string, ajuz?: string | null): string {
  const a = ajuz?.trim()
  return copyableBayt(sadr.trim(), a ? a : null)
}

/**
 * «البيت والشاعر» — the بيت, then an em-dash attribution on its own line.
 * `title` is appended only when the قصيدة actually has one (most do not).
 */
export function formatBaytWithPoet(
  sadr: string,
  ajuz: string | null | undefined,
  poet: string,
  title?: string | null,
): string {
  const credit = title ? `— ${poet}، ${title}` : `— ${poet}`
  return [rtl(baytLine(sadr, ajuz)), rtl(credit)].join("\n")
}

export type CopyPoem = {
  title: string
  poet: string
  baits: readonly { sadr: string; ajuz?: string | null }[]
}

/**
 * «القصيدة كاملة» — عنوان, شاعر, blank line, then one line per بيت. Every line
 * carries its own RLM so a paste that gets re-wrapped still reads right.
 */
export function formatPoem(poem: CopyPoem): string {
  const head = [rtl(poem.title.trim()), rtl(poem.poet.trim())]
  const body = poem.baits.map((b) => rtl(baytLine(b.sadr, b.ajuz)))
  return [...head, "", ...body].join("\n")
}

/** The three menu entries of the alt-click copy menu, in order. */
export const COPY_MODES = [
  { key: "bayt", label: "البيت" },
  { key: "bayt-poet", label: "البيت والشاعر" },
  { key: "poem", label: "القصيدة كاملة" },
] as const

export type CopyMode = (typeof COPY_MODES)[number]["key"]

/**
 * Put `text` on the clipboard. Resolves `false` instead of throwing when the
 * browser refuses (insecure origin, no permission) so a caller can toast a
 * failure rather than crash a render.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
