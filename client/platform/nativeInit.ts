/**
 * One-time native shell bootstrap (docs/roadmap-mobile.md §M1). Called once from
 * App boot; a complete no-op on the web. Everything here is best-effort and
 * dynamically imported, so a missing plugin never keeps the app from starting.
 *
 * What it wires:
 *  • the status bar and the Android navigation bar, inked to the app's ink
 *    (#07080c) with light glyphs — the app is dark, always;
 *  • the hardware BACK button → router back, and a press with no history exits;
 *  • the splash screen hidden once the first paint has settled;
 *  • DEEP LINKS: an `https://qarid.avicenna.space/#/room/<code>` intent arrives
 *    as an `appUrlOpen` event carrying the full URL — its `#/…` fragment is
 *    copied onto our own location so the hash router lands on the room.
 */

import { API_BASE, isNative, loadToken } from "./native.ts"

/** #07080c — the app's ink, matching the web `--ink` and the PWA theme color. */
const INK = "#07080c"

/** Hydrate the bearer, then arm every native integration. Awaits the token. */
export async function nativeBoot(): Promise<void> {
  if (!isNative) return
  // The token must be in memory before the first /auth/me decides who is signed
  // in — everything else can arm in the background.
  await loadToken()
  void armStatusBar()
  void armBackButton()
  void armDeepLinks()
  void hideSplash()
}

async function armStatusBar(): Promise<void> {
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar")
    await StatusBar.setStyle({ style: Style.Dark })
    await StatusBar.setBackgroundColor({ color: INK })
    await StatusBar.setOverlaysWebView({ overlay: false })
  } catch {
    /* iOS has no settable nav bar; a browser has neither — ignore */
  }
}

async function armBackButton(): Promise<void> {
  try {
    const { App } = await import("@capacitor/app")
    await App.addListener("backButton", ({ canGoBack }) => {
      // Hardware back is the router's back everywhere there is somewhere to go;
      // at the root it minimises the app rather than trapping the reader.
      if (canGoBack || window.history.length > 1) window.history.back()
      else void App.exitApp()
    })
  } catch {
    /* not native — the browser's own back button is untouched */
  }
}

async function armDeepLinks(): Promise<void> {
  try {
    const { App } = await import("@capacitor/app")
    // A cold launch from a link arrives here too (getLaunchUrl), and every
    // subsequent tap arrives as appUrlOpen.
    const launch = await App.getLaunchUrl()
    if (launch?.url) applyDeepLink(launch.url)
    await App.addListener("appUrlOpen", ({ url }) => applyDeepLink(url))
  } catch {
    /* best effort */
  }
}

/** The deployment host a deep link is allowed to name (plus the prod host). */
function expectedHost(): string {
  return API_BASE ? new URL(API_BASE).host : "qarid.avicenna.space"
}

/**
 * The local `#/…` hash an incoming deep link maps to, or null when the URL is
 * not one we honour. Pure, so it is unit-tested directly: only a `#/…` fragment
 * on a host we recognise is accepted, so a stray intent cannot drive the router
 * anywhere the reader could not already type.
 */
export function deepLinkHash(rawUrl: string, host: string = expectedHost()): string | null {
  let hash: string
  try {
    const u = new URL(rawUrl)
    if (u.host && u.host !== host && u.host !== "qarid.avicenna.space") return null
    hash = u.hash
  } catch {
    return null
  }
  return hash.startsWith("#/") ? hash : null
}

/**
 * Turn an incoming `https://qarid.avicenna.space/#/room/BADIRU?k=…` into a local
 * navigation by copying its fragment onto our own location (fires hashchange →
 * the router applies it).
 */
export function applyDeepLink(rawUrl: string): void {
  const hash = deepLinkHash(rawUrl)
  if (!hash || window.location.hash === hash) return
  window.location.hash = hash
}

async function hideSplash(): Promise<void> {
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen")
    await SplashScreen.hide()
  } catch {
    /* auto-hide covers it if the plugin is not present */
  }
}
