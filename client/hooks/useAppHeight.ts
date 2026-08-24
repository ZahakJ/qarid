/**
 * `--app-height`: the real usable height on a phone, where 100dvh still lies
 * during a keyboard animation. Written onto the document element so CSS can
 * use it without any component subscribing.
 *
 * Everything falls back to `100dvh` when `visualViewport` is missing, which is
 * why nothing in the stylesheets depends on this hook having run.
 */
import { useEffect } from "react"

export function useAppHeight(): void {
  useEffect(() => {
    if (typeof window === "undefined") return
    const vv = window.visualViewport
    const apply = () => {
      const h = vv?.height ?? window.innerHeight
      document.documentElement.style.setProperty("--app-height", `${Math.round(h)}px`)
    }
    apply()
    vv?.addEventListener("resize", apply)
    window.addEventListener("resize", apply)
    window.addEventListener("orientationchange", apply)
    return () => {
      vv?.removeEventListener("resize", apply)
      window.removeEventListener("resize", apply)
      window.removeEventListener("orientationchange", apply)
    }
  }, [])
}
