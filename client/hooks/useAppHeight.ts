/**
 * What the viewport ACTUALLY is on a phone, written onto the document element
 * so CSS can use it without any component subscribing.
 *
 *   --app-height  the usable height, where `100dvh` still lies mid-keyboard
 *   --kb-inset    how much of the LAYOUT viewport the keyboard is covering
 *
 * The two are needed because the platforms disagree about what a keyboard does.
 * Chrome on Android (and the Capacitor WebView, which is Chrome) RESIZES the
 * layout viewport, so `window.innerHeight` shrinks with the keyboard and
 * `--kb-inset` stays at 0 — a bottom-docked composer rides up on its own. iOS
 * Safari does not resize anything: `innerHeight` is unchanged and only
 * `visualViewport.height` drops, so a `position: fixed` bottom edge stays UNDER
 * the keyboard unless something lifts it, and `--kb-inset` is that something.
 *
 * Everything falls back to `100dvh` / `0px` when `visualViewport` is missing,
 * which is why no stylesheet depends on this hook having run.
 */
import { useEffect } from "react"

export function useAppHeight(): void {
  useEffect(() => {
    if (typeof window === "undefined") return
    const vv = window.visualViewport
    const apply = () => {
      const h = vv?.height ?? window.innerHeight
      const root = document.documentElement
      root.style.setProperty("--app-height", `${Math.round(h)}px`)
      // Only the part of the layout viewport the keyboard actually covers.
      // `offsetTop` is what the visual viewport has been scrolled by inside the
      // layout one, so subtracting it is what keeps a pinch-zoomed page from
      // reporting a keyboard that is not there.
      const covered = vv ? window.innerHeight - vv.height - vv.offsetTop : 0
      root.style.setProperty("--kb-inset", `${Math.max(0, Math.round(covered))}px`)
    }
    apply()
    vv?.addEventListener("resize", apply)
    vv?.addEventListener("scroll", apply)
    window.addEventListener("resize", apply)
    window.addEventListener("orientationchange", apply)
    return () => {
      vv?.removeEventListener("resize", apply)
      vv?.removeEventListener("scroll", apply)
      window.removeEventListener("resize", apply)
      window.removeEventListener("orientationchange", apply)
    }
  }, [])
}
