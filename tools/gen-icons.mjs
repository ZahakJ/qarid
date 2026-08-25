#!/usr/bin/env node
/**
 * Generate the قريض PWA app icons (docs/roadmap-mobile.md §M0) from the app's
 * own gold-nib motif (client/components/Ornaments.tsx `Nib`, index.html favicon)
 * — inked background, gold nib, and a maskable safe zone.
 *
 * Rasterized by rendering an SVG at native pixel size in headless Chromium
 * (playwright is already a devDependency; no canvas/sharp needed). The four PNGs
 * land in client/public/icons/ and are committed — they are build INPUTS that
 * vite copies verbatim into dist/icons/, and they change only when the motif
 * does, so they are not regenerated on every build.
 *
 *   node tools/gen-icons.mjs
 */
import { mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "client", "public", "icons")
mkdirSync(OUT, { recursive: true })

const INK = "#07080c"
const GOLD = "#d6ad60"

// The نِيب, framed tightly so the nested <svg viewBox> centres it on the canvas.
const NIB = `
  <path d="M6 21c5.4-1.8 9.4-6.4 11.4-13.2L21 11c-2 7.4-6.8 10.9-15 12Z" fill="${GOLD}"/>
  <path d="M6 21 12.2 14.8" stroke="${INK}" stroke-width="1.1" stroke-linecap="round" opacity=".55"/>
`

/**
 * One icon as an SVG string.
 * @param size    canvas side in px
 * @param nibFrac fraction of the canvas the nib box occupies (smaller = more
 *                margin; maskable keeps the nib inside the ~80% safe zone)
 * @param ring    draw the faint gold hairline ring (the "any" variant only —
 *                a maskable icon is masked to a circle/squircle by the OS, so a
 *                square-ish ring would be clipped)
 */
function icon(size, nibFrac, ring) {
  const t = size * nibFrac
  const off = (size - t) / 2
  const glow = size * 0.42
  const ringInset = size * 0.085
  const ringSvg = ring
    ? `<rect x="${ringInset}" y="${ringInset}" width="${size - 2 * ringInset}" height="${size - 2 * ringInset}" rx="${size * 0.2}" fill="none" stroke="${GOLD}" stroke-opacity="0.28" stroke-width="${Math.max(1, size * 0.006)}"/>`
    : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <radialGradient id="glow" cx="50%" cy="42%" r="60%">
        <stop offset="0%" stop-color="${GOLD}" stop-opacity="0.20"/>
        <stop offset="55%" stop-color="${GOLD}" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="${INK}"/>
    <circle cx="${size / 2}" cy="${size * 0.42}" r="${glow}" fill="url(#glow)"/>
    ${ringSvg}
    <svg x="${off}" y="${off}" width="${t}" height="${t}" viewBox="5.5 6.4 16 16">${NIB}</svg>
  </svg>`
}

// any-purpose icons show as-is: nib fills more of the tile, with a hairline ring.
// maskable icons are cropped by the OS mask: nib kept well inside the safe zone.
const ICONS = [
  { name: "icon-192.png", size: 192, nibFrac: 0.62, ring: true },
  { name: "icon-512.png", size: 512, nibFrac: 0.62, ring: true },
  { name: "icon-192-maskable.png", size: 192, nibFrac: 0.46, ring: false },
  { name: "icon-512-maskable.png", size: 512, nibFrac: 0.46, ring: false },
]

const browser = await chromium.launch()
try {
  for (const { name, size, nibFrac, ring } of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{background:${INK}}</style>${icon(size, nibFrac, ring)}`,
      { waitUntil: "networkidle" },
    )
    const file = join(OUT, name)
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: size, height: size } })
    await page.close()
    console.log(`wrote ${file} (${size}×${size}${ring ? " any" : " maskable"})`)
  }
} finally {
  await browser.close()
}
