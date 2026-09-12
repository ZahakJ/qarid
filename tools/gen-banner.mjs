#!/usr/bin/env node
/**
 * Generate the قريض repository banner — the GitHub social preview and the
 * README hero — from the app's own design language (docs/design-ux.md §2):
 * blue-black ink, illumination gold, lapis for the روي and nothing else, the
 * gold nib, the manuscript corners, the dissolving hairline.
 *
 * Writes TWO files into docs/media/, and both are committed:
 *
 *   banner.svg   the SOURCE. Self-contained: the four faces it needs are
 *                embedded as base64 woff2, so it shapes Arabic correctly in
 *                any renderer that reads @font-face — no system font, no
 *                fallback, no outlines-instead-of-text.
 *   banner.png   1280×640, what GitHub serves.
 *
 * The بيت is REAL, out of data/qarid.db: bait 444324, قصيدة 35033, المتنبي.
 * It is baked in as a literal below so this script runs without the artefact.
 *
 * The روي hairline under the last letter of the عجز is the one lapis in the
 * picture, and it is measured, not guessed: Chromium lays the عجز out, reports
 * where its final letter sits, and the rect is written into the SVG with that
 * geometry. Re-run after any change to the verse or the type size.
 *
 *   node tools/gen-banner.mjs
 */
import { formatBaits, formatPoems, formatPoets } from "../shared/format.ts"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "docs", "media")
mkdirSync(OUT, { recursive: true })

// ── the palette, verbatim from client/styles/tokens.css ─────────────────────
const INK = "#07080c"
const GOLD = "#d6ad60"
const LAPIS = "#5c7cc8"
const TEXT_1 = "#ece6da"
const TEXT_2 = "#9d9689"
const TEXT_3 = "#8a8478"

const W = 1280
const H = 640

// ── the verse ───────────────────────────────────────────────────────────────
const SADR = "أَنا اِبنُ الفَيافي أَنا اِبنُ القَوافي"
const AJUZ = "أَنا اِبنُ السُروجِ أَنا اِبنُ الرِعانِ"
/** The روي. «ا» never joins forwards, so the final «نِ» is already isolated and
 *  splitting the عجز here cannot break a single join. */
const RAWIYY = "نِ"
const POET = "المتنبي"

// ── the faces, inlined ──────────────────────────────────────────────────────
const FACES = [
  ["Aref Ruqaa", 400, "@fontsource/aref-ruqaa/files/aref-ruqaa-arabic-400-normal.woff2"],
  ["Amiri", 400, "@fontsource/amiri/files/amiri-arabic-400-normal.woff2"],
  ["Plex Sans Arabic", 500, "@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-500-normal.woff2"],
  ["Plex Mono", 400, "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2"],
]

const fontFaces = FACES.map(([family, weight, rel]) => {
  const b64 = readFileSync(join(ROOT, "node_modules", rel)).toString("base64")
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2')}`
}).join("\n")

/**
 * The whole picture. `rawiyyRect` is null on the measuring pass and the
 * measured `{x,y,w}` on the real one — everything else is identical, so what
 * gets measured is exactly what gets drawn.
 */
function svg(rawiyyRect) {
  const underline = rawiyyRect
    ? `  <rect x="${rawiyyRect.x.toFixed(2)}" y="${rawiyyRect.y.toFixed(2)}" width="${rawiyyRect.w.toFixed(2)}" height="2" rx="1" fill="${LAPIS}" opacity="0.95"/>`
    : ""

  // A manuscript corner (client/components/Ornaments.tsx `Corner`), drawn for
  // the top-left and mirrored into the other three by the transforms below.
  const corner = `
      <path d="M2 22V8.5C2 4.9 4.9 2 8.5 2H22" stroke="${GOLD}" stroke-width="1.1" stroke-linecap="round" opacity=".55" fill="none"/>
      <path d="M6 22V10.5C6 8 8 6 10.5 6H22" stroke="${GOLD}" stroke-width="0.7" stroke-linecap="round" opacity=".32" fill="none"/>
      <circle cx="8.6" cy="8.6" r="1.5" fill="${GOLD}" opacity=".7"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="قَريض — an Arabic poetry ديوان and a duel on the rhyme">
  <title>قَريض</title>
  <defs>
    <style>
${fontFaces}
    </style>
    <radialGradient id="bloom" cx="50%" cy="34%" r="62%">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity="0.13"/>
      <stop offset="45%" stop-color="${GOLD}" stop-opacity="0.045"/>
      <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ink" cx="50%" cy="96%" r="78%">
      <stop offset="0%" stop-color="${LAPIS}" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="${LAPIS}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity="0"/>
      <stop offset="18%" stop-color="${GOLD}" stop-opacity="0.34"/>
      <stop offset="82%" stop-color="${GOLD}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="rule-faint" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${GOLD}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
    </linearGradient>
    <g id="corner">${corner}
    </g>
  </defs>

  <rect width="${W}" height="${H}" fill="${INK}"/>
  <rect width="${W}" height="${H}" fill="url(#ink)"/>
  <rect width="${W}" height="${H}" fill="url(#bloom)"/>

  <!-- manuscript frame: four corners, no box -->
  <g>
    <use href="#corner" transform="translate(52,52) scale(1.45)"/>
    <use href="#corner" transform="translate(${W - 52},52) scale(-1.45,1.45)"/>
    <use href="#corner" transform="translate(52,${H - 52}) scale(1.45,-1.45)"/>
    <use href="#corner" transform="translate(${W - 52},${H - 52}) scale(-1.45,-1.45)"/>
  </g>

  <!-- the seal: the app's own قلم, ringed the way the launcher icon rings it -->
  <g transform="translate(${W / 2},98)">
    <circle r="31" fill="${GOLD}" fill-opacity="0.05"/>
    <circle r="31" fill="none" stroke="${GOLD}" stroke-opacity="0.3" stroke-width="1"/>
    <g transform="scale(2.65) translate(-13.5,-14.4)">
      <path d="M6 21c5.4-1.8 9.4-6.4 11.4-13.2L21 11c-2 7.4-6.8 10.9-15 12Z" fill="${GOLD}"/>
    </g>
  </g>

  <!-- the wordmark -->
  <text x="${W / 2}" y="312" text-anchor="middle" direction="rtl"
        font-family="Aref Ruqaa" font-size="124" fill="${GOLD}">قَريض</text>

  <!-- the dissolving hairline -->
  <rect x="${W / 2 - 215}" y="348" width="430" height="1" fill="url(#rule)"/>

  <!-- what it is, in a clean face -->
  <text x="${W / 2}" y="386" text-anchor="middle"
        font-family="Plex Sans Arabic" font-weight="500" font-size="22"
        direction="rtl" unicode-bidi="embed"
        fill="${GOLD}" fill-opacity="0.85"
      >ديوان الشعر العربي ومساجلته</text>

  <!-- what is in it -->
  <text x="${W / 2}" y="416" text-anchor="middle"
        font-family="Plex Sans Arabic" font-size="15.5" fill="${TEXT_3}"
        direction="rtl" unicode-bidi="embed"
      >${formatPoems(238733)} · ${formatBaits(3369701)} · ${formatPoets(6941)}</text>

  <!-- one real بيت, set the way the ديوان sets it: صدر · شمسة · عجز -->
  <text id="sadr" x="${W / 2 + 208}" y="494" text-anchor="middle" direction="rtl"
        font-family="Amiri" font-size="30" fill="${TEXT_1}">${SADR}</text>
  <g transform="translate(${W / 2 - 9},476)" fill="${GOLD}" opacity="0.6">
    <path d="M8 1.1 9.3 5.3 13.6 4.1 11.1 7.8 15 10 10.5 10.6 11.3 15 8 11.9 4.7 15 5.5 10.6 1 10 4.9 7.8 2.4 4.1 6.7 5.3Z"/>
    <circle cx="8" cy="8" r="1.4" fill="${INK}"/>
  </g>
  <text id="ajuz" x="${W / 2 - 208}" y="494" text-anchor="middle" direction="rtl"
        font-family="Amiri" font-size="30" fill="${TEXT_1}">${AJUZ}</text>
${underline}

  <text x="${W / 2}" y="543" text-anchor="middle" direction="rtl"
        font-family="Amiri" font-size="23" fill="${TEXT_2}">${POET}</text>

  <rect x="${W / 2 - 130}" y="566" width="260" height="1" fill="url(#rule-faint)"/>
  <text x="${W / 2}" y="596" text-anchor="middle"
        font-family="Plex Mono" font-size="13.5" letter-spacing="2.4"
        fill="${GOLD}" fill-opacity="0.5">zahakj.github.io/qarid</text>
</svg>
`
}

// ── measure the روي, then draw ──────────────────────────────────────────────
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  const shell = (body) =>
    `<!doctype html><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{background:${INK};width:${W}px;height:${H}px;overflow:hidden}svg{display:block}</style>${body}`

  await page.setContent(shell(svg(null)), { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)

  /**
   * Where the last letter of the عجز sits, in SVG user units. The عجز is one
   * text node so its shaping is untouched; `getStartPositionOfChar` on the
   * first index of the روي and the node's own bbox give the run's extent.
   */
  const rect = await page.evaluate((rawiyyLen) => {
    const t = document.getElementById("ajuz")
    const n = t.textContent.length
    const box = t.getBBox()
    const start = t.getStartPositionOfChar(n - rawiyyLen).x
    // RTL: the run ENDS at `start` and runs leftwards to the node's left edge.
    const left = box.x
    return { x: left - 1, y: box.y + box.height + 5, w: Math.max(10, start - left + 2) }
  }, RAWIYY.length)

  const source = svg(rect)
  writeFileSync(join(OUT, "banner.svg"), source)

  await page.setContent(shell(source), { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(OUT, "banner.png"), clip: { x: 0, y: 0, width: W, height: H } })
  console.log(`wrote ${join(OUT, "banner.svg")} and banner.png (${W}×${H})`)
} finally {
  await browser.close()
}
