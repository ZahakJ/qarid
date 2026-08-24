/**
 * Entry point. Fonts first (per-subset @fontsource imports — design-ux.md §7:
 * Arabic subsets only for the Arabic faces, Latin only for the mono numerals,
 * ~510 KB total), then tokens → base → components → bayt → views →
 * app → duel → training, in that cascade order.
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
import "./styles/app.css"
import "./styles/duel.css"
import "./styles/training.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
