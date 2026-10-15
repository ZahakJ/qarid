/**
 * `GET /privacy` — the privacy policy as a static page, the URL the Play
 * listing gives. `client/public/privacy.html` is copied into dist/ by the
 * build; the one deployment-specific value, the contact address, comes from
 * `PRIVACY_CONTACT` and fills the element marked `data-contact`. Unset, that
 * element is removed, the same rule as the in-app page: no placeholder ever
 * reaches a reader.
 */
import fs from "node:fs"
import path from "node:path"
import type { Context, Hono } from "hono"
import { escapeHtml } from "./share.ts"

const CONTACT_RE = /<p data-contact>[\s\S]*?<\/p>\s*/

export function renderPrivacy(html: string, contact: string | undefined): string {
  const value = (contact ?? "").trim()
  if (!value) return html.replace(CONTACT_RE, "")
  return html.replace(CONTACT_RE, (block) => block.replace("{{contact}}", escapeHtml(value)))
}

export function mountPrivacy(app: Hono, distDir: string, contact: string | undefined): void {
  const file = path.join(distDir, "privacy.html")
  if (!fs.existsSync(file)) return
  const body = renderPrivacy(fs.readFileSync(file, "utf8"), contact)
  const send = (c: Context) => {
    c.header("Cache-Control", "public, max-age=3600")
    return c.html(body)
  }
  app.get("/privacy", send)
  app.get("/privacy.html", send)
}
