/**
 * The shell (design-ux.md §9). `Body` is the one route switch in قريض: a view
 * that exists is mounted, a view that does not yet gets `ViewStub` with its
 * real Arabic heading and the phase that fills it. Later phases replace stub
 * branches one at a time and touch nothing else in this file.
 *
 * Contracts this file owns and must keep:
 *  • `document.body.dataset.appReady = '1'` after the first render settles —
 *    tools/screenshot.mjs waits on `body[data-app-ready="1"]`.
 *  • `?` opens HelpOverlay everywhere; `/` focuses the omnibox if one is on
 *    screen and otherwise goes to #/search; `g` chords jump between doors.
 *    All three refuse to fire while the reader is typing into a field.
 *  • body data-attributes mirror the settings slice so CSS can react without
 *    every component subscribing.
 */
import { useEffect, useState } from "react"
import { HOME, initRouter, navigate, pageKey, routeHash, routeTitle, useRoute, type Route } from "./router.ts"
import { motionReduced, useSettings } from "./store/settingsStore.ts"
import { Toasts } from "./components/Toasts.tsx"
import { HelpOverlay } from "./components/HelpOverlay.tsx"
import { Nib, Rule } from "./components/Ornaments.tsx"
import { focusOmnibox } from "./components/Omnibox.tsx"
import { useKeyboard } from "./hooks/useKeyboard.ts"
import { DuelPlayView } from "./duel/DuelPlayView.tsx"
import { DuelSetupView } from "./duel/DuelSetupView.tsx"
import { DuelSummaryView } from "./duel/DuelSummaryView.tsx"
import { ShareCardHost } from "./share/ShareDialog.tsx"
import { ArsenalView } from "./views/ArsenalView.tsx"
import { BrowseView } from "./views/BrowseView.tsx"
import { DrillView } from "./views/DrillView.tsx"
import { FavoritesView } from "./views/FavoritesView.tsx"
import { DailyView } from "./views/DailyView.tsx"
import { HomeView } from "./views/HomeView.tsx"
import { PoemView } from "./views/PoemView.tsx"
import { PoetView } from "./views/PoetView.tsx"
import { PoetsView } from "./views/PoetsView.tsx"
import { RulesView } from "./views/RulesView.tsx"
import { SearchView } from "./views/SearchView.tsx"
import { StatsView } from "./views/StatsView.tsx"
import { TrainHubView } from "./views/TrainHubView.tsx"
import { WanderView } from "./views/WanderView.tsx"

/** Masthead nav — the doors that exist from day one. */
const NAV: { route: Route; label: string }[] = [
  { route: { view: "home" }, label: "الديوان" },
  { route: { view: "poets" }, label: "الشعراء" },
  { route: { view: "browse", query: {} }, label: "التصفح" },
  { route: { view: "search", q: "", page: 1 }, label: "البحث" },
  { route: { view: "duel" }, label: "المساجلة" },
  { route: { view: "train" }, label: "التحفيظ" },
  { route: { view: "favorites" }, label: "المختارات" },
]

/** One line of Arabic per route, so a placeholder still says what it is for. */
const LEDE: Record<Route["view"], string> = {
  home: "ديوان الشعر العربي: 239,411 قصيدة لـ6,997 شاعرًا، تُتصفَّح وتُساجَل.",
  poets: "فهرس الشعراء مرتّبًا على حروف الشهرة، مع أعصرهم وعدد قصائدهم.",
  poet: "صفحة الشاعر: ترجمته، وبيته المختار، وديوانه كاملًا.",
  poem: "القصيدة كاملة، بيتًا بيتًا، ببحرها وقافيتها وتشكيلها.",
  browse: "تصفّح بالعصر والبحر والغرض والروي وحرف البداية.",
  search: "بحث في الأبيات والقصائد والشعراء، بالكلمات أو بالعبارة.",
  wander: "بيت واحد وثلاثة أبواب: شاعره، أو بحره، أو قافيته.",
  duel: "يُنشد الخصم بيتًا، فتُجيبه ببيت يبدأ برويّه. تُضبط الرتبة والقيود هنا.",
  "duel-play": "دور المساجلة الجاري.",
  "duel-summary": "خلاصة المساجلة: النقاط، وأطول سلسلة، ومن لقيتَ من الشعراء.",
  daily: "تحدّي اليوم: مطلعٌ واحد للناس جميعًا، وروحٌ واحدة.",
  train: "التحفيظ: مذاكرة الأبيات وبناء الترسانة.",
  "train-drill": "بطاقات المذاكرة: يُعرض الصدر ويُطلب العجز.",
  "train-arsenal": "ترسانتك: ثمانية وعشرون حرفًا، وما تحفظه تحت كلٍّ منها.",
  stats: "إحصاءات الديوان: البحور والأعصر والقوافي.",
  favorites: "ما اخترته من الأبيات، ومجموعاتك.",
  rules: "قواعد المساجلة: كيف يُشتقّ الرويّ، وما يُقبل وما يُردّ.",
}

/** Phase-0 body: says plainly which phase fills this view in. */
const PHASE: Record<Route["view"], string> = {
  home: "المرحلة 2",
  poets: "المرحلة 2",
  poet: "المرحلة 2",
  poem: "المرحلة 1",
  browse: "المرحلة 2",
  search: "المرحلة 2",
  wander: "المرحلة 4",
  duel: "المرحلة 3",
  "duel-play": "المرحلة 3",
  "duel-summary": "المرحلة 3",
  daily: "المرحلة 4",
  train: "المرحلة 4",
  "train-drill": "المرحلة 4",
  "train-arsenal": "المرحلة 4",
  stats: "المرحلة 4",
  favorites: "المرحلة 2",
  rules: "المرحلة 4",
}

function Wordmark({ hero = false }: { hero?: boolean }) {
  return (
    <span className={hero ? "wordmark wordmark--hero" : "wordmark"}>
      <span className="wordmark__word">قريض</span>
      <span className="wordmark__rule" />
    </span>
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
      </div>
    </header>
  )
}

function ViewStub({ route }: { route: Route }) {
  const view = route.view
  return (
    <div className="view">
      <div className="view__head">
        <h1 className="view__title">{routeTitle(route)}</h1>
        <p className="view__lede">{LEDE[view]}</p>
      </div>
      <Rule />
      <div className="stub">
        <span>هذه الصفحة قيد الإنشاء — {PHASE[view]}.</span>
        <span className="stub__route">{routeHash(route)}</span>
      </div>
    </div>
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
      return <PoemView key={route.id} id={route.id} bayt={route.bayt} />
    case "browse":
      return <BrowseView query={route.query} />
    case "duel":
      return <DuelSetupView />
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
    case "rules":
      return <RulesView />
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
    default:
      return <ViewStub route={route} />
  }
}

export function App() {
  const route = useRoute((s) => s.route)
  const settings = useSettings()
  const [help, setHelp] = useState(false)

  useEffect(() => initRouter(), [])

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
        if (!focusOmnibox()) navigate({ view: "search", q: "", page: 1 })
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

  useEffect(() => {
    document.title = route.view === "home" ? "قريض" : `${routeTitle(route)} — قريض`
  }, [route])

  // A new page starts at its top. A hash router changes no document, so the
  // window keeps whatever scroll the PREVIOUS page had: read half the شعراء
  // index, press «التصفح», and you land in the middle of a list you have not
  // seen — with #/browse's «المزيد» sentinel already on screen, so it autoloads
  // page after page before the first row is read (measured: `?p=4` in 300ms).
  // `pageKey` is what a reader would call a different page, so paging and facet
  // changes inside one view (which write the hash too) keep their position.
  const page = pageKey(route)
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" })
  }, [page])

  // Three measures: the ديوان's wide shell, the 46rem reading column for a
  // قصيدة and the قواعد, and a middle one for home — the بيت اليوم plate is set
  // at `lg`, and 46rem is not enough for two hemistichs of Amiri at that size.
  const measure =
    route.view === "home"
      ? "main main--home"
      : route.view === "poem" || route.view === "rules"
        ? "main main--narrow"
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
      <Masthead route={route} />
      <main className={measure} id="main" tabIndex={-1}>
        <Body route={route} />
      </main>
      <footer className="footer">
        <span>قريض — ديوان الشعر العربي ومساجلته</span>
        <span className="footer__nib">
          <Nib size={18} />
        </span>
      </footer>
      <Toasts />
      <ShareCardHost />
      {help ? <HelpOverlay onClose={() => setHelp(false)} /> : null}
    </div>
  )
}
