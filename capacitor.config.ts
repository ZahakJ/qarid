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

const config: CapacitorConfig = {
  // Overridden per build by QARID_APP_ID (see android/identity.properties) so a
  // public checkout carries nobody's identity. Keep it equal to Gradle's
  // applicationId, or Capacitor's generated plugin glue points at the wrong one.
  appId: process.env.QARID_APP_ID ?? "com.example.qarid",
  appName: "قريض",
  webDir: "dist",
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
