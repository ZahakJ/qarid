/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"

// Dev API server sits on 5750 (prod runs on 8010 so the live site keeps
// serving while you develop). Vite dev 5751, preview 6750 — family scheme.
const API = "http://127.0.0.1:5750"

export default defineConfig({
  root: "client",
  plugins: [react(), dropWoffFallbacks()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5751,
    strictPort: true,
    proxy: {
      "/api": API,
      "/healthz": API,
      // v2.md §5's مساجلة socket. `ws: true` is the whole of it — without it
      // vite answers the upgrade itself (its own HMR socket owns `upgrade`)
      // and `#/room/<code>` silently falls back to the 2-second poller in dev
      // while working perfectly in production, which is the worst shape a bug
      // of this kind can have.
      "/ws": { target: API, ws: true },
    },
  },
  preview: { port: 6750, strictPort: true },
  test: {
    environment: "node",
    include: [
      "../server/**/*.test.ts",
      "../shared/**/*.test.ts",
      "../scripts/**/*.test.ts",
      "../client/**/*.test.ts",
      "../test/**/*.test.ts",
    ],
    // One real ingest per run: test/fixtureDb.ts builds data/fixture.db through
    // scripts/ingest/build.ts, which is the artefact every server test opens.
    globalSetup: ["../test/fixtureDb.ts"],
  },
})

/**
 * Drop the `.woff` fallbacks from the bundle — 445 KB nothing fetches.
 *
 * @fontsource ships every face twice, `src: url(…woff2) format('woff2'),
 * url(…woff) format('woff')`, and vite faithfully emitted both. No browser that
 * can run this app (ES2022 modules, `:has()`, container queries) lacks woff2 —
 * support has been universal since Edge 14 / Safari 10 — so the second half of
 * every `src` was dead weight in `dist/`, in the deploy, and on the wire budget.
 *
 * It is a `transform`, not a `generateBundle` filter, and `enforce: "pre"` is
 * load-bearing: the fallback has to be gone BEFORE `vite:css` reads the url()s,
 * because that is what decides which files become assets at all. Deleting the
 * emitted `.woff` in `generateBundle` also works, but by then the stylesheet's
 * content hash is already fixed — the CSS would ship rewritten under its OLD
 * hash, `immutable` for a year, and the name would no longer describe the bytes.
 * Here the woff is simply never referenced and never emitted, and the CSS hash
 * moves with its content the way every other asset's does.
 */
function dropWoffFallbacks(): Plugin {
  // `, url(<name>.woff) format('woff')` — the leading comma is required, so a
  // src list carrying woff ALONE is left untouched (fontsource ships none, but
  // a future dependency might, and a face with no src at all is a dead font).
  // `.woff2` cannot match: the `)` is anchored immediately after `.woff`.
  const FALLBACK = /\s*,\s*url\(\s*(['"]?)[^)'"]+\.woff\1\s*\)(\s*format\(\s*(['"])woff\3\s*\))?/g

  return {
    name: "qarid:drop-woff-fallbacks",
    enforce: "pre",
    apply: "build",
    transform(code, id) {
      if (!id.split("?")[0].endsWith(".css")) return null
      const out = code.replace(FALLBACK, "")
      return out === code ? null : { code: out, map: null }
    },
  }
}
