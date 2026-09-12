// What the OWNER of a ديوان actually sees on a PHONE. The smoke walk is signed
// out, so this view has never been shot.
import { chromium, devices } from "playwright"
import { baitAnchor } from "./shared/arabic.ts"

const ORIGIN = "http://127.0.0.1:6753"
const POEM = "788"
let cookie = ""
const api = async (path, opts = {}) => {
  const r = await fetch(ORIGIN + path, {
    ...opts,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
  })
  const set = r.headers.getSetCookie?.() ?? []
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ")
  return { status: r.status, body: await r.json().catch(() => null) }
}

const user = "phone" + Math.floor(Math.random() * 10000)
await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ username: user, password: "correct horse battery staple", displayName: user }),
})
const made = await api("/api/albums", { method: "POST", body: JSON.stringify({ title: "ما أحفظه" }) })
const code = made.body.album.code
const p = await api(`/api/poems/${POEM}/baits?offset=0&limit=50`)
const anchors = p.body.items.sort((a, b) => a.position - b.position).map((b) => baitAnchor(b.sadr, b.ajuz)).filter(Boolean)
await api(`/api/albums/${code}/baits`, { method: "POST", body: JSON.stringify({ items: anchors.map((h) => ({ hFull: h })) }) })
console.log("shelf:", code, anchors.length, "أبيات, owner:", user)

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices["Pixel 7"] })
await ctx.addCookies(cookie.split("; ").map((c) => {
  const [name, ...v] = c.split("=")
  return { name, value: v.join("="), domain: "127.0.0.1", path: "/" }
}))
const page = await ctx.newPage()
await page.goto(`${ORIGIN}/#/diwan/${code}`, { waitUntil: "networkidle" })
await page.waitForTimeout(1200)

const seen = async (sel) => {
  const n = await page.locator(sel).count()
  if (n === 0) return `0`
  const b = await page.locator(sel).first().boundingBox()
  return b ? `${n}, first at y=${Math.round(b.y)} size ${Math.round(b.width)}x${Math.round(b.height)}` : `${n}, NOT VISIBLE`
}
console.log("  rail          :", await seen(".diwan-row__rail"))
console.log("  ↑↓✕⟲ buttons  :", await seen(".diwan-move"))
console.log("  restore ⟲     :", await seen(".diwan-move--restore"))
console.log("  «احذفه»       :", await seen("text=احذفه"))
console.log("  «حرّر الديوان» :", await seen("text=حرّر الديوان"))
const railOpacity = await page.locator(".diwan-row__rail").first().evaluate((el) => getComputedStyle(el).opacity).catch(() => "n/a")
console.log("  rail opacity  :", railOpacity)
await page.screenshot({ path: process.argv[2], fullPage: false })
await browser.close()
console.log("CODE=" + code)
process.exit(0)
