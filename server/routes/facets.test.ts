/**
 * The two properties `/api/facets` gained when its cache moved out of the route
 * closure and a boot-time pre-warm started filling it: the pre-warm must warm
 * exactly what the route reads, and it must not be able to take the boot down.
 *
 * The second half is a REAL boot — `node server/index.ts` with `DB_PATH`
 * pointing at nothing — because that is the only place the `if (db)` guard
 * exists. `PORT=0` so the test never touches a reserved port (5750 dev API /
 * 5751 vite / 6750 smoke / 8010 prod); the actual port is read back off the
 * server's own listening line, and the child PID is the only thing killed.
 */
import { spawn } from "node:child_process"
import path from "node:path"

import { describe, it, expect, beforeAll, afterAll } from "vitest"

import { FacetsResponseSchema } from "../../shared/schema.ts"
import { ensureFixtureDb, FIXTURE_DB, REPO_ROOT } from "../../test/fixtureDb.ts"
import { createApp } from "../app.ts"
import { loadConfig } from "../config.ts"
import { openDb, type Db } from "../db.ts"
import { slugMaps } from "../query.ts"
import { warmFacets } from "./facets.ts"

const config = loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test" } as NodeJS.ProcessEnv)

describe("warmFacets", () => {
  // Two INDEPENDENT handles on the same artefact: the caches key on the handle,
  // so `cold` is the control that has never been warmed.
  let warm: Db
  let cold: Db

  beforeAll(async () => {
    await ensureFixtureDb()
    warm = openDb(FIXTURE_DB)
    cold = openDb(FIXTURE_DB)
  })

  afterAll(() => {
    warm.close()
    cold.close()
  })

  it("warms exactly the single-facet combinations — one per عصر, بحر and غرض", async () => {
    const maps = slugMaps(warm)
    const expected = maps.eraName.size + maps.meterName.size + maps.themeName.size
    expect(expected).toBeGreaterThan(30) // the lookup tables are seeded in full
    expect(await warmFacets(warm)).toBe(expected)
  })

  it("yields to the event loop between combinations", async () => {
    // Every iteration awaits a setImmediate before it touches SQLite, so a
    // probe scheduled at call time must get its turn while the sweep is still
    // running. Without the yield the whole sweep would be one blocking turn and
    // the probe would only run after it finished.
    let finished = false
    const sweep = warmFacets(cold).then(() => {
      finished = true
    })
    const ranBeforeTheSweepFinished = await new Promise<boolean>((resolve) =>
      setImmediate(() => resolve(!finished)),
    )
    expect(ranBeforeTheSweepFinished).toBe(true)
    await sweep
  })

  it("hands the route the same answer it would have computed itself", async () => {
    await warmFacets(warm)
    const era = [...slugMaps(warm).eraName.values()][0]!.slug
    const meter = [...slugMaps(warm).meterName.values()][0]!.slug

    const warmed = createApp(config, warm).app
    const fresh = createApp(config, cold).app
    for (const q of [`era=${era}`, `meter=${meter}`, ""]) {
      const a = FacetsResponseSchema.parse(await (await warmed.request(`/api/facets?${q}`)).json())
      const b = FacetsResponseSchema.parse(await (await fresh.request(`/api/facets?${q}`)).json())
      expect(a, q).toEqual(b)
    }
  })
})

describe("booting with no corpus", () => {
  it("still listens, still serves /healthz, and answers /api/* with 503", async () => {
    const child = spawn("node", ["server/index.ts"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0", // ephemeral — never a reserved port
        DB_PATH: path.join(REPO_ROOT, "data", "__no-such-corpus__.sqlite"),
        NODE_ENV: "production",
      },
    })
    let log = ""
    child.stdout.on("data", (d: Buffer) => (log += d.toString()))
    child.stderr.on("data", (d: Buffer) => (log += d.toString()))

    try {
      const port = await new Promise<number>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`no listening line in 15s:\n${log}`)), 15000)
        const tick = setInterval(() => {
          const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(log)
          if (!m) return
          clearInterval(tick)
          clearTimeout(deadline)
          resolve(Number(m[1]))
        }, 50)
      })

      const origin = `http://127.0.0.1:${port}`
      expect(await (await fetch(`${origin}/healthz`)).text()).toBe("ok")
      const facets = await fetch(`${origin}/api/facets?era=abbasi`)
      expect(facets.status).toBe(503)
      expect(await facets.json()).toEqual({ error: "corpus_unavailable" })

      // The pre-warm is skipped, not attempted: nothing on stderr about it.
      expect(log).not.toContain("pre-warm")
      expect(child.exitCode).toBe(null) // still up
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGTERM")
        } catch {
          /* already gone */
        }
      }
    }
  }, 30000)
})
