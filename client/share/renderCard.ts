/**
 * THE only بيت-card renderer (design-ux.md §6, §8 v1.5).
 *
 * One canvas, two sizes: 1200×630 for a link preview and 1080×1080 for a
 * square post. Everything is painted, nothing is fetched — the card must work
 * offline, and the artefact it produces is a PNG the reader owns.
 *
 * Three rules the Arabic forces on us:
 *  • `ctx.direction = "rtl"` and `ctx.textAlign = "center"` — canvas does not
 *    inherit the document's direction, and a hemistich painted LTR reorders its
 *    punctuation. Both hemistichs are centred, the way a ديوان sets them.
 *  • **Wait for the face.** `document.fonts.load('400 64px Amiri')` must resolve
 *    BEFORE the first `fillText`, or the card ships in a fallback naskh and the
 *    reader never sees Amiri (CLAUDE.md §7 hard requirement).
 *  • Never letter-space, never italicise, never scale the glyphs non-uniformly:
 *    the fit loop shrinks the FONT SIZE, it does not squeeze the text.
 */

import { nativeShareFile } from "../platform/share.ts"

const GOLD = "#d6ad60"
const LAPIS = "#5c7cc8"
const INK = "#07080c"
const TEXT = "#ece6da"
const MUTED = "#9d9689"

export type CardShape = "wide" | "square"

export type CardBayt = {
  sadr: string
  ajuz?: string | null
  poet?: string | null
  /** عنوان القصيدة, printed under the poet when there is one */
  poem?: string | null
}

const SHAPES: Record<CardShape, { w: number; h: number }> = {
  wide: { w: 1200, h: 630 },
  square: { w: 1080, h: 1080 },
}

/** The faces the card paints with; all of them must be ready before we start. */
export async function loadCardFonts(): Promise<void> {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined
  if (!fonts) return
  await Promise.all([
    fonts.load('400 64px "Amiri"'),
    fonts.load('700 64px "Amiri"'),
    fonts.load('400 40px "Aref Ruqaa"'),
    fonts.load('400 24px "IBM Plex Sans Arabic"'),
  ]).catch(() => undefined)
  await fonts.ready.catch(() => undefined)
}

/**
 * The largest size ≤ `start` at which `text` fits inside `max` px. Shrinking
 * the size is the only legal way to fit Arabic — see the header.
 */
export function fitSize(ctx: CanvasRenderingContext2D, text: string, family: string, max: number, start: number, min: number): number {
  let size = start
  while (size > min) {
    ctx.font = `400 ${size}px ${family}`
    if (ctx.measureText(text).width <= max) break
    size -= 2
  }
  return size
}

/** Two strings that are the same line of verse once tashkeel and hamza vary. */
export function sameLine(a: string, b: string): boolean {
  const bare = (t: string) =>
    t
      .normalize("NFKC")
      .replace(/[\u064B-\u0655\u0670\u06D6-\u06ED\u0640]/g, "")
      .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
      .replace(/\s+/g, "")
      .trim()
  const x = bare(a)
  const y = bare(b)
  return x !== "" && (x === y || y.includes(x) || x.includes(y))
}

/** The slow illumination bloom of the app, frozen into one frame. */
function paintGround(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, w, h)

  const bloom = (x: number, y: number, r: number, rgb: string, alpha: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(${rgb}, ${alpha})`)
    g.addColorStop(1, "rgba(0,0,0,0)")
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }
  bloom(w * 0.22, h * 0.14, Math.max(w, h) * 0.7, "214, 173, 96", 0.1)
  bloom(w * 0.78, h * 0.86, Math.max(w, h) * 0.7, "92, 124, 200", 0.08)

  // the gold hairline frame, and the dissolving rule under the verse
  ctx.strokeStyle = "rgba(214,173,96,.34)"
  ctx.lineWidth = 1
  const inset = Math.round(w * 0.028)
  ctx.strokeRect(inset + 0.5, inset + 0.5, w - inset * 2 - 1, h - inset * 2 - 1)
}

/** A gold rule that fades at both ends — the app's `--rule-gold`, painted. */
function paintRule(ctx: CanvasRenderingContext2D, y: number, w: number): void {
  const g = ctx.createLinearGradient(w * 0.2, 0, w * 0.8, 0)
  g.addColorStop(0, "rgba(214,173,96,0)")
  g.addColorStop(0.2, "rgba(214,173,96,.34)")
  g.addColorStop(0.8, "rgba(214,173,96,.34)")
  g.addColorStop(1, "rgba(214,173,96,0)")
  ctx.fillStyle = g
  ctx.fillRect(w * 0.2, y, w * 0.6, 1)
}

/**
 * Paint one بيت onto a fresh canvas. `loadCardFonts()` must have resolved.
 * Returns the canvas so the caller decides what to do with the pixels.
 */
export function renderCard(bayt: CardBayt, shape: CardShape = "wide"): HTMLCanvasElement {
  const { w, h } = SHAPES[shape]
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) return canvas

  ctx.direction = "rtl"
  ctx.textAlign = "center"
  ctx.textBaseline = "alphabetic"
  paintGround(ctx, w, h)

  const max = w * 0.82
  const verse = 'Amiri, serif'
  const sadr = bayt.sadr.trim()
  const ajuz = (bayt.ajuz ?? "").trim()
  const start = shape === "wide" ? 62 : 66
  // ONE size for both hemistichs: a بيت whose halves are set differently is not
  // a بيت any more.
  const size = Math.min(
    // The floor is 20, not 26: a playable hemistich is ≤ 80 characters
    // (shared/constants PLAYABLE) but the قصيدة page will happily card a longer
    // one, and shrinking past the floor is the only way to fit it — Arabic is
    // never condensed to make room.
    fitSize(ctx, sadr, verse, max, start, 20),
    ajuz ? fitSize(ctx, ajuz, verse, max, start, 20) : start,
  )

  // A title that only repeats the بيت is noise on a card whose whole subject is
  // that بيت — «الخيل والليل والبيداء تعرفني» does not need saying twice.
  const title = bayt.poem && !sameLine(bayt.poem, sadr) ? bayt.poem.trim() : null

  const line = Math.round(size * 2.05)
  /* Aref Ruqaa is a display naskh with a very small apparent size: 42px of it
   * reads as ~20px of Plex. The poet is the second voice on the card, so it is
   * set at a nominal size that LOOKS like one, not at a number that matches the
   * UI scale. */
  const poetSize = bayt.poet ? fitSize(ctx, bayt.poet, '"Aref Ruqaa", serif', max, shape === "wide" ? 66 : 74, 28) : 0
  const titleSize = title ? fitSize(ctx, title, '"IBM Plex Sans Arabic", sans-serif', max, 24, 14) : 0

  // The stack is measured before it is drawn, then centred as a block: the
  // verse alone is not the composition, and centring it leaves the attribution
  // hanging off the bottom of an otherwise empty card.
  const gapRule = Math.round(size * 0.75)
  const gapPoet = poetSize ? Math.round(poetSize * 1.25) : 0
  const gapTitle = titleSize ? Math.round(poetSize * 0.2) + Math.round(titleSize * 1.25) : 0

  /* Centre the BLOCK, not the verse. Canvas positions text by its baseline, so
   * the composition is measured from the first baseline to the last and then
   * padded by the ink that hangs above and below them — otherwise the stack
   * floats high and the card ends on an empty half. The small lift keeps the
   * قريض mark and the domain in a band of their own along the bottom edge. */
  const ascent = Math.round(size * 0.8)
  const descent = Math.round((titleSize || Math.round(poetSize * 0.5) || size) * 0.4)
  const baselineSpan = (ajuz ? line : 0) + gapRule + gapPoet + gapTitle
  const lift = Math.round(h * 0.03)
  let y = Math.round((h - (ascent + baselineSpan + descent)) / 2) + ascent - lift

  ctx.fillStyle = TEXT
  ctx.font = `400 ${size}px ${verse}`
  ctx.fillText(sadr, w / 2, y)
  if (ajuz) {
    y += line
    ctx.fillText(ajuz, w / 2, y)
  }

  y += gapRule
  paintRule(ctx, y, w)

  // ── attribution ────────────────────────────────────────────────────────
  if (poetSize) {
    y += gapPoet
    ctx.fillStyle = GOLD
    ctx.font = `400 ${poetSize}px "Aref Ruqaa", serif`
    ctx.fillText(bayt.poet!, w / 2, y)
    y += Math.round(poetSize * 0.2)
  }
  if (titleSize && title) {
    y += Math.round(titleSize * 1.25)
    ctx.fillStyle = MUTED
    ctx.font = `400 ${titleSize}px "IBM Plex Sans Arabic", sans-serif`
    ctx.fillText(title, w / 2, y)
  }

  // ── the mark ───────────────────────────────────────────────────────────
  // «قريض» alone — a seal, not an address (owner's call: no URL on the card;
  // the name carries it). Aref Ruqaa hangs deep below its baseline, so the
  // clearance is measured from the DESCENDER to the gold frame, not from the
  // baseline to the canvas edge — at the old h−6.2% the ق tail grazed the
  // square card's frame and crossed the wide card's outright.
  const mark = shape === "wide" ? 54 : 60
  const frameInset = Math.round(w * 0.028)
  ctx.fillStyle = GOLD
  ctx.font = `400 ${mark}px "Aref Ruqaa", serif`
  ctx.textAlign = "right"
  ctx.fillText(
    "قريض",
    w - Math.round(w * 0.062),
    h - frameInset - Math.round(mark * 0.45) - Math.round(h * 0.022),
  )
  void LAPIS

  return canvas
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/png")
    } catch {
      resolve(null)
    }
  })
}

/** `الخيل والليل…` → a filesystem-safe stem for the downloaded PNG. */
export function fileStem(bayt: CardBayt): string {
  const base = (bayt.poet ? `${bayt.poet}-` : "") + bayt.sadr
  return `qarid-${base.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 48)}`
}

export type CardDelivery = "copied" | "shared" | "downloaded" | "failed"

/**
 * Render and hand the card over, best channel first: the OS share sheet (a
 * phone), then the clipboard (a desktop, where a PNG on the clipboard pastes
 * straight into the conversation), then a download. Whatever happens the
 * reader ends up holding the image, which is the whole point of the button.
 */
export async function shareCard(bayt: CardBayt, shape: CardShape = "wide"): Promise<CardDelivery> {
  await loadCardFonts()
  const canvas = renderCard(bayt, shape)
  const blob = await toBlob(canvas)
  if (!blob) return "failed"
  const name = `${fileStem(bayt)}.png`

  // Native shell: the OS sheet takes a file, not a blob, and the WebView does
  // not expose Web-Share file support — so route through @capacitor/share.
  if (await nativeShareFile(blob, name)) return "shared"

  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean }
  if (typeof File !== "undefined" && nav.share && nav.canShare) {
    try {
      const file = new File([blob], name, { type: "image/png" })
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: "قريض" })
        return "shared"
      }
    } catch {
      /* the reader dismissed the sheet, or the platform lied — fall through */
    }
  }

  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
      return "copied"
    } catch {
      /* no permission, or not a user gesture any more — fall through */
    }
  }

  try {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return "downloaded"
  } catch {
    return "failed"
  }
}

/** The one line of Arabic each delivery deserves. */
export const CARD_MESSAGE: Record<CardDelivery, string> = {
  copied: "نُسخت البطاقة — الصقها حيث شئت",
  shared: "بُعِثت البطاقة",
  downloaded: "حُفظت البطاقة صورةً",
  failed: "تعذّر رسم البطاقة",
}
