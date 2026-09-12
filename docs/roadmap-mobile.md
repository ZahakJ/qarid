# Roadmap: قريض mobile (post-v2) — PLANNED, awaiting owner sign-off

Goal: a native phone build — Android APK first — so the ديوان and the مساجلة travel off the desktop. Sequenced strictly after the v2 close-out (hardening, live verification, release).

## Phase M0 — PWA interim (same-day, ~1 agent)
- manifest.webmanifest (name قريض, dir rtl, lang ar, theme #07080c, gold nib maskable icons 192/512), service worker: precache shell + fonts + built assets (workbox-free, hand-rolled ~80 lines, versioned by build hash), API network-first with offline fallback page («لا اتصال — والديوان لا يُقرأ إلا موصولًا» + cached favorites still render since they're denormalized in localStorage).
- Install prompt affordance in settings/masthead for Android/iOS browsers. Zero risk to the web app; ships behind the same done bar.
- Result: friends can "install" from the browser immediately while the APK matures.

## Phase M1 — Android APK via Capacitor (the real deliverable)
Toolchain required: an Android SDK (build-tools, platforms, cmdline-tools, NDK) and a JDK 21, plus your own release keystore — generate one, keep it OUTSIDE the repo, and back it up.
- Capacitor app id com.example.qarid, bundled web assets (fast start, offline shell) with API base https://qarid.example.com.
- AUTH: WebView cookies are unreliable cross-origin → add optional bearer-token sessions server-side (Authorization: Bearer <token>, same sessions table, issued at login when client asks; cookies remain for web). CORS allowlist for capacitor origins on /api + WS.
- Native touches: share sheet (share cards + daily text via @capacitor/share), haptics on duel events (accept/reject/timeout), status-bar + nav-bar inked to theme, hardware back = router back, splash (gold nib on ink), app icon, keep-awake during a duel turn, deep links qarid.example.com/#/room/<code> open the app (assetlinks.json served by Hono).
- Build: gradle assembleRelease headless, signed APK; artifact attached to a GitHub Release on ZahakJ/qarid (private repo releases are shareable to invited collaborators; also just send the .apk file directly to siblings). Play Store deferred (needs $25 account + review — owner's call later).
- Verify: playwright can't drive the APK; use the SDK emulator (system-images present) + adb for a smoke (install, cold start, login, one duel turn, share sheet) driven by an agent through adb shell/screencap.

## Phase M2 (later, optional)
iOS (needs a Mac — not on this box), Play Store listing, push notifications for room invites (needs a push service — reassess).

Estimate: M0 ≈ 1 short agent run; M1 ≈ one focused evening (3–5 agents: server tokens/CORS → capacitor scaffold + native touches → emulator smoke + signed build + release upload).

## Phase M0.5 — the NATIVE FEEL pass (done, 2026-08-26)

Between the PWA and the APK: making the web app *behave* like an app, so the
Capacitor shell has something worth wrapping. Two passes, both verified by
reading every affected screen at 390 in a real phone context (`hasTouch` +
`isMobile`) and confirming the desktop pixel-identical at 1440 and 1024.

**Phase 1 — the chrome.** A 52px app bar and a fixed five-tab bottom bar replace
the masthead and the footer below 861px on a coarse pointer, `#/more` carries
what the bar has no room for, and a tab root remembers where you were reading.
One signal (`body[data-chrome="native"]`), one table (`client/chrome.ts`).

**Phase 2 — the screens.** (a) A مساجلة in play is a GAME SCREEN: no tab bar,
a slim HUD, the composer docked at the thumb, the transcript scrolling above it,
and back asking «انسحب؟». (b) Every phone dialog is a BOTTOM SHEET — «القيود»,
the قصيدة's reading controls («أأ» in the app bar), دخول, «غرفة مساجلة»,
البطاقة — from one primitive. (c) البحث is a full screen with its field already
focused. (d) A measured 44px touch floor, the بيت's action rail moved out of its
hover gutter and under the verse, and the small things that stop a page being a
page: no tap flash, no rubber-band, no selecting the chrome — while verse stays
selectable, because people copy poetry.

Details, traps and the invariants they produced: CLAUDE.md §The PHONE's SCREEN
PATTERNS and §Invariants.

## Decisions (2026-08-25, via the owner's delegated bridge session)
- GREEN-LIT: M0 + M1 both, sequenced strictly after the v2 chain lands clean. M1 (signed APK) is THE deliverable, not a nice-to-have.
- Distribution: GitHub-release + direct-share only. Promo-site APK download deferred until the promo site is public.
- Security bar for the bearer-token work (it is a security surface): tokens expire and roll like cookie sessions; ALL of a user's tokens are revoked on password change; tokens never appear in logs, URLs, or error messages (Authorization header only); token issuance only over https origin or localhost; rate-limited issuance; unit tests for every one of these.
- APK bar: adversarial verification on the SDK emulator (install, cold start, offline start, login incl. token expiry mid-session, a full duel turn, a multiplayer room join via deep link, share sheet, hardware back at every depth) before it is called done; unit tests wherever there is real logic.
- Milestone reporting: v2 landing, M0 live, M1 APK — each reported separately. Forks needing the owner (money, public exposure, deletion) get parked and surfaced.
- BUILD COST CONSTRAINT: the APK is built LOCALLY on this box only (SDK/JDK already here). No GitHub Actions / CI on the private repo — Actions minutes on private repos are metered. GitHub is only the shelf: the finished signed APK is uploaded as a release asset. No .github/workflows that run on push; if any workflow file is ever added, it ships disabled-by-default (workflow_dispatch only, or committed with `if: false`).
