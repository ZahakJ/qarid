/**
 * The compact top app bar — what the masthead becomes on a phone.
 *
 * Two shapes, and which one you get is the same fact the tab bar reads
 * (`isTabRoot`), so the two bars can never disagree:
 *
 *  • On a TAB ROOT it is an identity bar: the screen's name small, in Aref
 *    Ruqaa, at the inline-start (right) edge, with the two things that are not
 *    navigation — ⌕ (which opens the palette, exactly as the masthead's does)
 *    and the account door — at the other.
 *  • On a SUB-SCREEN it is a navigation bar: a back chevron pointing RIGHT
 *    (back is toward the inline-start edge under RTL), the contextual title,
 *    and nothing else. Breadcrumbs are hidden on a phone; this replaces them,
 *    and «at most one action» here is none — every screen that has actions
 *    already carries them in its own toolbar, where they name themselves.
 *
 * The TITLE is `routeTitle` by default — «الشاعر», «القصيدة» — but a view that
 * knows something better says so through `useChromeTitle`, and then the bar
 * carries the شاعر's own name. That store is deliberately tiny and self-
 * clearing: a view sets it on mount and gives it back on unmount, so a stale
 * title can never outlive the screen that set it.
 *
 * A view may lend the bar ONE ACTION the same way (`useChromeAction`). That is
 * how the قصيدة's reading controls survive the loss of its toolbar: on a phone
 * «تشكيل / إظهار الرويّ / حجم الخط / نسخ القصيدة» is four controls across a
 * 358px page, so they move into the bar as a single «أأ» that opens a sheet.
 * One action, never two — a bar with a row of glyphs is a toolbar, and this app
 * already has one of those on every screen that needs it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { create } from "zustand"

import { goBack, isTabRoot } from "../chrome.ts"
import { routeHash, routeTitle, type Route } from "../router.ts"
import { useAuth } from "../store/authStore.ts"
import { askExit, useImmersiveActive } from "../store/immersiveStore.ts"
import { Avatar } from "./Avatar.tsx"
import { BackChevron } from "./ChromeIcons.tsx"
import { openPalette } from "./Palette.tsx"

type ChromeTitleState = { title: string | null; set: (t: string | null) => void }

const useChromeTitleStore = create<ChromeTitleState>()((set) => ({
  title: null,
  set: (title) => set({ title }),
}))

/**
 * Lend the app bar a better title than the route's own generic one, for as long
 * as this view is mounted. `null`/`undefined` while the page is still loading
 * simply leaves the route label standing.
 */
export function useChromeTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return
    useChromeTitleStore.getState().set(title)
    return () => useChromeTitleStore.getState().set(null)
  }, [title])
}

/**
 * The same lent title, for the DOCUMENT title — read by App.tsx.
 *
 * `routeTitle` can only name the route, so #/poet/<slug>, #/poem/<id> and
 * #/u/<name> — the three deep-linkable, shareable, bookmarkable routes — put
 * «الشاعر — قريض», «القصيدة — قريض» and «الحساب — قريض» in the tab. Four قصائد
 * open were four identical tabs, browser history was unusable, and a bookmark
 * said nothing. The view already knows the real name and already lends it to
 * the app bar; this is the same string reaching the other place a name belongs.
 * `routeTitle` stays the pre-load placeholder.
 */
export function useLentTitle(): string | null {
  return useChromeTitleStore((s) => s.title)
}

// ── the one lendable action ────────────────────────────────────────────────

/**
 * The «أأ» of a reading control — an Arabic type-size mark, not a Latin «Aa».
 * Two ألِفات at two sizes on one baseline is the gesture every Arabic reader
 * already knows from a ديوان app's font control.
 */
function TypeGlyph() {
  return (
    <span className="appbar__aa" aria-hidden="true">
      <span className="appbar__aa-lg">أ</span>
      <span className="appbar__aa-sm">أ</span>
    </span>
  )
}

/** Every action a view is allowed to lend, and what it looks like. */
const CHROME_ACTIONS: Record<string, { label: string; glyph: ReactNode }> = {
  type: { label: "حجم الخط والتشكيل", glyph: <TypeGlyph /> },
}

export type ChromeActionId = keyof typeof CHROME_ACTIONS

type ChromeActionState = { id: string | null; run: () => void }

const useChromeActionStore = create<ChromeActionState>()(() => ({ id: null, run: () => {} }))

/**
 * Lend the app bar one action while this view is mounted.
 *
 * The handler is held in a ref and the effect is keyed on the ID alone, because
 * a view's `onPress` closes over its own state and so is a new function on every
 * render: keyed on the function, this would set the store on every keystroke in
 * the قصيدة and re-register a listener behind it.
 */
export function useChromeAction(id: ChromeActionId | null, run: () => void): void {
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    if (!id) return
    useChromeActionStore.setState({ id, run: () => runRef.current() })
    return () => useChromeActionStore.setState({ id: null, run: () => {} })
  }, [id])
}

/**
 * Past `px` down the page. One passive listener, one boolean — the app bar is
 * the only thing that reads it.
 */
function useScrolledPast(px: number): boolean {
  const [past, setPast] = useState(false)
  useEffect(() => {
    const on = () => setPast(window.scrollY > px)
    on()
    window.addEventListener("scroll", on, { passive: true })
    return () => window.removeEventListener("scroll", on)
  }, [px])
  return past
}

/** Below this the screen's own hero title is still on screen. */
const TITLE_HANDOVER = 48

/** The ⌕ of the app bar — the masthead's glyph at touch scale. */
function SearchGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M15.4 15.4 20 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The account door at icon scale: the نِيب disc alone (the name is on the page
 * it opens), or one short word. It renders nothing until `/api/auth/me` has
 * answered and nothing at all where accounts are unavailable — the same rule
 * the masthead's door follows, for the same reason.
 */
function AccountDisc() {
  const status = useAuth((s) => s.status)
  const available = useAuth((s) => s.available)
  const user = useAuth((s) => s.user)
  const openDialog = useAuth((s) => s.openDialog)

  if (status === "unknown" || !available) return null

  if (!user) {
    return (
      <button type="button" className="appbar__signin" onClick={() => openDialog("login")}>
        دخول
      </button>
    )
  }

  return (
    <a
      className="appbar__account"
      href={routeHash({ view: "profile", username: user.username })}
      aria-label={`صفحتك — ${user.displayName}`}
    >
      <span className="appbar__disc" aria-hidden="true">
        <Avatar name={user.displayName} src={user.avatar} />
      </span>
    </a>
  )
}

export function AppBar({ route }: { route: Route }) {
  const root = isTabRoot(route)
  const lent = useChromeTitleStore((s) => s.title)
  const actionId = useChromeActionStore((s) => s.id)
  const runAction = useChromeActionStore((s) => s.run)
  const action = actionId ? CHROME_ACTIONS[actionId] : undefined
  const scrolled = useScrolledPast(TITLE_HANDOVER)
  // A GAME SCREEN cannot scroll, so it can never hand the title over.
  // `body[data-immersive]` makes `.main` exactly one viewport tall with the
  // overflow hidden (phone.css), which pins `scrollY` at 0 forever — and the
  // handover below exists only to stop the bar repeating a hero that is still
  // on screen. A docked مساجلة has no hero: its own head is stood down, so the
  // name it lends («ديوان «ما أحفظه من المتنبي»») is the ONLY place that name
  // appears at all. It is lent from the first frame there.
  const immersive = useImmersiveActive()
  // The HANDOVER. A شاعر's page opens on his name, set large beside his
  // medallion, and a bar repeating it two centimetres above is the same word
  // twice. So the bar names the KIND of screen while that hero is on screen —
  // «الشاعر», «القصيدة» — and takes over the name itself the moment the hero
  // scrolls away. It is the one place this chrome borrows a platform gesture
  // outright, because it is the gesture that stops the bar from being a label.
  const title = (!root && (scrolled || immersive) && lent) || routeTitle(route)

  return (
    <header className="appbar" data-root={root ? "1" : "0"} data-scrolled={scrolled ? "1" : "0"}>
      <div className="appbar__row">
        {/* Mid-مساجلة the chevron is not navigation: `askExit` raises «انسحب؟»
            and reports that it took the press. Everywhere else it is exactly
            the back it has always been. */}
        {root ? null : (
          <button
            type="button"
            className="appbar__back"
            onClick={() => {
              if (!askExit()) goBack(route)
            }}
            aria-label="رجوع"
          >
            <BackChevron />
          </button>
        )}
        {/* Not a heading. The screen's own `<h1>` is still in the accessibility
            tree — chrome.css hides it the `.sr-only` way, not with
            `display: none` — so a second one here would be a duplicate that
            says less than the first. */}
        <span className="appbar__title">
          <bdi>{title}</bdi>
        </span>
        {root ? (
          <div className="appbar__tools">
            <button type="button" className="appbar__act" onClick={() => openPalette()} aria-label="ابحث في الديوان">
              <SearchGlyph />
            </button>
            <AccountDisc />
          </div>
        ) : action ? (
          // A SUB-SCREEN gets at most the one action its view lent — the قصيدة's
          // reading controls, and nothing else. Everything a screen can do that
          // names itself stays in the screen's own toolbar, where the words are.
          <div className="appbar__tools">
            <button type="button" className="appbar__act" onClick={runAction} aria-label={action.label}>
              {action.glyph}
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}
