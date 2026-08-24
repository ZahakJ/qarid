/**
 * Phase-0 shell (design-ux.md §9). Every route in §1 resolves to a placeholder
 * view with its real Arabic heading; the later phases replace the bodies one at
 * a time without touching the shell.
 *
 * Contracts this file owns and must keep:
 *  • `document.body.dataset.appReady = '1'` after the first render settles —
 *    tools/screenshot.mjs waits on `body[data-app-ready="1"]`.
 *  • `?` opens HelpOverlay everywhere.
 *  • body data-attributes mirror the settings slice so CSS can react without
 *    every component subscribing.
 */
import { useEffect, useState } from "react"
import { HOME, initRouter, routeHash, routeTitle, useRoute, type Route } from "./router.ts"
import { motionReduced, useSettings } from "./store/settingsStore.ts"
import { Toasts } from "./components/Toasts.tsx"
import { HelpOverlay } from "./components/HelpOverlay.tsx"
import { Nib, Rule } from "./components/Ornaments.tsx"
import { Panel } from "./components/Panel.tsx"
import { Chip } from "./components/Chip.tsx"
import { BUHUR } from "./data/buhur.ts"

/** Masthead nav — the doors that exist from day one. */
const NAV: { route: Route; label: string }[] = [
  { route: { view: "home" }, label: "الديوان" },
  { route: { view: "poets" }, label: "الشعراء" },
  { route: { view: "browse", query: {} }, label: "التصفح" },
  { route: { view: "search", q: "", page: 1 }, label: "البحث" },
  { route: { view: "duel" }, label: "المساجلة" },
  { route: { view: "train" }, label: "التحفيظ" },
]

/** One line of Arabic per route, so a placeholder still says what it is for. */
const LEDE: Record<Route["view"], string> = {
  home: "ديوان الشعر العربي: ٢٥٤٬٦٣٠ قصيدة لـ٧٬١٦٧ شاعرًا، تُتصفَّح وتُساجَل.",
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
  home: "المرحلة ٢",
  poets: "المرحلة ٢",
  poet: "المرحلة ٢",
  poem: "المرحلة ١",
  browse: "المرحلة ٢",
  search: "المرحلة ٢",
  wander: "المرحلة ٤",
  duel: "المرحلة ٣",
  "duel-play": "المرحلة ٣",
  "duel-summary": "المرحلة ٣",
  daily: "المرحلة ٤",
  train: "المرحلة ٤",
  "train-drill": "المرحلة ٤",
  "train-arsenal": "المرحلة ٤",
  stats: "المرحلة ٤",
  favorites: "المرحلة ٢",
  rules: "المرحلة ٤",
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

/** The four أبواب of the home screen; counts arrive with the API in Phase 2. */
const DOORS: { label: string; note: string; route: Route }[] = [
  { label: "العصور", note: "من الجاهلي إلى الحديث", route: { view: "browse", query: {} } },
  { label: "البحور", note: "ستة عشر بحرًا", route: { view: "browse", query: {} } },
  { label: "الأغراض", note: "مدحٌ ورثاءٌ وغزل", route: { view: "browse", query: {} } },
  { label: "القوافي", note: "ثمانية وعشرون حرفًا", route: { view: "browse", query: {} } },
]

function HomeStub({ ready }: { ready: boolean }) {
  return (
    <div className="view view--centred">
      <div style={{ opacity: ready ? 1 : 0, transition: "opacity var(--dur-3) var(--ease)" }}>
        <Wordmark hero />
      </div>
      <p className="view__lede">{LEDE.home}</p>
      <Panel illuminated title="بيت اليوم" note="يصل مع الديوان — المرحلة ٢">
        <div className="bayt" data-size="md" aria-hidden="true">
          <span className="sadr">وما نيلُ المطالبِ بالتمنّي</span>
          <span className="gutter" />
          <span className="ajuz">ولكن تُؤخذُ الدنيا غِلابا</span>
        </div>
        <div className="bayt-plate__meta">
          <Chip variant="asr" label="العصر الحديث" />
          <Chip variant="bahr" slug="wafir" label="الوافر" />
          <Chip variant="gharad" label="حكمة" />
          <Chip variant="rawiyy" label="ب" title="الرويّ: الباء" />
          <span>أحمد شوقي</span>
        </div>
      </Panel>
      <nav className="doors" aria-label="أبواب الديوان">
        {DOORS.map((d) => (
          <a className="door" key={d.label} href={routeHash(d.route)}>
            <span className="door__name">{d.label}</span>
            <span className="door__note">{d.note}</span>
          </a>
        ))}
      </nav>
      <Panel quiet>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)", alignItems: "center", justifyContent: "center" }}>
          <span className="panel__note">يُنشد الخصم بيتًا، فتُجيبه ببيت يبدأ برويّه.</span>
          <a className="btn btn--primary" href={routeHash({ view: "duel" })}>
            ساجِلني
          </a>
        </div>
      </Panel>
    </div>
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
        {view === "browse" ? (
          <div className="chip-cloud">
            {BUHUR.slice(0, 6).map((b) => (
              <Chip key={b.slug} variant="bahr" slug={b.slug} label={b.name} title={b.miftah} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function App() {
  const route = useRoute((s) => s.route)
  const settings = useSettings()
  const [ready, setReady] = useState(false)
  const [help, setHelp] = useState(false)

  useEffect(() => initRouter(), [])

  // First render settled → tell the smoke harness. Gated on document.fonts so
  // the screenshot never catches قريض in a fallback face.
  useEffect(() => {
    let live = true
    const mark = () => {
      if (!live) return
      setReady(true)
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

  // `?` opens help anywhere it is not being typed into a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      if (typing) return
      if (e.key === "?") {
        e.preventDefault()
        setHelp((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Mirror settings onto <body> so CSS reacts without a subscription per node.
  useEffect(() => {
    const b = document.body
    b.dataset.reduceMotion = motionReduced(settings) ? "1" : "0"
    b.dataset.verseSize = settings.verseSize
    b.dataset.numerals = settings.numerals
  }, [settings])

  useEffect(() => {
    document.title = route.view === "home" ? "قريض" : `${routeTitle(route)} — قريض`
  }, [route])

  const narrow = route.view === "home" || route.view === "poem" || route.view === "rules"

  return (
    <div className="app">
      <Masthead route={route} />
      <main className={narrow ? "main main--narrow" : "main"}>
        {route.view === "home" ? <HomeStub ready={ready} /> : <ViewStub route={route} />}
      </main>
      <footer className="footer">
        <span>قريض — ديوان الشعر العربي ومساجلته</span>
        <span className="footer__nib">
          <Nib size={18} />
        </span>
      </footer>
      <Toasts />
      {help ? <HelpOverlay onClose={() => setHelp(false)} /> : null}
    </div>
  )
}
