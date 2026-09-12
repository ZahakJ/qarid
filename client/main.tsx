/**
 * Entry point. Fonts first (per-subset @fontsource imports — design-ux.md §7:
 * Arabic subsets only for the Arabic faces, Latin only for the mono numerals,
 * ~510 KB total), then tokens → base → components → bayt → views → poets →
 * app → duel → duel-teach → training → palette → auth → room → anthology →
 * qafiya → buhur → reader → chrome → sheet → phone → motion, in that cascade
 * order.
 *
 * `qafiya.css` and `buhur.css` are the two surfaces built for a reader who is
 * WRITING rather than browsing — باحث القافية and صفحة البحور. They sit with
 * the other late view sheets and are held to
 * `diwan.css` is الدواوين — «دواويني», one ديوان, and the four modal surfaces
 * that make and edit them. It sits with them and is held to the same rule.
 *
 * anthology.css's rule — every selector LEADS with one of their own new
 * `.qaf-*` / `.buhur-*` classes — because both of them decorate components
 * earlier sheets own (the 28-cell letter well, the chips, `BaytPlate`) and a
 * bare `.letter-well` here is the trap that shipped once already.
 *
 * `reader.css` is وضع القراءة, and it sits with the other late sheets for the
 * same reason: it narrows a `.bayt-row` that bayt.css already set, so it must
 * win — and every one of its selectors leads with a `.reader*` class of its own
 * (or with the `body[data-immersive="read"]` App.tsx writes), which is what
 * keeps it off every بيت outside a reading.
 *
 * The three before motion are the PHONE, in the order they were built:
 * `chrome.css` is the two bars and «المزيد», `sheet.css` is the bottom-sheet
 * primitive every phone dialog becomes, `phone.css` is the screen patterns —
 * the docked game screen, the full-screen search, the touch floor. They sit
 * here because they must win over every view sheet above them, and each one
 * either scopes its rules under `body[data-chrome="native"]` or names only its
 * own new classes — which is both why desktop is untouched and how they stay
 * clear of the `.letter-well` trap.
 *
 * `motion.css` is LAST on purpose: it carries the app-wide micro-interactions
 * (v2.md §6), and a transition declared there has to win over the same property
 * in the view or component sheet without either of them being edited.
 *
 * The CSP allows `font-src 'self' data:` because vite inlines the small
 * subsets as data: URIs (CLAUDE.md invariant).
 */

// verse — Amiri
import "@fontsource/amiri/arabic-400.css"
import "@fontsource/amiri/arabic-700.css"
// display — Aref Ruqaa (wordmark, poet headers, summary headlines ONLY)
import "@fontsource/aref-ruqaa/arabic-400.css"
// UI — IBM Plex Sans Arabic
import "@fontsource/ibm-plex-sans-arabic/arabic-400.css"
import "@fontsource/ibm-plex-sans-arabic/arabic-500.css"
import "@fontsource/ibm-plex-sans-arabic/arabic-600.css"
import "@fontsource/ibm-plex-sans-arabic/latin-400.css"
import "@fontsource/ibm-plex-sans-arabic/latin-500.css"
// numerals, timers, tabular-nums — IBM Plex Mono
import "@fontsource/ibm-plex-mono/latin-400.css"
import "@fontsource/ibm-plex-mono/latin-500.css"

import "./styles/tokens.css"
import "./styles/base.css"
import "./styles/components.css"
import "./styles/bayt.css"
import "./styles/views.css"
import "./styles/poets.css"
import "./styles/app.css"
import "./styles/duel.css"
import "./styles/duel-teach.css"
import "./styles/training.css"
import "./styles/palette.css"
import "./styles/auth.css"
import "./styles/room.css"
import "./styles/anthology.css"
import "./styles/qafiya.css"
import "./styles/buhur.css"
import "./styles/diwan.css"
import "./styles/reader.css"
import "./styles/chrome.css"
import "./styles/sheet.css"
import "./styles/phone.css"
import "./styles/motion.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { registerServiceWorker } from "./sw/register.ts"

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PWA (docs/roadmap-mobile.md §M0). Guarded: production only, and a no-op if
// the worker cannot register. The web app never depends on it.
registerServiceWorker()
