#!/usr/bin/env node
/**
 * قريض smoke test.
 *
 * Builds the client (unless --no-build), starts the REAL server on :6750 over
 * the corpus artefact, then walks every route in design-server.md §9 in
 * headless Chromium: wait for `body[data-app-ready="1"]`, fail on any console
 * error or page error, write screenshots/<route>.png.
 *
 *   node tools/screenshot.mjs [--no-build] [--no-db] [--mobile] [--full]
 *                             [--port N] [--db PATH] [--poem ID] [--out DIR]
 *                             [--routes home,browse,…] [--seed FILE|off]
 *
 * DB selection: `--db PATH`, else data/qarid.db, else data/fixture.db, else
 * fail with a clear message telling you which npm script builds one. `--no-db`
 * deliberately points the server at a path that does not exist, so
 * `openDbIfPresent` returns null, /api/* answers 503 and only the static shell
 * is exercised — that is the Phase-0 mode, before any ingest has run.
 *
 * Port 6750 is the DEFAULT (dev API 5750 / vite 5751 / preview-smoke 6750 /
 * prod 8010); `--port N` moves it, which is how a build agent shoots its own
 * work without colliding with the human's smoke run. `--poem ID` pins the
 * قصيدة route to one public id instead of "whatever /api/poems returns first",
 * so a layout iteration keeps shooting the same page.
 *
 * SEEDING: `tools/smoke-seed.json` maps a route name (plus an optional "*" that
 * applies to every route) to the `qarid:v1:*` localStorage entries that route
 * should boot with — that is how `duel-play` and `duel-summary` are shot with a
 * مساجلة in progress without playing one. Seeded state is applied and the page
 * RELOADED (a hash change would not re-run the stores), and it is cleared again
 * before the next route, so no two routes can contaminate each other.
 * `--seed off` disables it; `--seed FILE` points elsewhere.
 *
 * The child's PID is the
 * ONLY thing this script kills — other services in the suite share the
 * `server/index.ts` path and a broad pkill takes them all down.
 */
import { spawn, execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, dirname, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const argv = process.argv.slice(2)
const noBuild = argv.includes("--no-build")
const noDb = argv.includes("--no-db")
const mobile = argv.includes("--mobile")
// Design iteration wants the WHOLE page; the smoke run wants the fold.
const full = argv.includes("--full")

/** `--flag value` or `--flag=value`; undefined when the flag is absent. */
function flag(name) {
  const i = argv.indexOf(`--${name}`)
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : undefined
}

const PORT = Number(flag("port") ?? 6750)
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error(`FAIL — --port must be an integer 1024–65535, got ${flag("port")}`)
  process.exit(1)
}
const ORIGIN = `http://127.0.0.1:${PORT}`
const OUT_DIR = (() => {
  const o = flag("out") ?? "screenshots"
  return isAbsolute(o) ? o : join(ROOT, o)
})()
const PINNED_POEM = flag("poem")
/** `--routes home,browse` shoots a subset; undefined shoots them all. */
const ONLY = flag("routes")?.split(",").map((r) => r.trim()).filter(Boolean)

/** localStorage fixtures per route — see SEEDING above. `--seed off` skips. */
const SEED_ARG = flag("seed")
const SEED_FILE = SEED_ARG === "off" ? null : isAbsolute(SEED_ARG ?? "") ? SEED_ARG : join(ROOT, SEED_ARG ?? "tools/smoke-seed.json")
let SEEDS = null
if (SEED_FILE) {
  if (existsSync(SEED_FILE)) {
    try {
      SEEDS = JSON.parse(readFileSync(SEED_FILE, "utf8"))
    } catch (err) {
      console.error(`FAIL — ${SEED_FILE} is not valid JSON: ${err.message}`)
      process.exit(1)
    }
  } else if (SEED_ARG) {
    console.error(`FAIL — --seed ${SEED_ARG} does not exist (looked at ${SEED_FILE})`)
    process.exit(1)
  }
}

/** The entries one route boots with: the "*" block, overridden by its own. */
function seedFor(name) {
  if (!SEEDS) return {}
  return { ...(SEEDS["*"] ?? {}), ...(SEEDS[name] ?? {}) }
}

// ── pick the corpus ────────────────────────────────────────────────────────
const REAL_DB = join(ROOT, "data", "qarid.db")
const FIXTURE_DB = join(ROOT, "data", "fixture.db")
const EXPLICIT_DB = flag("db")
let dbPath
if (noDb) {
  dbPath = join(ROOT, "data", "__no-db__.sqlite") // deliberately absent
  console.log("smoke: --no-db — static shell only, /api/* will answer 503")
} else if (EXPLICIT_DB) {
  dbPath = isAbsolute(EXPLICIT_DB) ? EXPLICIT_DB : join(ROOT, EXPLICIT_DB)
  if (!existsSync(dbPath)) {
    console.error(`FAIL — --db ${EXPLICIT_DB} does not exist (looked at ${dbPath})`)
    process.exit(1)
  }
  console.log(`smoke: using ${dbPath}`)
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
      "  point at one with `--db data/fixture.db`,",
      "  or run `node tools/screenshot.mjs --no-db` to smoke the static shell only.",
    ].join("\n"),
  )
  process.exit(1)
}

if (!noBuild) {
  console.log("building…")
  execSync("npm run build", { cwd: ROOT, stdio: "pipe" })
}
mkdirSync(OUT_DIR, { recursive: true })

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
  const poemId = PINNED_POEM ?? (await firstOf("/api/poems?limit=1", (j) => j?.items?.[0]?.id)) ?? "1"

  const routes = [
    ["home", "/#/"],
    ["poets", "/#/poets"],
    ["poet", `/#/poet/${encodeURIComponent(poetSlug)}`],
    ["poem", `/#/poem/${encodeURIComponent(poemId)}`],
    ["browse", "/#/browse"],
    ["search", "/#/search?q=%D8%A7%D9%84%D8%AE%D9%8A%D9%84"],
    ["duel", "/#/duel"],
    ["duel-play", "/#/duel/play"],
    ["duel-summary", "/#/duel/summary"],
    ["daily", "/#/daily"],
    ["train", "/#/train"],
    ["train-drill", "/#/train/drill"],
    ["train-arsenal", "/#/train/arsenal"],
    ["wander", "/#/wander"],
    ["favorites", "/#/favorites"],
    ["rules", "/#/rules"],
    ["stats", "/#/stats"],
  ].filter(([name]) => !ONLY || ONLY.includes(name))

  if (routes.length === 0) {
    throw new Error(`--routes matched nothing (asked for ${ONLY?.join(", ")})`)
  }

  browser = await chromium.launch()
  /**
   * `--mobile` is a PHONE, not a narrow desktop window.
   *
   * A 390-wide viewport alone leaves `@media (hover: none), (pointer: coarse)`
   * unmatched, so every mobile shot kept showing what only a keyboard-and-mouse
   * reader gets: the omnibox's `/` badge, BaytPlate's hover action rail, the
   * duel's «Shift+Enter» hint. `hasTouch` is what flips the pointer/hover media
   * features, and `isMobile` turns on the meta-viewport + mobile-UA emulation
   * that goes with them (Chromium only, which is what we launch).
   */
  const emulation = mobile
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
    : { viewport: { width: 1440, height: 900 } }

  const errors = []
  /** Non-ok responses and dead requests, with their URLs — see pageFor(). */
  const failures = []
  let ctx = null
  let page = null
  let applied = null

  /**
   * A page whose localStorage already holds `seed` BEFORE the app boots. The
   * stores read storage once, at module load, and `#/duel/play` bounces to
   * `#/duel` the instant it finds no session — so seeding after navigation is
   * always a step too late. `addInitScript` runs ahead of every document, which
   * is why the seed lives on the CONTEXT and a new seed means a new context.
   */
  async function pageFor(seed) {
    const wanted = JSON.stringify(seed)
    if (page && applied === wanted) return page
    if (ctx) await ctx.close()
    ctx = await browser.newContext({ ...emulation, deviceScaleFactor: 2, locale: "ar" })
    if (Object.keys(seed).length) {
      await ctx.addInitScript((entries) => {
        try {
          for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, JSON.stringify(v))
        } catch {
          /* storage unavailable — the route still renders its empty state */
        }
      }, seed)
    }
    page = await ctx.newPage()
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`${page.url()} — ${msg.text()}`)
    })
    page.on("pageerror", (err) => errors.push(`${page.url()} — ${String(err)}`))
    // Chromium's console message for a failed subresource is «Failed to load
    // resource: the server responded with a status of 404» and NOTHING else —
    // no URL, so the report names a route and not a cause. These two listeners
    // are the missing half: every non-ok response and every dead request is
    // recorded with its URL, and the failure report prints them alongside.
    page.on("response", (res) => {
      if (res.status() >= 400) failures.push(`${res.status()} ${res.url()}`)
    })
    page.on("requestfailed", (req) => {
      failures.push(`${req.failure()?.errorText ?? "failed"} ${req.url()}`)
    })
    applied = wanted
    return page
  }

  for (const [name, path] of routes) {
    const page = await pageFor(seedFor(name))
    await page.goto(`${ORIGIN}${path}`, { waitUntil: "networkidle" })
    await page.waitForSelector('body[data-app-ready="1"]', { timeout: 10000 })
    await page.evaluate(() => document.fonts.ready)
    // Entrance animations (client/styles/motion.css: a 360ms rise on up to
    // eight staggered steps) are still running when the app reports ready, and
    // a shot taken through one is a page of half-faded boxes. Wait for every
    // FINITE animation to finish — the page's own bloom drifts forever, so it
    // is filtered out — with a ceiling so a stuck animation cannot hang a run.
    await page.evaluate(
      () =>
        Promise.race([
          Promise.all(
            document
              .getAnimations()
              .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
              .map((a) => a.finished.catch(() => {})),
          ),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]),
    )
    await page.waitForTimeout(150)
    const file = join(OUT_DIR, mobile ? `${name}-390.png` : `${name}.png`)
    await page.screenshot({ path: file, fullPage: full })
    console.log(`  ✓ ${name}`)
  }

  if (errors.length) {
    console.error(`FAIL — ${errors.length} console error(s):`)
    for (const e of errors) console.error(`  ${e}`)
    if (failures.length) {
      console.error(`  ── the requests behind them ──`)
      for (const f of [...new Set(failures)]) console.error(`  ${f}`)
    }
    failed = true
  } else {
    console.log(`smoke green — ${OUT_DIR} updated`)
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
