/// <reference types="@capacitor/cli" />
/**
 * Capacitor configuration for the قريض Android app (docs/roadmap-mobile.md §M1).
 *
 * The app ships the BUILT web shell as bundled assets (`webDir: "dist"`), so it
 * starts offline-fast from the same bundle the site serves. It is served to the
 * WebView from `https://localhost` (`androidScheme: "https"`) — an origin the
 * server's CORS allowlist recognises (server/origin.ts) — and there is NO
 * `server.url`, so the WebView never points at a remote page; the API base
 * (`https://qarid.avicenna.space`) is baked into the web build via
 * `VITE_API_BASE`, and the shell authenticates with a bearer token, not cookies
 * (client/platform/native.ts).
 *
 * The whole app is dark: the splash and the status/navigation bars are inked to
 * `--ink` (#07080c) with a gold nib, matching the PWA theme color.
 */
import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "space.avicenna.qarid",
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
    StatusBar: {
      style: "DARK",
      backgroundColor: "#07080c",
      overlaysWebView: false,
    },
  },
}

export default config
