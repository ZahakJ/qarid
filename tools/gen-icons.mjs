#!/usr/bin/env node
/**
 * Generate the قريض app icons — PWA (docs/roadmap-mobile.md §M0) AND the Android
 * launcher set — from the app's own gold-nib motif
 * (client/components/Ornaments.tsx `Nib`, index.html favicon): inked background,
 * gold nib, and a maskable safe zone.
 *
 * The Android mipmaps are generated HERE rather than by hand or by
 * capacitor-assets, because hand-made ones go stale silently: the نِيب lost a
 * mis-drawn slit and every source copy was updated, but the launcher icons kept
 * it for a whole release — they are the one place the motif appears that no
 * build step touched, and the one place a reader looks at every day.
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

/** Android launcher densities: [dir suffix, ic_launcher px, foreground px]. */
const ANDROID_DENSITIES = [
  ["mdpi", 48, 108],
  ["hdpi", 72, 162],
  ["xhdpi", 96, 216],
  ["xxhdpi", 144, 324],
  ["xxxhdpi", 192, 432],
]
const ANDROID_RES = join(ROOT, "android", "app", "src", "main", "res")

const INK = "#07080c"
const GOLD = "#d6ad60"

// The نِيب, framed tightly so the nested <svg viewBox> centres it on the canvas.
const NIB = `
  <path d="M6 21c5.4-1.8 9.4-6.4 11.4-13.2L21 11c-2 7.4-6.8 10.9-15 12Z" fill="${GOLD}"/>
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
function icon(size, nibFrac, ring, transparent = false) {
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
    ${transparent ? "" : `<rect width="${size}" height="${size}" fill="${INK}"/>`}
    ${transparent ? "" : `<circle cx="${size / 2}" cy="${size * 0.42}" r="${glow}" fill="url(#glow)"/>`}
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

/** Render one SVG to a PNG at exactly `size`. */
async function shoot(browser, svg, size, file, transparent = false) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  })
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{background:${
      transparent ? "transparent" : INK
    }}</style>${svg}`,
    { waitUntil: "networkidle" },
  )
  await page.screenshot({
    path: file,
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: transparent,
  })
  await page.close()
}

const browser = await chromium.launch()
try {
  for (const { name, size, nibFrac, ring } of ICONS) {
    const file = join(OUT, name)
    await shoot(browser, icon(size, nibFrac, ring), size, file)
    console.log(`wrote ${file} (${size}×${size}${ring ? " any" : " maskable"})`)
  }

  // ── Android launcher set ──────────────────────────────────────────────
  // `ic_launcher` is the legacy square tile (pre-API-26 and some launchers);
  // `ic_launcher_round` the circular one; `ic_launcher_foreground` the adaptive
  // FOREGROUND layer, which must be transparent — mipmap-anydpi-v26 pairs it
  // with `@color/ic_launcher_background` (#07080c) — and must keep the نِيب
  // inside the ~66% safe circle the OS mask leaves, hence the maskable fraction.
  for (const [density, tile, fg] of ANDROID_DENSITIES) {
    const dir = join(ANDROID_RES, `mipmap-${density}`)
    mkdirSync(dir, { recursive: true })

    await shoot(browser, icon(tile, 0.62, true), tile, join(dir, "ic_launcher.png"))

    const round = `<svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}" viewBox="0 0 ${tile} ${tile}">
      <defs><clipPath id="c"><circle cx="${tile / 2}" cy="${tile / 2}" r="${tile / 2}"/></clipPath></defs>
      <g clip-path="url(#c)">${icon(tile, 0.62, false)}</g>
    </svg>`
    await shoot(browser, round, tile, join(dir, "ic_launcher_round.png"), true)

    await shoot(browser, icon(fg, 0.46, false, true), fg, join(dir, "ic_launcher_foreground.png"), true)

    console.log(`wrote ${dir}/ic_launcher{,_round,_foreground}.png (${tile}/${tile}/${fg})`)
  }
} finally {
  await browser.close()
}
