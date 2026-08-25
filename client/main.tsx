/**
 * Entry point. Fonts first (per-subset @fontsource imports — design-ux.md §7:
 * Arabic subsets only for the Arabic faces, Latin only for the mono numerals,
 * ~510 KB total), then tokens → base → components → bayt → views → poets →
 * app → duel → duel-teach → training → palette → auth → room → motion, in that
 * cascade order.
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
