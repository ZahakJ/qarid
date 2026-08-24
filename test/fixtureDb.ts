/**
 * `test/fixtureDb.ts` — the ONE way a test gets a قريض database.
 *
 * It builds `data/fixture.db` from `test/fixtures/ashaar-sample.jsonl` through
 * the REAL `scripts/ingest/build.ts`, exactly as `npm run ingest:fixture` does.
 * design-server.md §6 is explicit about this: a bespoke test-only builder would
 * let an ingest bug that only bites on the corpus hide behind a green suite.
 *
 * Vitest calls `setup()` once per run (`test.globalSetup` in vite.config.ts), so
 * `server/app.test.ts`, `server/search.test.ts`, `server/game.test.ts` and
 * `test/build.test.ts` all share one artefact and none of them pays to build it.
 *
 * `builtAt` and `sourceRevision` are PINNED here: amendment 17 wants two builds
 * of the same input to be identical, and a wall-clock timestamp in `meta` would
 * be the one thing that never is.
 */

import fs from "node:fs"
import path from "node:path"

import { buildDatabase, type BuildReport } from "../scripts/ingest/build.ts"
import { SOURCE_REVISION } from "../shared/constants.ts"

export const REPO_ROOT = path.resolve(import.meta.dirname, "..")
export const FIXTURE_SRC = path.join(REPO_ROOT, "test", "fixtures", "ashaar-sample.jsonl")
export const FIXTURE_DB = path.join(REPO_ROOT, "data", "fixture.db")

/** Pinned so `meta.built_at` is reproducible; see amendment 17. */
export const FIXTURE_BUILT_AT = "2026-01-01T00:00:00.000Z"
export const FIXTURE_REVISION = `fixture@${SOURCE_REVISION.slice(0, 7)}`

/** Build the fixture artefact at `out` (default `data/fixture.db`). */
export async function buildFixtureDb(out: string = FIXTURE_DB): Promise<BuildReport> {
  return buildDatabase({
    sources: [FIXTURE_SRC],
    out,
    sourceRevision: FIXTURE_REVISION,
    builtAt: FIXTURE_BUILT_AT,
    log: false,
  })
}

/**
 * Build it only if it is missing or older than its inputs — what an individual
 * test file calls when it is run on its own, outside `globalSetup`.
 */
export async function ensureFixtureDb(out: string = FIXTURE_DB): Promise<string> {
  if (fs.existsSync(out)) {
    const built = fs.statSync(out).mtimeMs
    // Every file that can change the SHAPE of the artefact, not just build.ts:
    // a retuned tier in ddl.ts or a stricter predicate in transform.ts leaves a
    // stale fixture that answers yesterday's questions.
    const inputs = [
      FIXTURE_SRC,
      ...["build.ts", "ddl.ts", "transform.ts", "readers.ts"].map((f) => path.join(REPO_ROOT, "scripts", "ingest", f)),
      // …and the shared tables the ingest derives columns from: `arabic.ts`
      // owns `poets.letter`/`sort_key` and `poetAliases.ts` owns `name_key`.
      ...["arabic.ts", "poetAliases.ts", "famousPoets.ts"].map((f) => path.join(REPO_ROOT, "shared", f)),
    ]
    const newest = Math.max(...inputs.map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)))
    if (built >= newest) return out
  }
  await buildFixtureDb(out)
  return out
}

/** vitest `globalSetup` — one build for the whole run. */
export async function setup(): Promise<void> {
  await buildFixtureDb()
}

export default setup
