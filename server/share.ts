/**
 * The `<head>` a SHARED قصيدة link is served with — `GET /p/:publicId`.
 *
 * Why this file exists at all: قريض is hash-routed, and a URL fragment is never
 * sent to a server. `#/poem/16182` therefore CANNOT be given per-قصيدة preview
 * tags by any amount of server work — the box does not know, and cannot know,
 * which قصيدة the link is for. Every one of the 238,733 unfurled as the same
 * generic card.
 *
 * So a shared link is a real PATH — `/p/16182` — which the server does see. It
 * answers with the ordinary SPA shell plus that قصيدة's own tags, and the
 * client turns the path back into `#/poem/16182` at boot (client/router.ts).
 * Crawlers do not run scripts, so they keep the tags; readers never see the
 * path for longer than a `replaceState`.
 *
 * Two rules:
 *  1. EVERY interpolated value is escaped. The عنوان, the مطلع and the شاعر's
 *     name are scraped corpus text, not our prose, and they land inside a
 *     double-quoted attribute.
 *  2. No U+200F here, unlike the share BLOCK in client/poem/share.ts. That mark
 *     is there because a chat message is made of LINES and one of them starts
 *     with the `h` of `https`; a meta tag's value is a lone Arabic phrase in
 *     somebody else's UI, and a stray invisible is one more thing to render.
 */
import { normalizeArabic } from "../shared/arabic.ts"
import { formatBaits } from "../shared/format.ts"

/** Escape for text AND for a double-quoted attribute value. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export type PoemMeta = {
  /** عنوان, or the مطلع when the قصيدة has none */
  heading: string
  /** true when `heading` is that مطلع */
  isMatla: boolean
  poet: string
  count: number
  /** the مطلع, for the description when the heading is a real عنوان */
  matla?: string | null
  /** the canonical `/p/<id>` URL this was served under */
  url: string
  /** absolute URL of the preview image, or null for none */
  image?: string | null
}

/** «سبيل الجَماهير — قريض», the tab title and the unfurl's headline. */
export function poemTitle({ heading }: Pick<PoemMeta, "heading">): string {
  const name = heading.trim()
  return name ? `${name} — قريض` : "قريض"
}

/**
 * «محمد مهدي الجواهري · 38 بيتًا — لو أن مقاليد الجماهير في يدي»
 *
 * The شاعر and the length first, because they are what decides whether a link
 * is worth opening; the مطلع after them when it is not already the headline.
 */
export function poemDescription({ heading, isMatla, poet, count, matla }: Omit<PoemMeta, "url">): string {
  const parts: string[] = []
  const name = poet.trim()
  if (name) parts.push(name)
  // `formatBaits(0)` is «لا أبيات» — a clause, not a معدود — and gluing that
  // after a name reads as a complaint. Same guard as the share block's.
  if (count > 0) parts.push(formatBaits(count))
  const head = parts.join(" · ")

  const taste = !isMatla && !echoesHeading(heading, matla) ? (matla ?? "").trim() : ""
  if (head && taste) return `${head} — ${taste}`
  return head || taste || "ديوان الشعر العربي ومساجلته"
}

/**
 * Whether the مطلع would only repeat the headline.
 *
 * A corpus quirk, not a hypothetical: a great many aldiwan titles ARE the first
 * hemistich with the تشكيل stripped, so «سقتني حميا الحب راحة مقلتي» sits in
 * `title` and «سَقَتني حُمَيَّا الحُبَّ راحَةَ مُقلَتي» in `preview_sadr`, and
 * an unfurl that prints both says the same line twice in one card. The
 * comparison goes through `shared/arabic.ts` — the ONE normalizer — because
 * that is exactly the difference it exists to erase. Containment counts too: a
 * title is sometimes the مطلع cut short.
 */
function echoesHeading(heading: string, matla: string | null | undefined): boolean {
  const a = normalizeArabic(heading)
  const b = normalizeArabic(matla)
  if (!a || !b) return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

/** The og:/twitter: block for one قصيدة, ready to drop before `</head>`. */
export function poemMetaTags(meta: PoemMeta): string {
  const title = poemTitle(meta)
  const desc = poemDescription(meta)
  const tags = [
    ["og:type", "article"],
    ["og:site_name", "قريض"],
    ["og:title", title],
    ["og:description", desc],
    ["og:url", meta.url],
    ["og:locale", "ar_AR"],
  ]
  if (meta.image) tags.push(["og:image", meta.image])

  const lines = tags.map(([p, v]) => `<meta property="${escapeHtml(p!)}" content="${escapeHtml(v!)}" />`)
  // Twitter reads og:* for everything but the card SHAPE, so only the two that
  // have no Open Graph equivalent are spelled twice.
  lines.push(`<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}" />`)
  lines.push(`<meta name="description" content="${escapeHtml(desc)}" />`)
  return lines.join("\n    ")
}

/**
 * Put one قصيدة's identity into the shell.
 *
 * The shell's own `<title>` and `<meta name="description">` are REPLACED rather
 * than appended to: a document with two of either lets each scraper pick a
 * different one, and half of them pick the first.
 */
export function injectPoemHead(html: string, meta: PoemMeta): string {
  const title = escapeHtml(poemTitle(meta))
  let out = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
  out = out.replace(/\s*<meta\s+name="description"[^>]*>/i, "")
  const tags = poemMetaTags(meta)
  return out.replace(/<\/head>/i, `    ${tags}\n  </head>`)
}
