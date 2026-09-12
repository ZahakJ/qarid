/**
 * The shell (design-ux.md §9). `Body` is the one route switch in قريض, and every
 * `Route["view"]` now has a real case in it. The phase-0 `ViewStub` — a stub
 * heading, a hard-coded corpus count and «هذه الصفحة قيد الإنشاء — المرحلة N» —
 * is GONE with the last stub branch it served; the `default` falls back to the
 * ديوان, so a route added without a case lands somewhere real instead of
 * shipping a construction notice to a reader.
 *
 * Contracts this file owns and must keep:
 *  • `document.body.dataset.appReady = '1'` after the first render settles —
 *    tools/screenshot.mjs waits on `body[data-app-ready="1"]`.
 *  • `?` opens HelpOverlay everywhere; `/` focuses the omnibox if one is on
 *    screen and otherwise opens the global palette; `g` chords jump between
 *    doors. All three refuse to fire while the reader is typing into a field —
 *    the palette's own Ctrl+K / Ctrl+F does NOT, and is registered in
 *    `PaletteHost`, not here.
 *  • body data-attributes mirror the settings slice so CSS can react without
 *    every component subscribing.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { HOME, initRouter, navigate, pageKey, routeHash, routeTitle, useRoute, type Route } from "./router.ts"
import { rememberScroll, scrollTargetFor } from "./chrome.ts"
import { motionReduced, useSettings } from "./store/settingsStore.ts"
import { cancelExit, confirmExit, useExitAsked, useImmersiveActive } from "./store/immersiveStore.ts"
import { useReaderActive } from "./store/readerStore.ts"
import { useAppHeight } from "./hooks/useAppHeight.ts"
import { useNativeChrome } from "./hooks/useNativeChrome.ts"
import { AppBar, useLentTitle } from "./components/AppBar.tsx"
import { ConfirmSheet } from "./components/Sheet.tsx"
import { TabBar } from "./components/TabBar.tsx"
import { Toasts } from "./components/Toasts.tsx"
import { HelpOverlay } from "./components/HelpOverlay.tsx"
import { Nib } from "./components/Ornaments.tsx"
import { focusOmnibox } from "./components/Omnibox.tsx"
import { PaletteHost, openPalette } from "./components/Palette.tsx"
import { AuthDialog } from "./components/AuthDialog.tsx"
import { Avatar } from "./components/Avatar.tsx"
import { InstallControl } from "./components/InstallControl.tsx"
import { useAuth } from "./store/authStore.ts"
import { nativeBoot } from "./platform/nativeInit.ts"
import { useKeyboard } from "./hooks/useKeyboard.ts"
import { DuelPlayView } from "./duel/DuelPlayView.tsx"
import { DuelSetupView } from "./duel/DuelSetupView.tsx"
import { DuelSummaryView } from "./duel/DuelSummaryView.tsx"
import { ShareCardHost } from "./share/ShareDialog.tsx"
import { AlbumPickerHost } from "./albums/AlbumPicker.tsx"
import { DiwanView } from "./views/DiwanView.tsx"
import { DiwansView } from "./views/DiwansView.tsx"
import { ArsenalView } from "./views/ArsenalView.tsx"
import { BrowseView } from "./views/BrowseView.tsx"
import { BuhurView } from "./views/BuhurView.tsx"
import { DrillView } from "./views/DrillView.tsx"
import { FavoritesView } from "./views/FavoritesView.tsx"
import { DailyView } from "./views/DailyView.tsx"
import { HomeView } from "./views/HomeView.tsx"
import { MoreView } from "./views/MoreView.tsx"
import { PoemView } from "./views/PoemView.tsx"
import { PoetView } from "./views/PoetView.tsx"
import { PoetsView } from "./views/PoetsView.tsx"
import { PrivacyView } from "./views/PrivacyView.tsx"
import { QafiyaView } from "./views/QafiyaView.tsx"
import { ProfileView } from "./views/ProfileView.tsx"
import { RoomView } from "./views/RoomView.tsx"
import { RulesView } from "./views/RulesView.tsx"
import { SearchView } from "./views/SearchView.tsx"
import { StatsView } from "./views/StatsView.tsx"
import { TrainHubView } from "./views/TrainHubView.tsx"
import { AnthologyIndexView, AnthologyShelfView } from "./views/AnthologyView.tsx"
import { WanderView } from "./views/WanderView.tsx"

/**
 * Masthead nav — the doors that exist from day one.
 *
 * «البحث» is NOT among them any more (v2.md §3): the search door is the ⌕
 * trigger beside the nav, which opens the global palette, and `#/search` is
 * kept for deep links and the full result list rather than for navigation.
 */
const NAV: { route: Route; label: string }[] = [
  { route: { view: "home" }, label: "الديوان" },
  { route: { view: "poets" }, label: "الشعراء" },
  { route: { view: "browse", query: {} }, label: "التصفح" },
  { route: { view: "duel" }, label: "المساجلة" },
  { route: { view: "train" }, label: "التحفيظ" },
  { route: { view: "favorites" }, label: "المختارات" },
  /* «دواويني» was reachable only from «المزيد» and the profile, so on a desktop
     there was NO door to a reader's own shelves in the masthead at all — and
     the item that reads «الديوان» is the home page, which makes its absence
     harder to notice rather than easier. The phone nav already scrolls
     (app.css sizes it for seven), so this costs no layout. */
  { route: { view: "diwans" }, label: "دواويني" },
]

function Wordmark({ hero = false }: { hero?: boolean }) {
  return (
    <span className={hero ? "wordmark wordmark--hero" : "wordmark"}>
      <span className="wordmark__word">قريض</span>
      <span className="wordmark__rule" />
    </span>
  )
}

/** The ⌕ of the masthead trigger — inline SVG, never a font glyph. */
function SearchGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M15.4 15.4 20 20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}


/**
 * The masthead's account door (v2.md §4).
 *
 * Signed out it is one word, «دخول». Signed in it is the gold نِيب disc with
 * your initial in it, and it LINKS to your page rather than opening a menu —
 * one press, one destination, and «اخرج» lives on that page beside the other
 * things only you can do.
 *
 * It renders nothing at all until `/api/auth/me` has answered (`status` is
 * "unknown"), and nothing ever on a deployment with no writable users database:
 * a door that cannot open is worse than no door.
 */
function AccountControl() {
  const status = useAuth((s) => s.status)
  const available = useAuth((s) => s.available)
  const user = useAuth((s) => s.user)
  const openDialog = useAuth((s) => s.openDialog)

  if (status === "unknown" || !available) return <span className="masthead__account-slot" aria-hidden="true" />

  if (!user) {
    return (
      <button type="button" className="masthead__signin" onClick={() => openDialog("login")}>
        دخول
      </button>
    )
  }

  return (
    <a
      className="masthead__account"
      href={routeHash({ view: "profile", username: user.username })}
      aria-label={`صفحتك — ${user.displayName}`}
      title={user.displayName}
    >
      <span className="masthead__disc" aria-hidden="true">
        <Avatar name={user.displayName} src={user.avatar} />
      </span>
      <span className="masthead__account-name">{user.displayName}</span>
    </a>
  )
}

function Masthead({ route }: { route: Route }) {
  return (
    <header className="masthead">
      <div className="masthead__inner">
        <a href={routeHash(HOME)} aria-label="قريض — الصفحة الأولى">
          <Wordmark />
        </a>
        <nav className="masthead__nav" aria-label="التنقل الرئيس">
          {NAV.map((n) => (
            <a
              key={n.label}
              className="navlink"
              href={routeHash(n.route)}
              aria-current={n.route.view === route.view ? "page" : undefined}
            >
              {n.label}
            </a>
          ))}
        </nav>
        {/* The two affordances that are not navigation: the search trigger the
            «البحث» navlink used to be (it opens the palette, not a page), and
            the account door. They share one row so the phone masthead can put
            the wordmark and both of them on a single line. */}
        <div className="masthead__tools">
          <button type="button" className="masthead__search" onClick={() => openPalette()} aria-label="ابحث في الديوان">
            <SearchGlyph />
            <span className="masthead__search-label">ابحث</span>
            <kbd className="keys-only">Ctrl K</kbd>
          </button>
          <InstallControl />
          <AccountControl />
        </div>
      </div>
    </header>
  )
}

/**
 * The one route switch. Every branch that renders a real view is keyed on the
 * thing that makes the view a different page (a slug, a poem id, the whole
 * facet query), so navigating between two قصائد remounts rather than trying to
 * reconcile one poem's state onto another's.
 */
function Body({ route }: { route: Route }) {
  switch (route.view) {
    case "home":
      return <HomeView />
    case "poets":
      return <PoetsView era={route.era} letter={route.letter} />
    case "poet":
      return <PoetView key={route.slug} slug={route.slug} />
    case "poem":
      // Not keyed on `read`: وضع القراءة is the SAME قصيدة, already loaded and
      // possibly paged twice — remounting to read it would fetch it all again.
      return <PoemView key={route.id} id={route.id} bayt={route.bayt} read={route.read} />
    case "browse":
      return <BrowseView query={route.query} />
    case "qafiya":
      return <QafiyaView query={route.query} />
    case "buhur":
      // NOT keyed on `bahr`: `?b=` is a scroll target, and remounting sixteen
      // cards to bring one of them into view would throw away the أبيات
      // already fetched and every ♥ state on the screen.
      return <BuhurView bahr={route.bahr} />
    case "duel":
      // NOT keyed on `poet`: the شاعر is a control on this screen, set and
      // cleared in place, and remounting the setup would throw away the رتبة,
      // the نمط and the قاعدة the reader had already chosen.
      return <DuelSetupView poet={route.poet} />
    case "duel-play":
      return <DuelPlayView />
    case "duel-summary":
      return <DuelSummaryView />
    case "daily":
      return <DailyView />
    case "search":
      return <SearchView q={route.q} page={route.page} />
    case "favorites":
      return <FavoritesView collection={route.collection} />
    case "anthology":
      return <AnthologyIndexView />
    case "anthology-shelf":
      return <AnthologyShelfView slug={route.slug} />
    case "rules":
      return <RulesView />
    case "diwans":
      return <DiwansView />
    case "diwan":
      // Keyed on the code: a link to another ديوان is another page, and the
      // optimistic reorder holds entries that belong to the shelf they came from.
      return <DiwanView key={route.code} code={route.code} />
    case "privacy":
      return <PrivacyView />
    case "more":
      return <MoreView />
    case "stats":
      return <StatsView />
    case "train":
      return <TrainHubView />
    case "train-drill":
      // Keyed on the حرف: «تدرّب على ظ» from another letter's drill is a new
      // session, not a re-render of the old queue.
      return <DrillView key={route.letter ?? "all"} letter={route.letter} />
    case "train-arsenal":
      return <ArsenalView />
    case "wander":
      return <WanderView />
    case "profile":
      // Keyed on the name: «صفحتي» from someone else's page is a new page.
      return <ProfileView key={route.username} username={route.username} />
    case "room":
      // Keyed on the code: «رجعة» opens a DIFFERENT room, and the store's
      // socket, poller and draft all belong to the room they were opened for.
      return <RoomView key={route.code} code={route.code} joinKey={route.key} />
    default:
      // Every Route["view"] above has a case, so this is unreachable today —
      // it is here so that a route added WITHOUT one lands on the ديوان rather
      // than on a stub that tells a reader the page is under construction.
      return <HomeView />
  }
}

export function App() {
  const route = useRoute((s) => s.route)
  const lentTitle = useLentTitle()
  const settings = useSettings()
  const [help, setHelp] = useState(false)
  // ONE signal for «is this a phone» — a coarse pointer AND a narrow viewport
  // (client/hooks/useNativeChrome.ts). It picks the chrome here and is mirrored
  // onto `body[data-chrome]` below so client/styles/chrome.css reads the same
  // decision instead of re-deriving it.
  const native = useNativeChrome()
  // …and the two things that can override it, both of which take the whole
  // screen: a مساجلة being PLAYED (client/store/immersiveStore.ts) and a قصيدة
  // being READ (client/store/readerStore.ts). They are mutually exclusive by
  // construction — one is #/duel/play or #/room, the other #/poem?read=1 — and
  // each is turned on by the view that owns it, never re-derived here.
  const immersive = useImmersiveActive()
  const reading = useReaderActive()
  const exitAsked = useExitAsked()

  // `--app-height` / `--kb-inset`: what the viewport ACTUALLY is while a
  // keyboard is up. The docked answer field is measured against them.
  useAppHeight()

  useEffect(() => initRouter(), [])

  // Who is signed in — one request, on boot. The session is an HttpOnly cookie
  // (web) or a stored bearer (native shell), and the server is the only thing
  // that can say whether it is still live, so nothing about it is cached in
  // localStorage (client/store/authStore.ts). In the native shell `nativeBoot`
  // hydrates the bearer from Preferences and arms the status bar / back button /
  // deep links FIRST, then the same refresh runs; both are no-ops on the web.
  useEffect(() => {
    void nativeBoot().then(() => useAuth.getState().refresh())
  }, [])

  // First render settled → tell the smoke harness. Gated on document.fonts so
  // the screenshot never catches قريض in a fallback face.
  useEffect(() => {
    let live = true
    const mark = () => {
      if (!live) return
      document.body.dataset.appReady = "1"
    }
    const fonts = typeof document !== "undefined" ? document.fonts : undefined
    if (fonts?.ready) void fonts.ready.then(mark, mark)
    else mark()
    // never hang the harness on a font that will not load
    const t = setTimeout(mark, 3000)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [])

  // The global keymap (client/data/shortcuts.ts is the same list, rendered by
  // HelpOverlay). `useKeyboard` refuses every key that arrives from a field, so
  // typing `/` or `?` into the omnibox types it.
  //
  // `/` prefers the omnibox already on screen — home and search both mount one
  // — and only navigates when there is none to focus, because moving the reader
  // to another page to give them a text field they already had is rude.
  // `useKeyboard` matches the LOGICAL key, so these entries fire on an Arabic
  // layout too — the physical `/` reports «؟» there, and `g`/`p` report «ل»/«ح».
  useKeyboard({
    keys: {
      "?": () => setHelp((v) => !v),
      "/": () => {
        // A field already on screen wins; otherwise the palette IS the field,
        // and moving the reader to another page to give them one would be rude.
        if (!focusOmnibox()) openPalette()
      },
    },
    chords: {
      h: () => navigate(HOME),
      p: () => navigate({ view: "poets" }),
      b: () => navigate({ view: "browse", query: {} }),
      d: () => navigate({ view: "duel" }),
      f: () => navigate({ view: "favorites" }),
      s: () => navigate({ view: "stats" }),
      t: () => navigate({ view: "train" }),
      w: () => navigate({ view: "wander" }),
    },
  })

  // Mirror settings onto <body> so CSS reacts without a subscription per node.
  useEffect(() => {
    const b = document.body
    b.dataset.reduceMotion = motionReduced(settings) ? "1" : "0"
    b.dataset.verseSize = settings.verseSize
  }, [settings])

  // …and the chrome, the same way. `useLayoutEffect` because every rule in
  // chrome.css is scoped under this attribute: setting it after paint would
  // show a phone the web masthead for one frame first.
  useLayoutEffect(() => {
    document.body.dataset.chrome = native ? "native" : "web"
  }, [native])

  // The second attribute, and it carries WHICH kind of whole-screen this is:
  // `game` for a مساجلة being played (phone only — only a view that already
  // asked `useNativeChrome()` turns it on) and `read` for a قصيدة in وضع
  // القراءة, which is a reading and happens on every screen size. One
  // attribute, two values, so client/styles/phone.css's docked game layout and
  // client/styles/reader.css can never land on each other's screen.
  useLayoutEffect(() => {
    const mode = immersive ? "game" : reading ? "read" : null
    if (mode) document.body.dataset.immersive = mode
    else delete document.body.dataset.immersive
  }, [immersive, reading])

  // The tab's name. A view that knows its subject lends it (`useChromeTitle`,
  // which the app bar reads too), so «المتنبي — قريض» rather than «الشاعر —
  // قريض»; `routeTitle` is what stands until the data lands.
  useEffect(() => {
    const name = lentTitle ?? (route.view === "home" ? null : routeTitle(route))
    document.title = name ? `${name} — قريض` : "قريض"
  }, [route, lentTitle])

  // A new page starts at its top. A hash router changes no document, so the
  // window keeps whatever scroll the PREVIOUS page had: read half the شعراء
  // index, press «التصفح», and you land in the middle of a list you have not
  // seen — with #/browse's «المزيد» sentinel already on screen, so it autoloads
  // page after page before the first row is read (measured: `?p=4` in 300ms).
  // `pageKey` is what a reader would call a different page, so paging and facet
  // changes inside one view (which write the hash too) keep their position.
  //
  // The tab bar adds the one exception (client/chrome.ts): a TAB ROOT is a
  // place you RETURN to, not one you arrive at, so pressing «التصفح» after
  // reading a قصيدة puts you back where you were reading. Everything else still
  // starts at its top. The offset is recorded by a passive scroll listener
  // rather than read at navigation time, because by the time the effect runs
  // React has already committed the new page and the browser may have clamped
  // the old offset to a shorter document.
  const page = pageKey(route)
  const pageRef = useRef(page)
  useEffect(() => {
    const onScroll = () => rememberScroll(pageRef.current, window.scrollY)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])
  useEffect(() => {
    pageRef.current = page
    const top = scrollTargetFor(route, page, native)
    window.scrollTo({ top, left: 0, behavior: "instant" })
    if (top === 0) return
    // A windowed list (#/browse, #/poets) is one row tall until its first page
    // lands, so the scroll above is clamped to 0. Re-ask twice as the content
    // arrives, and give up the moment the reader touches the page themselves.
    let live = true
    const stop = () => (live = false)
    window.addEventListener("wheel", stop, { once: true, passive: true })
    window.addEventListener("touchstart", stop, { once: true, passive: true })
    const retry = () => live && window.scrollY < top && window.scrollTo({ top, left: 0, behavior: "instant" })
    const t1 = setTimeout(retry, 60)
    const t2 = setTimeout(retry, 260)
    return () => {
      live = false
      clearTimeout(t1)
      clearTimeout(t2)
      window.removeEventListener("wheel", stop)
      window.removeEventListener("touchstart", stop)
    }
    // Keyed on `page` ALONE, and deliberately not on `route`: #/browse writes
    // its facets and `?p=` into the hash without leaving the page, and re-
    // running this on every one of those would yank the reader back up the list
    // they are standing in. A stale `route` in this closure is harmless — the
    // only thing read off it is whether the page is a tab root, which cannot
    // change while `page` does not.
  }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  // Three measures: the ديوان's wide shell, the 46rem reading column for a
  // قصيدة and the قواعد, and a middle one for home — the بيت اليوم plate is set
  // at `lg`, and 46rem is not enough for two hemistichs of Amiri at that size.
  const measure =
    route.view === "home"
      ? "main main--home"
      : route.view === "poem" || route.view === "rules"
        ? "main main--narrow"
        : // a shelf is a column of أبيات; 78rem puts the عجز a hand's width from
          // the صدر and the «اقرأها» link alone at the far edge. باحث القافية
          // and صفحة البحور are columns of أبيات too — the first IS one, and the
          // second frames one inside every card — so they take the same measure
          // for the same reason.
          route.view === "anthology-shelf" || route.view === "qafiya" || route.view === "buhur"
          ? "main main--home"
          : "main"

  return (
    <div className="app">
      {/* First in the tab order on every route. `href` keeps it a link for
          assistive tech; the click moves focus rather than writing the hash,
          because the hash IS the router (writing `#main` would navigate). */}
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault()
          const main = document.getElementById("main")
          main?.focus()
          main?.scrollIntoView({ block: "start" })
        }}
      >
        تخطَّ إلى المحتوى
      </a>
      {/* Two chromes, one app. A phone gets the compact app bar and the bottom
          tab bar; everything else keeps the masthead and the footer, untouched
          and un-rerendered — neither native component is even in the desktop
          DOM (client/components/AppBar.tsx, TabBar.tsx). */}
      {/* …and both of them go while a قصيدة is being READ. وضع القراءة is the
          one surface that takes the whole screen on the DESKTOP too: a reading
          with a masthead over it and a footer under it is a web page about a
          قصيدة, not the قصيدة. */}
      {reading ? null : native ? <AppBar route={route} /> : <Masthead route={route} />}
      <main className={measure} id="main" tabIndex={-1}>
        {/* The route-change transition (v2.md §6). The key is the VIEW, not
            `pageKey`: switching views already swaps the component, so this
            costs no state, while a filter change inside one view (#/poets by
            عصر, #/browse by بحر) keeps its DOM and must NOT flash the page the
            reader is standing on. motion.css owns the 300ms rise. */}
        <div className="route-swap" key={route.view}>
          <Body route={route} />
        </div>
      </main>
      {/* The footer is a web affordance: on a phone its two links live in
          «المزيد» (سياسة الخصوصية under عن قريض), and a scrolling page that
          ends in a footer above a fixed tab bar reads as a website. */}
      {native || reading ? null : (
        <footer className="footer">
          <span>قريض — ديوان الشعر العربي ومساجلته</span>
          <span className="footer__nib">
            <Nib size={18} />
          </span>
          <a className="footer__link" href={routeHash({ view: "privacy" })}>
            سياسة الخصوصية
          </a>
        </footer>
      )}
      {/* The tab bar GOES while a مساجلة is being played. There is nowhere to
          go until the بيت is answered or the match is given up, and a game
          screen with five doors along its bottom edge is a website with a game
          on it. It comes back on the summary — which is a page again. It goes
          for a reading too, and for the same reason. */}
      {native && !immersive && !reading ? <TabBar route={route} /> : null}
      <Toasts />
      <ShareCardHost />
      {/* «أضِف إلى ديوان» — mounted ONCE, like البطاقة, because the action
          lives on every بيت in the app and no view should own its dialog. */}
      <AlbumPickerHost />
      <PaletteHost />
      <AuthDialog />
      {/* «انسحب؟» — the one question the back gesture asks. Mounted in the
          shell rather than in the two views that can raise it, because the
          press it answers arrives at the app bar and at the hardware button,
          neither of which belongs to a view. */}
      {exitAsked ? (
        <ConfirmSheet
          title="انسحب؟"
          note="الرجوع من هنا انسحابٌ من المساجلة — تُحتسب لخصمك، ولا تُستأنف."
          confirmLabel="انسحب"
          cancelLabel="تابِع المساجلة"
          danger
          onConfirm={confirmExit}
          onClose={cancelExit}
        />
      ) : null}
      {help ? <HelpOverlay onClose={() => setHelp(false)} /> : null}
    </div>
  )
}
