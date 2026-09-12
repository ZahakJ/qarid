/**
 * tools/loadtest.mjs — the concurrency probe behind docs/load-test.md and the
 * §Backlog worker-thread trigger.
 *
 * It sweeps offered concurrency over a realistic route mix (mostly cheap/cached
 * reads, some deep/expensive corpus queries) and, alongside it, runs a dedicated
 * /healthz prober — the liveness route touches no database, so its latency under
 * load is the pure head-of-line-blocking cost the synchronous single-loop design
 * imposes. When /healthz p95 leaves its 150 ms budget, that is trigger (b) for
 * the deferred SQLite worker thread (CLAUDE.md §Backlog).
 *
 * It is a MEASUREMENT tool, not a server change: point it at a server you own
 * (never prod :8010) that is reading the real corpus.
 *
 *   # start a server you own on a high port with a scratch users db, then:
 *   BASE=http://127.0.0.1:6760 node tools/loadtest.mjs
 *   LEVELS=1,5,10,25,50,100 DUR=4000 node tools/loadtest.mjs
 *
 * Closed-loop workers (one in-flight request each, N of them = N offered
 * concurrency). The mix weights approximate a real session: browse/read/search
 * dominate, deep baits pages and training pulls are the occasional heavy tail.
 */

const BASE = process.env.BASE || "http://127.0.0.1:6760"
const DURATION_MS = Number(process.env.DUR || 4000)
const LEVELS = (process.env.LEVELS || "1,5,10,25,50,100").split(",").map(Number)
const BUDGET_MS = 150

const pick = (a) => a[(Math.random() * a.length) | 0]

async function timed(path) {
  const t0 = performance.now()
  try {
    const res = await fetch(BASE + path)
    await res.arrayBuffer()
    return { ms: performance.now() - t0, status: res.status }
  } catch {
    return { ms: performance.now() - t0, status: 0 }
  }
}

// Discover a real poem publicId so the probe survives a re-ingest.
async function discoverPoemId() {
  try {
    const res = await fetch(`${BASE}/api/poems?limit=1`)
    const body = await res.json()
    return body?.items?.[0]?.id ?? null
  } catch {
    return null
  }
}

function buildMix(poemId) {
  const mix = [
    { w: 18, name: "meta", path: () => "/api/meta" },
    { w: 10, name: "stats", path: () => "/api/stats" },
    { w: 14, name: "facets", path: () => "/api/facets" },
    { w: 16, name: "browse", path: () => `/api/poems?p=${1 + ((Math.random() * 20) | 0)}` },
    { w: 12, name: "search", path: () => `/api/search?q=${encodeURIComponent(pick(["حب", "الليل", "قلب", "دمشق", "الصبر"]))}` },
    // deep / expensive corpus paths
    { w: 8, name: "baits-deep", path: () => `/api/baits?p=${2000 + ((Math.random() * 6000) | 0)}` },
    { w: 8, name: "baits-bait", path: () => `/api/baits?rhyme=${encodeURIComponent("ب")}&p=${1 + ((Math.random() * 30) | 0)}` },
    { w: 6, name: "train", path: () => `/api/train/candidates?letter=${encodeURIComponent(pick(["ب", "م", "ل", "ن", "ر"]))}&tier=${pick(["saif", "fahl", "shaer"])}` },
  ]
  if (poemId) mix.push({ w: 10, name: "poem", path: () => `/api/poems/${poemId}` })
  const total = mix.reduce((a, r) => a + r.w, 0)
  return { mix, total }
}

function pct(sorted, p) {
  if (!sorted.length) return NaN
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

async function runLevel(N, { mix, total }) {
  const deadline = performance.now() + DURATION_MS
  const perRoute = new Map()
  let count = 0, errors = 0, sheds = 0
  const pickRoute = () => {
    let r = Math.random() * total
    for (const m of mix) if ((r -= m.w) <= 0) return m
    return mix[0]
  }
  const record = (name, r) => {
    if (!perRoute.has(name)) perRoute.set(name, [])
    perRoute.get(name).push(r.ms)
    count++
    if (r.status === 503) sheds++
    else if (r.status === 0 || r.status >= 500) errors++
  }
  async function worker() {
    while (performance.now() < deadline) {
      const m = pickRoute()
      record(m.name, await timed(m.path()))
    }
  }
  const healthz = []
  let healthzShed = 0
  async function prober() {
    while (performance.now() < deadline) {
      const r = await timed("/healthz")
      healthz.push(r.ms)
      if (r.status === 503) healthzShed++
      await new Promise((res) => setTimeout(res, 25))
    }
  }
  await Promise.all([...Array.from({ length: N }, worker), prober()])

  const allMs = [...perRoute.values()].flat().sort((a, b) => a - b)
  const hz = healthz.sort((a, b) => a - b)
  return {
    N, count, rps: Math.round(count / (DURATION_MS / 1000)), errors, sheds,
    all: { p50: pct(allMs, 50), p95: pct(allMs, 95), max: allMs[allMs.length - 1] },
    healthz: { n: hz.length, p50: pct(hz, 50), p95: pct(hz, 95), max: hz[hz.length - 1], shed: healthzShed },
    perRoute: Object.fromEntries([...perRoute.entries()].map(([k, v]) => {
      const s = v.sort((a, b) => a - b)
      return [k, { n: s.length, p50: +pct(s, 50).toFixed(1), p95: +pct(s, 95).toFixed(1), max: +s[s.length - 1].toFixed(1) }]
    })),
  }
}

const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—")
const poemId = await discoverPoemId()
const mix = buildMix(poemId)
console.log(`base=${BASE} dur=${DURATION_MS}ms levels=${LEVELS.join(",")} poem=${poemId ?? "(none)"} budget=${BUDGET_MS}ms\n`)
console.log("conc |   rps | reqs | errs | 503 || ALL p50/p95/max ms || HEALTHZ p50/p95/max ms (n, shed) | budget")
console.log("-----|-------|------|------|-----||----------------------||-----------------------------------------------")
const results = []
for (const N of LEVELS) {
  await new Promise((r) => setTimeout(r, 300))
  const res = await runLevel(N, mix)
  results.push(res)
  const over = res.healthz.p95 > BUDGET_MS || res.healthz.max > BUDGET_MS
  console.log(
    `${String(N).padStart(4)} | ${String(res.rps).padStart(5)} | ${String(res.count).padStart(4)} | ${String(res.errors).padStart(4)} | ${String(res.sheds).padStart(3)} || ` +
      `${f(res.all.p50).padStart(6)}/${f(res.all.p95).padStart(6)}/${f(res.all.max).padStart(7)} || ` +
      `${f(res.healthz.p50).padStart(6)}/${f(res.healthz.p95).padStart(6)}/${f(res.healthz.max).padStart(7)}  (n=${res.healthz.n}, shed=${res.healthz.shed})  ${over ? "OVER" : "ok"}`,
  )
}
console.log("\n=== per-route detail (p50/p95/max ms) ===")
for (const res of results) {
  console.log(`\n-- concurrency ${res.N} --`)
  for (const [k, v] of Object.entries(res.perRoute)) {
    console.log(`  ${k.padEnd(12)} n=${String(v.n).padStart(4)}  ${String(v.p50).padStart(7)} / ${String(v.p95).padStart(7)} / ${String(v.max).padStart(7)}`)
  }
}
