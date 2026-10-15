# Mobile

The phone build: a PWA first, then an Android app from the same source.

## M0 — PWA

- `manifest.webmanifest` (name قريض, `dir` rtl, `lang` ar, theme #07080c, gold
  nib maskable icons 192/512).
- A hand-rolled service worker (no workbox), versioned by build hash: precaches
  the shell, fonts and built assets; the API is network-first with an offline
  page («لا اتصال — والديوان لا يُقرأ إلا موصولًا»). Favorites still render
  offline because they are denormalized in localStorage.
- An install affordance for Android and iOS browsers.

## M1 — Android via Capacitor

Needs an Android SDK (build-tools, platforms, cmdline-tools, NDK), JDK 21, and
a release keystore outside the repository.

- Bundled web assets (fast start, offline shell); the API base is
  `VITE_API_BASE`, baked in at build time.
- **Auth.** WebView cookies are unreliable cross-origin, so the server issues
  optional bearer-token sessions (`Authorization: Bearer <token>`, same sessions
  table) when the client asks at login; the web keeps cookies. CORS allows the
  Capacitor origins on `/api` and the WebSocket.
- **Bearer-token rules.** Tokens expire and roll like cookie sessions; a
  password change revokes all of a user's tokens; tokens never appear in logs,
  URLs or error messages; issuance only over an https origin or localhost, and
  rate-limited. Each rule has a unit test.
- Native touches: share sheet (cards and the daily text), haptics on duel
  events, status and navigation bars inked to the theme, hardware back = router
  back, splash and icon (gold nib on ink), keep-awake during a duel turn, and
  App Links for `/#/room/<code>` (`/.well-known/assetlinks.json` served by Hono).
- The APK is checked on an emulator over adb: install, cold start, offline start, login, a duel turn, a room join by deep
  link, the share sheet, and hardware back at every depth.
- The APK is built locally; no CI workflow builds it.

## M1.5 — native feel

Desktop rendering is unchanged.

**The chrome.** Below 861px on a coarse pointer, a 52px app bar and a fixed
five-tab bottom bar replace the masthead and the footer; `#/more` carries what
the bar has no room for, and a tab root remembers its scroll position. One
signal (`body[data-chrome="native"]`), one table (`client/chrome.ts`).

**The screens.** (a) A مساجلة in play is a game screen: no tab bar, a slim
HUD, the composer docked at the thumb, the transcript scrolling above it, and
back asking «انسحب؟». (b) Every phone dialog is a bottom sheet from one
primitive. (c) البحث is a full screen with its field focused. (d) A 44px touch
floor, the بيت's action rail moved under the verse, no tap flash, no
rubber-band, no selecting the chrome; verse stays selectable.

Details and invariants: `docs/internals.md`, "The PHONE's SCREEN PATTERNS" and
§Invariants.

## Later

iOS, push notifications for room invites.
