/**
 * The بيت اليوم card as a PNG, drawn on the server — `GET /og/daily/<date>.png`.
 *
 * A link preview is fetched by a crawler that runs no script, so the canvas
 * card in client/share/renderCard.ts cannot serve it: the image has to exist
 * as a file at a URL. This module draws the same composition — ink ground,
 * gold hairline frame, the بيت in Amiri, the شاعر and «قريض» in Aref Ruqaa —
 * as an SVG and rasterises it with resvg (WebAssembly, no native binary).
 *
 * resvg shapes with rustybuzz and runs the Unicode bidi algorithm, so Arabic
 * joins and orders correctly from the TTFs vendored under server/assets/fonts
 * (resvg reads TTF/OTF only, not the woff2 the client ships).
 *
 * Three rules, the client card's own:
 *  • Fit by shrinking the FONT SIZE, measured from the shaped text — never
 *    squeeze, letter-space or scale glyphs. A hemistich too long for any
 *    legible size is broken at a word boundary onto two lines instead.
 *  • Both hemistichs at ONE size.
 *  • «قريض» alone marks the card; no URL is printed on it.
 */

import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { initWasm, Resvg } from "@resvg/resvg-wasm"

export const CARD_W = 1200
export const CARD_H = 630

const INK = "#07080c"
const TEXT = "#ece6da"
const MUTED = "#9d9689"
const GOLD = "#d6ad60"
const VERSE = "Amiri"
const DISPLAY = "Aref Ruqaa"

export type DailyCardInput = {
  /** `YYYY-MM-DD`, printed as is (Western digits) */
  date: string
  sadr: string
  ajuz?: string | null
  poet?: string | null
}

const FONT_DIR = path.join(import.meta.dirname, "..", "assets", "fonts")
let fonts: Uint8Array[] | null = null
function fontBuffers(): Uint8Array[] {
  fonts ??= [
    fs.readFileSync(path.join(FONT_DIR, "amiri", "Amiri-Regular.ttf")),
    fs.readFileSync(path.join(FONT_DIR, "aref-ruqaa", "ArefRuqaa-Regular.ttf")),
  ]
  return fonts
}

let ready: Promise<void> | null = null
/** Load the resvg module once per process; every render awaits this. */
export function initCardRenderer(): Promise<void> {
  ready ??= (async () => {
    const require = createRequire(import.meta.url)
    const wasm = fs.readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))
    await initWasm(wasm)
  })()
  return ready
}

/** Text that is safe inside an SVG text node or a double-quoted attribute. */
function xml(s: string): string {
  return s
    // characters XML 1.0 forbids outright; scraped text has carried them
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Pin an Arabic line's ends with U+200F. resvg resolves the bidi paragraph
 * level as LTR whatever `direction` says, so a neutral at either end — the
 * closing «﴾» of a quotation, a leading «» — would otherwise be thrown to
 * the wrong side of the line.
 */
function rtl(s: string): string {
  return `\u200F${s}\u200F`
}

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim()
}

type Metrics = { width: number; ascent: number; descent: number }

const REF = 100
const measured = new Map<string, Metrics>()

/**
 * Ink extents of one line at size 100: width, and how far the ink reaches
 * above and below the baseline (tashkeel included). Everything scales
 * linearly with the font size, so one measurement serves every size.
 */
function measure(text: string, family: string, ltr = false): Metrics {
  const key = `${family}\u0000${ltr ? 1 : 0}\u0000${text}`
  const hit = measured.get(key)
  if (hit) return hit
  const base = REF * 2
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${REF * 120}" height="${REF * 4}">` +
    `<text x="${REF * 60}" y="${base}" font-family="${family}" font-size="${REF}" text-anchor="middle"` +
    ` direction="${ltr ? "ltr" : "rtl"}">${xml(ltr ? text : rtl(text))}</text></svg>`
  const r = new Resvg(svg, { font: { fontBuffers: fontBuffers(), loadSystemFonts: false, defaultFontFamily: VERSE } })
  let m: Metrics = { width: 0, ascent: 0, descent: 0 }
  try {
    const b = r.innerBBox()
    if (b) {
      m = { width: b.width, ascent: base - b.y, descent: b.y + b.height - base }
      b.free()
    }
  } finally {
    r.free()
  }
  if (measured.size > 2000) measured.clear()
  measured.set(key, m)
  return m
}

const scaled = (m: Metrics, size: number): Metrics => ({
  width: (m.width * size) / REF,
  ascent: (m.ascent * size) / REF,
  descent: (m.descent * size) / REF,
})

/** The largest size ≤ `start` at which every line fits `maxW`. */
function fitWidth(lines: readonly string[], family: string, maxW: number, start: number): number {
  let size = start
  for (const l of lines) {
    const w = measure(l, family).width
    if (w > 0) size = Math.min(size, (maxW * REF) / w)
  }
  return Math.floor(size)
}

/** Break a hemistich at the word boundary that best halves its width. */
function halve(line: string): [string, string] | null {
  const words = line.split(" ")
  if (words.length < 2) return null
  let best: [string, string] | null = null
  let bestDiff = Infinity
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ")
    const b = words.slice(i).join(" ")
    const diff = Math.abs(measure(a, VERSE).width - measure(b, VERSE).width)
    if (diff < bestDiff) {
      bestDiff = diff
      best = [a, b]
    }
  }
  return best
}

// ── geometry ─────────────────────────────────────────────────────────────
const INSET = Math.round(CARD_W * 0.028) // the gold frame
const SIDE = Math.round(CARD_W * 0.062) // the header/footer marks' margin
const MAX_W = Math.round(CARD_W * 0.82)
const VERSE_START = 62
/** below this a hemistich is broken onto two lines rather than shrunk further */
const VERSE_COMFORT = 36
const VERSE_FLOOR = 16
const HEAD_SIZE = 30
const MARK_SIZE = 54
const POET_START = 52
/** narrower than the verse, so a long name never runs under the «قريض» mark */
const POET_MAX_W = Math.round(CARD_W * 0.68)
/** the band the verse block may occupy, between the header and the mark */
const BLOCK_TOP = 128
const BLOCK_BOTTOM = 505

export type CardLayout = {
  verseSize: number
  verseLines: { text: string; y: number }[]
  poetSize: number
  poetY: number
  ruleY: number
}

/** Pure layout: sizes and baselines, everything measured from shaped text. */
export function layoutDailyCard(input: DailyCardInput): CardLayout {
  const sadr = clean(input.sadr)
  const ajuz = clean(input.ajuz)
  const poet = clean(input.poet)

  let lines = ajuz ? [sadr, ajuz] : [sadr]
  let size = Math.min(VERSE_START, fitWidth(lines, VERSE, MAX_W, VERSE_START))
  if (size < VERSE_COMFORT) {
    const broken = lines.flatMap((l) => (measure(l, VERSE).width * VERSE_COMFORT) / REF > MAX_W ? (halve(l) ?? [l]) : [l])
    if (broken.length > lines.length) {
      lines = broken
      size = Math.min(VERSE_START, fitWidth(lines, VERSE, MAX_W, VERSE_START))
    }
  }

  const poetSize = poet ? Math.min(POET_START, fitWidth([poet], DISPLAY, POET_MAX_W, POET_START)) : 0

  // Stack from measured ink: each baseline sits far enough below the last that
  // the previous line's lowest kasra clears this line's highest shadda.
  const stack = (s: number) => {
    const ms = lines.map((l) => scaled(measure(l, VERSE), s))
    const ys: number[] = [0]
    const lead = s * 1.55
    for (let i = 1; i < ms.length; i++) {
      const gap = Math.max(lead, ms[i - 1]!.descent + ms[i]!.ascent + s * 0.25)
      ys.push(ys[i - 1]! + gap)
    }
    const top = -ms[0]!.ascent
    const lastDescent = ms[ms.length - 1]!.descent
    const ruleY = ys[ys.length - 1]! + Math.max(lastDescent, s * 0.35) + s * 0.35
    const p = poet ? scaled(measure(poet, DISPLAY), poetSize) : null
    const poetY = p ? ruleY + p.ascent + poetSize * 0.4 : ruleY
    const bottom = p ? poetY + p.descent : ruleY
    return { ys, top, ruleY, poetY, bottom }
  }

  let st = stack(size)
  const room = BLOCK_BOTTOM - BLOCK_TOP
  for (let guard = 0; guard < 40 && st.bottom - st.top > room && size > VERSE_FLOOR; guard++) {
    size -= 2
    st = stack(size)
  }
  size = Math.max(size, VERSE_FLOOR)

  // centre the measured block in its band
  const shift = BLOCK_TOP + (room - (st.bottom - st.top)) / 2 - st.top
  return {
    verseSize: size,
    verseLines: lines.map((text, i) => ({ text, y: Math.round(st.ys[i]! + shift) })),
    poetSize,
    poetY: Math.round(st.poetY + shift),
    ruleY: Math.round(st.ruleY + shift),
  }
}

/** The card as SVG source — exported for tests and for inspection. */
export function dailyCardSvg(input: DailyCardInput): string {
  const L = layoutDailyCard(input)
  const poet = clean(input.poet)
  const cx = CARD_W / 2

  // header: «بيت اليوم» at the right, the date at the left, both centred on
  // their own measured widths (no reliance on text-anchor under rtl)
  const label = "بيت اليوم"
  const labelW = scaled(measure(label, VERSE), HEAD_SIZE).width
  const dateW = scaled(measure(input.date, VERSE, true), HEAD_SIZE - 2).width
  const headY = INSET + 58
  const markW = scaled(measure("قريض", DISPLAY), MARK_SIZE).width
  const markM = scaled(measure("قريض", DISPLAY), MARK_SIZE)
  // the mark's clearance is taken from its DESCENDER to the frame
  const markY = Math.round(CARD_H - INSET - markM.descent - CARD_H * 0.03)

  const t = (x: number, y: number, size: number, family: string, fill: string, text: string, dir = "rtl") =>
    `<text x="${x.toFixed(1)}" y="${y}" font-family="${family}" font-size="${size}" fill="${fill}" text-anchor="middle" direction="${dir}">${xml(dir === "rtl" ? rtl(text) : text)}</text>`

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">`,
    `<defs>`,
    `<radialGradient id="g1" cx="${CARD_W * 0.22}" cy="${CARD_H * 0.14}" r="${CARD_W * 0.7}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="rgb(214,173,96)" stop-opacity="0.1"/><stop offset="1" stop-color="rgb(214,173,96)" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="g2" cx="${CARD_W * 0.78}" cy="${CARD_H * 0.86}" r="${CARD_W * 0.7}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="rgb(92,124,200)" stop-opacity="0.08"/><stop offset="1" stop-color="rgb(92,124,200)" stop-opacity="0"/></radialGradient>`,
    `<linearGradient id="rule" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${GOLD}" stop-opacity="0"/><stop offset="0.2" stop-color="${GOLD}" stop-opacity="0.34"/><stop offset="0.8" stop-color="${GOLD}" stop-opacity="0.34"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></linearGradient>`,
    `</defs>`,
    `<rect width="${CARD_W}" height="${CARD_H}" fill="${INK}"/>`,
    `<rect width="${CARD_W}" height="${CARD_H}" fill="url(#g1)"/>`,
    `<rect width="${CARD_W}" height="${CARD_H}" fill="url(#g2)"/>`,
    `<rect x="${INSET + 0.5}" y="${INSET + 0.5}" width="${CARD_W - INSET * 2 - 1}" height="${CARD_H - INSET * 2 - 1}" fill="none" stroke="${GOLD}" stroke-opacity="0.34" stroke-width="1"/>`,
    t(CARD_W - SIDE - labelW / 2, headY, HEAD_SIZE, VERSE, GOLD, label),
    t(SIDE + dateW / 2, headY, HEAD_SIZE - 2, VERSE, MUTED, input.date, "ltr"),
    ...L.verseLines.map((l) => t(cx, l.y, L.verseSize, VERSE, TEXT, l.text)),
    `<rect x="${CARD_W * 0.2}" y="${L.ruleY}" width="${CARD_W * 0.6}" height="1" fill="url(#rule)"/>`,
    poet ? t(cx, L.poetY, L.poetSize, DISPLAY, GOLD, poet) : "",
    t(CARD_W - SIDE - markW / 2, markY, MARK_SIZE, DISPLAY, GOLD, "قريض"),
    `</svg>`,
  ]
  return parts.join("")
}

/** Rasterise the card. `initCardRenderer()` must have resolved. */
export function renderDailyCard(input: DailyCardInput): Uint8Array {
  const r = new Resvg(dailyCardSvg(input), {
    font: { fontBuffers: fontBuffers(), loadSystemFonts: false, defaultFontFamily: VERSE },
    fitTo: { mode: "original" },
  })
  try {
    const img = r.render()
    try {
      return img.asPng()
    } finally {
      img.free()
    }
  } finally {
    r.free()
  }
}
