/// <reference types="vitest/config" />
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build as esbuild } from "esbuild"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { precacheVersion } from "./client/sw/swRoutes.ts"

// Dev API server sits on 5750 (prod runs on 8010 so the live site keeps
// serving while you develop). Vite dev 5751, preview 6750 — family scheme.
const API = "http://127.0.0.1:5750"

// The «عن قريض» row in #/more says which build it is. Read the number from the
// package rather than writing it a second time in a TS file: two copies of a
// version is one copy that goes stale. Declared for TS in client/globals.d.ts.
const APP_VERSION: string = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
).version

export default defineConfig({
  root: "client",
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react(), dropWoffFallbacks(), pwaServiceWorker()],
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

/**
 * The hand-rolled PWA service worker (docs/roadmap-mobile.md §M0), NO workbox.
 *
 * The worker source is `client/sw/sw.ts`. It runs in a worker global, so it is
 * excluded from the app's tsconfig and bundled HERE on its own with esbuild —
 * that also lets it `import` the unit-tested `swRoutes.ts` (one source of truth)
 * while the precache manifest and the cache version are injected as `define`s.
 *
 * The version is a hash of the built asset URLs, whose filenames already carry
 * vite's content hash — so any change to any shipped byte moves the version and
 * `activate` drops the previous cache cleanly. It runs in `generateBundle`,
 * where every emitted asset's final `fileName` is known, and emits `sw.js` into
 * the same `dist/` root as `index.html` so its scope is the whole app. The
 * public files it also precaches (`offline.html`, the manifest, the icons) are
 * copied verbatim by vite from `client/public/`.
 */
function pwaServiceWorker(): Plugin {
  // Precached alongside the hashed bundle — copied from client/public, so their
  // names are stable and listed by hand. `/` and `/index.html` are the shell.
  const STATIC_PRECACHE = [
    "/",
    "/index.html",
    "/offline.html",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-192-maskable.png",
    "/icons/icon-512-maskable.png",
  ]
  const swEntry = fileURLToPath(new URL("./client/sw/sw.ts", import.meta.url))

  return {
    name: "qarid:pwa",
    apply: "build",
    async generateBundle(_options, bundle) {
      // Every emitted JS / CSS / woff2 — the shell's built assets and fonts.
      const assetUrls = Object.keys(bundle)
        .filter((f) => /\.(js|css|woff2)$/.test(f))
        .map((f) => "/" + f)

      // The version hashes the CONTENT-HASHED asset urls only: index.html and
      // the public files are not hashed-named, but index.html's content moves
      // its asset references, so this still flips on any real change.
      const version = precacheVersion(assetUrls)
      const precache = [...new Set([...STATIC_PRECACHE, ...assetUrls])].sort()

      const built = await esbuild({
        entryPoints: [swEntry],
        bundle: true,
        format: "iife",
        target: "es2020",
        minify: true,
        write: false,
        define: {
          __SW_VERSION__: JSON.stringify(version),
          __SW_PRECACHE__: JSON.stringify(precache),
        },
      })

      this.emitFile({ type: "asset", fileName: "sw.js", source: built.outputFiles[0]!.text })
    },
  }
}
