/**
 * The «install» affordance (docs/roadmap-mobile.md §M0).
 *
 * On Android/desktop Chromium the browser fires `beforeinstallprompt`; we catch
 * it, suppress the generic mini-infobar, and offer an on-theme «ثبِّت التطبيق»
 * button that triggers the real prompt. On iOS Safari there is no such event —
 * the only way in is Share → «أضف إلى الشاشة الرئيسية» — so we show a hint button
 * that explains that, with the iOS share glyph.
 *
 * It renders nothing when the app is already installed (running standalone), and
 * nothing on a platform that is neither installable nor iOS — a dead control is
 * worse than no control (same rule as the account door).
 */
import { useEffect, useRef, useState } from "react"

/** The non-standard event Chromium fires; typed locally (not in lib.dom). */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false
  const mm = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches
  // iOS Safari's own flag
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true
  return mm || iosStandalone
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

/** iOS share-sheet glyph — inline SVG, never a font glyph. */
function ShareGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m8.5 6.5 3.5-3.5 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 10.5H5.5A1.5 1.5 0 0 0 4 12v6.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** The install glyph — a nib dropping into a tray. */
function InstallGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m8 9.5 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 16.5v2A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function InstallControl() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandalone)
  const [iosOpen, setIosOpen] = useState(false)
  const ios = useRef(isIos()).current
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setPrompt(e as InstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setPrompt(null)
      setIosOpen(false)
    }
    window.addEventListener("beforeinstallprompt", onPrompt)
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  // Close the iOS hint on an outside click or Escape.
  useEffect(() => {
    if (!iosOpen) return
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setIosOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIosOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [iosOpen])

  if (installed) return null

  // Android / desktop: the real prompt is available.
  if (prompt) {
    return (
      <button
        type="button"
        className="masthead__install"
        aria-label="ثبِّت قريض على جهازك"
        onClick={async () => {
          await prompt.prompt()
          await prompt.userChoice.catch(() => undefined)
          setPrompt(null)
        }}
      >
        <InstallGlyph />
        <span className="masthead__install-label">ثبِّت التطبيق</span>
      </button>
    )
  }

  // iOS Safari: no prompt event — explain the Share → Add-to-Home-Screen path.
  if (ios) {
    return (
      <div className="masthead__install-wrap" ref={wrap}>
        <button
          type="button"
          className="masthead__install"
          aria-expanded={iosOpen}
          aria-label="كيف تُثبّت قريض على الآيفون"
          onClick={() => setIosOpen((v) => !v)}
        >
          <InstallGlyph />
          <span className="masthead__install-label">ثبِّت التطبيق</span>
        </button>
        {iosOpen ? (
          <div className="install-hint" role="dialog" aria-label="التثبيت على الآيفون">
            <p className="install-hint__title">أضف قريض إلى الشاشة الرئيسية</p>
            <p className="install-hint__body">
              في متصفّح سفاري، المس زرّ المشاركة <span className="install-hint__glyph"><ShareGlyph /></span> ثم اختر «أضف إلى
              الشاشة الرئيسية».
            </p>
          </div>
        ) : null}
      </div>
    )
  }

  return null
}
