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
 *  • DEEP LINKS: an `https://qarid.example.com/#/room/<code>` intent arrives
 *    as an `appUrlOpen` event carrying the full URL — its `#/…` fragment is
 *    copied onto our own location so the hash router lands on the room.
 */

import { askExit } from "../store/immersiveStore.ts"
import { exitReader } from "../store/readerStore.ts"
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
    // setStyle keeps the bar glyphs light on ink and still works on API 35.
    await StatusBar.setStyle({ style: Style.Dark })
    // setBackgroundColor / setOverlaysWebView are NO-OPS from Android 15 (API
    // 35): a targetSdk ≥ 35 app is forced edge-to-edge and the OS ignores the
    // deprecated status-bar colour and the fullscreen layout flags. They stay
    // for API < 35 (harmless there). The actual edge-to-edge inset on API 35+
    // is handled by Capacitor's SystemBars plugin injecting --safe-area-inset-*
    // (capacitor.config.ts), which app.css's masthead/footer pad for.
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
      // A قصيدة being READ takes the press first and simply closes the reading
      // (client/store/readerStore.ts) — no question, because leaving a قصيدة
      // costs nothing. A مساجلة in progress takes it next and turns it into
      // «انسحب؟» (client/store/immersiveStore.ts). Both report whether they
      // took it, so the rule below is unamended everywhere else.
      if (exitReader()) return
      if (askExit()) return
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
  // No API base means no site to be linked from — an empty host, and every
  // deep link is refused below, rather than a placeholder host that would
  // accept links to a domain nobody deploys to.
  return API_BASE ? new URL(API_BASE).host : ""
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
    if (!host || (u.host && u.host !== host)) return null
    hash = u.hash
  } catch {
    return null
  }
  return hash.startsWith("#/") ? hash : null
}

/**
 * Turn an incoming `https://qarid.example.com/#/room/BADIRU?k=…` into a local
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
