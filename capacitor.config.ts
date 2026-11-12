/// <reference types="@capacitor/cli" />
/**
 * Capacitor configuration for the قريض Android app (docs/roadmap-mobile.md §M1).
 *
 * The app ships the BUILT web shell as bundled assets (`webDir: "dist"`), so it
 * starts offline-fast from the same bundle the site serves. It is served to the
 * WebView from `https://localhost` (`androidScheme: "https"`) — an origin the
 * server's CORS allowlist recognises (server/origin.ts) — and there is NO
 * `server.url`, so the WebView never points at a remote page; the API base
 * (`https://qarid.example.com`) is baked into the web build via
 * `VITE_API_BASE`, and the shell authenticates with a bearer token, not cookies
 * (client/platform/native.ts).
 *
 * The whole app is dark: the splash and the status/navigation bars are inked to
 * `--ink` (#07080c) with a gold nib, matching the PWA theme color.
 */
import type { CapacitorConfig } from "@capacitor/cli"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The package id: QARID_APP_ID, else android/identity.properties'
 * `applicationId` (the file Gradle reads), else the `com.example.qarid`
 * placeholder a public checkout carries. Reading the same file as Gradle keeps
 * the two equal without remembering to export anything; a release built under
 * the placeholder is refused by tools/android-identity.ts and by build.gradle.
 */
function appId(): string {
  let fromFile: string | undefined
  try {
    const text = readFileSync(join(__dirname, "android", "identity.properties"), "utf8")
    fromFile = /^\s*applicationId\s*[=:]\s*(\S+)\s*$/m.exec(text)?.[1]
  } catch {
    // No identity file: a debug/dev checkout.
  }
  const fromEnv = process.env.QARID_APP_ID || undefined
  if (fromEnv && fromFile && fromEnv !== fromFile) {
    throw new Error(`QARID_APP_ID (${fromEnv}) differs from android/identity.properties applicationId (${fromFile})`)
  }
  return fromEnv ?? fromFile ?? "com.example.qarid"
}

const config: CapacitorConfig = {
  // Must equal Gradle's applicationId, or Capacitor's generated plugin glue
  // points at the wrong one. See appId() above.
  appId: appId(),
  appName: "قريض",
  // QARID_WEB_DIR lets the app bundle sync from its own build, so a release
  // build never replaces the dist/ a running server is serving.
  webDir: process.env.QARID_WEB_DIR ?? "dist",
  android: {
    // Release loads only its bundled assets and the https API — no cleartext.
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
  },
  backgroundColor: "#07080c",
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#07080c",
      androidSplashResourceName: "splash",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    // Capacitor 8's built-in edge-to-edge handler. `insetsHandling: "css"`
    // (the default, stated here for the record) is what injects the real bar
    // heights as `--safe-area-inset-*` on API 35+, which app.css's masthead
    // and footer consume. `style: "DARK"` keeps the bar glyphs light on the
    // ink background regardless of the device's day/night setting.
    SystemBars: {
      style: "DARK",
      insetsHandling: "css",
    },
    // Legacy @capacitor/status-bar. Its setStyle (glyph colour) still works on
    // API 35; overlaysWebView / backgroundColor are dead there (the OS forces
    // edge-to-edge) but harmless, and still apply on API < 35.
    StatusBar: {
      style: "DARK",
      backgroundColor: "#07080c",
      overlaysWebView: false,
    },
  },
}

export default config
