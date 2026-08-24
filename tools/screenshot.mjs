#!/usr/bin/env node
/**
 * قريض smoke test.
 *
 * Builds the client (unless --no-build), starts the REAL server on :6750 over
 * the corpus artefact, then walks every route in design-server.md §9 in
 * headless Chromium: wait for `body[data-app-ready="1"]`, fail on any console
 * error or page error, write screenshots/<route>.png.
 *
 *   node tools/screenshot.mjs [--no-build] [--no-db] [--mobile]
 *
 * DB selection: data/qarid.db, else data/fixture.db, else fail with a clear
 * message telling you which npm script builds one. `--no-db` deliberately
 * points the server at a path that does not exist, so `openDbIfPresent`
 * returns null, /api/* answers 503 and only the static shell is exercised —
 * that is the Phase-0 mode, before any ingest has run.
 *
 * Port 6750 is fixed (dev API 5750 / vite 5751 / preview-smoke 6750 / prod
 * 8010). The child's PID is the ONLY thing this script kills — other services
 * in the suite share the `server/index.ts` path and a broad pkill takes them
 * all down.
 */
import { spawn, execSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PORT = 6750
const ORIGIN = `http://127.0.0.1:${PORT}`

const argv = process.argv.slice(2)
const noBuild = argv.includes("--no-build")
const noDb = argv.includes("--no-db")
const mobile = argv.includes("--mobile")

// ── pick the corpus ────────────────────────────────────────────────────────
const REAL_DB = join(ROOT, "data", "qarid.db")
const FIXTURE_DB = join(ROOT, "data", "fixture.db")
let dbPath
if (noDb) {
  dbPath = join(ROOT, "data", "__no-db__.sqlite") // deliberately absent
  console.log("smoke: --no-db — static shell only, /api/* will answer 503")
} else if (existsSync(REAL_DB)) {
  dbPath = REAL_DB
} else if (existsSync(FIXTURE_DB)) {
  dbPath = FIXTURE_DB
  console.log("smoke: using data/fixture.db (data/qarid.db not built)")
} else {
  console.error(
    [
      "FAIL — no corpus to serve.",
      `  looked for: ${REAL_DB}`,
      `              ${FIXTURE_DB}`,
      "  build one with `npm run ingest` (15–30 min) or `npm run ingest:fixture` (seconds),",
      "  or run `node tools/screenshot.mjs --no-db` to smoke the static shell only.",
    ].join("\n"),
  )
  process.exit(1)
}

if (!noBuild) {
  console.log("building…")
  execSync("npm run build", { cwd: ROOT, stdio: "pipe" })
}
mkdirSync(join(ROOT, "screenshots"), { recursive: true })

const server = spawn("node", ["server/index.ts"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), DB_PATH: dbPath, NODE_ENV: "production" },
})
const serverPid = server.pid
let serverLog = ""
server.stdout.on("data", (d) => (serverLog += d))
server.stderr.on("data", (d) => (serverLog += d))
server.on("exit", (code) => {
  if (code !== null && code !== 0) console.error(`server exited with ${code}\n${serverLog}`)
})

let failed = false
let browser
try {
  await waitFor(`${ORIGIN}/healthz`, 15000)

  // Real ids when a corpus is present; harmless placeholders in --no-db mode
  // (the hash router resolves an unknown poem id to home rather than erroring).
  const poetSlug = (await firstOf("/api/poets?limit=1", (j) => j?.items?.[0]?.slug)) ?? "almutanabbi"
  const poemId = (await firstOf("/api/poems?limit=1", (j) => j?.items?.[0]?.id)) ?? "1"

  const routes = [
    ["home", "/#/"],
    ["poets", "/#/poets"],
    ["poet", `/#/poet/${encodeURIComponent(poetSlug)}`],
    ["poem", `/#/poem/${encodeURIComponent(poemId)}`],
    ["browse", "/#/browse"],
    ["search", "/#/search?q=%D8%A7%D9%84%D8%AE%D9%8A%D9%84"],
    ["duel", "/#/duel"],
    ["daily", "/#/daily"],
  ]

  browser = await chromium.launch()
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, locale: "ar" })

  const errors = []
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${page.url()} — ${msg.text()}`)
  })
  page.on("pageerror", (err) => errors.push(`${page.url()} — ${String(err)}`))

  for (const [name, path] of routes) {
    await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle" })
    await page.waitForSelector('body[data-app-ready="1"]', { timeout: 10000 })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(150)
    const file = join(ROOT, "screenshots", mobile ? `${name}-390.png` : `${name}.png`)
    await page.screenshot({ path: file, fullPage: false })
    console.log(`  ✓ ${name}`)
  }

  if (errors.length) {
    console.error(`FAIL — ${errors.length} console error(s):`)
    for (const e of errors) console.error(`  ${e}`)
    failed = true
  } else {
    console.log("smoke green — screenshots/ updated")
  }
} catch (err) {
  console.error(`FAIL — ${err instanceof Error ? err.message : err}`)
  if (serverLog.trim()) console.error(`--- server output ---\n${serverLog}`)
  failed = true
} finally {
  if (browser) await browser.close().catch(() => {})
  // Kill by PID only. Never by pattern: other suite services share this path.
  if (serverPid) {
    try {
      process.kill(serverPid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
}
process.exit(failed ? 1 : 0)

async function waitFor(url, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up at ${url}\n${serverLog}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Read one value out of an API response; null when the route is not there yet. */
async function firstOf(path, pick) {
  try {
    const res = await fetch(`${ORIGIN}${path}`)
    if (!res.ok) return null
    return pick(await res.json()) ?? null
  } catch {
    return null
  }
}
