/**
 * Register the قريض service worker (docs/roadmap-mobile.md §M0) — on the WEB,
 * and never inside the APK.
 *
 * The native exclusion is not tidiness, it is a bug that shipped. Capacitor
 * serves the bundled shell from `https://localhost` through Android's
 * `WebViewAssetLoader`, which intercepts at the WebViewClient layer — a service
 * worker's OWN `fetch()` does not go through it. So inside the app every
 * same-origin fetch the worker makes reaches the real network, where nothing is
 * listening, and `sw.ts`'s navigation strategy (network, then the cached shell)
 * therefore ALWAYS lands on the shell it precached the first time the app ran.
 * The UI freezes at that first install and no APK update can dislodge it: the
 * update's own `index.html` is never the document that gets served. Cross-origin
 * `/api/*` is `bypass`, so the corpus keeps answering and the app looks healthy
 * while being permanently one build behind — which is exactly how it presented.
 *
 * The APK needs none of what the worker buys, either: its assets are bundled in
 * the package, so it is already offline-first without a byte of cache.
 *
 * On the web it stays exactly as it was: production only, no-op where the
 * browser has none, and every failure swallowed — the app must work identically
 * with or without it.
 */

import { isNative } from "../platform/native.ts"

/**
 * The decision, separated from the doing so it can be tested: the worker is for
 * the web build of a production bundle, and nothing else.
 */
export function shouldRegisterServiceWorker(opts: {
  prod: boolean
  native: boolean
  supported: boolean
}): boolean {
  return opts.prod && !opts.native && opts.supported
}

/**
 * Tear down a worker that should never have been registered here.
 *
 * Belt and braces for a native install that DOES manage to run this code — a
 * fresh install, or one whose data has been cleared. It cannot rescue an app
 * already pinned to a stale shell (that shell's JavaScript is what would have
 * to call this, and it predates it); those need the app's storage cleared once,
 * after which this keeps it from ever happening again.
 */
async function unregisterAll(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map((r) => r.unregister()))
    if (typeof caches !== "undefined") {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n.startsWith("qarid")).map((n) => caches.delete(n)))
    }
  } catch {
    /* nothing here is load-bearing */
  }
}

export function registerServiceWorker(): void {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator
  if (!supported) return

  if (isNative) {
    void unregisterAll()
    return
  }

  if (!shouldRegisterServiceWorker({ prod: import.meta.env.PROD, native: false, supported })) return

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* offline-first is a bonus, never a requirement */
    })
  })
}
