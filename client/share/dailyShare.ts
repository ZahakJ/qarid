/**
 * Sharing بيت اليوم — the link `/d/<date>` and the text that carries it.
 *
 *     ‏بيت اليوم · 14 تشرين الأول 2026
 *     ‏على قدر أهل العزم تأتي العزائم … وتأتي على قدر الكرام المكارم
 *     ‏— أبو الطيب المتنبي
 *     ‏https://qarid.example.com/d/2026-10-14
 *
 * The link is a real PATH, not `#/day/<date>`, for the reason `/p/<id>` is:
 * a fragment never reaches the server, so only a path can unfurl with that
 * day's own card (server/daily.ts). It folds back into the hash route at boot
 * (client/router.ts).
 *
 * Delivery, best channel first: the native share sheet in the app, the Web
 * Share API in a browser that has one, the clipboard otherwise.
 */
import { arabicDay } from "../../shared/format.ts"
import { formatBayt, RLM, writeClipboard } from "../bayt/copy.ts"
import { shareOrigin } from "../platform/native.ts"
import { nativeShareText } from "../platform/share.ts"
import { toast } from "../store/toastStore.ts"

/** `https://…/d/2026-10-14` — `origin` comes from `shareOrigin()`, never `location`. */
export function dailyShareUrl(origin: string, date: string): string {
  return `${origin.replace(/\/+$/, "")}/d/${encodeURIComponent(date)}`
}

export type DailyShareInput = {
  date: string
  sadr: string
  ajuz?: string | null
  poet?: string | null
  url: string
}

/** The block that leaves the app. Every line opens with U+200F (client/bayt/copy.ts). */
export function dailyShareText({ date, sadr, ajuz, poet, url }: DailyShareInput): string {
  const head = `${RLM}بيت اليوم · ${arabicDay(date)} ${date.slice(0, 4)}`
  const name = (poet ?? "").trim()
  const lines = [head, formatBayt(sadr, ajuz)]
  if (name) lines.push(`${RLM}— ${name}`)
  lines.push(`${RLM}${url}`)
  return lines.join("\n")
}

export type ShareOutcome = "shared" | "copied" | "dismissed" | "failed"

/** Hand a text block to the reader's best channel — بيت اليوم's, or a مساجلة's. */
export async function shareTextBlock(text: string): Promise<ShareOutcome> {
  if (await nativeShareText(text)) return "shared"

  const nav = typeof navigator !== "undefined" ? navigator : undefined
  if (nav?.share) {
    try {
      await nav.share({ title: "قريض", text })
      return "shared"
    } catch (e) {
      // Closing the sheet is an answer, not a failure — no clipboard behind it.
      if (e instanceof DOMException && e.name === "AbortError") return "dismissed"
    }
  }
  return (await writeClipboard(text)) ? "copied" : "failed"
}

/** The «شارك» button on بيت اليوم: build the block, send it, say what happened. */
export async function shareDailyBait(bayt: Omit<DailyShareInput, "url">): Promise<void> {
  const text = dailyShareText({ ...bayt, url: dailyShareUrl(shareOrigin(), bayt.date) })
  const outcome = await shareTextBlock(text)
  if (outcome === "copied") toast("نُسخ رابط بيت اليوم", "ok")
  else if (outcome === "failed") toast("تعذّرت المشاركة", "danger")
}
