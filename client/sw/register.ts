/**
 * Register the قريض service worker (docs/roadmap-mobile.md §M0).
 *
 * A no-op in dev: `sw.js` is emitted only by the production build (the
 * `qarid:pwa` vite plugin), and vite's dev server has no such file — registering
 * it would 404 and, worse, a stale worker could shadow HMR. `import.meta.env.PROD`
 * is the guard. It is also a no-op where the browser has no SW support, and any
 * registration failure is swallowed: the app must work exactly the same whether
 * or not the worker installs (zero risk to the web app).
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* offline-first is a bonus, never a requirement */
    })
  })
}
