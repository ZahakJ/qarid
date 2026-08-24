/**
 * #/ — the first page of the ديوان (design-ux.md §3 Home).
 *
 * A centred 46rem column, in this order and for these reasons:
 *   wordmark        قريض, in Aref Ruqaa, over a dissolving gold hairline.
 *   بيت اليوم       the hero. It is a real بيت from the corpus, seeded on the
 *                   Asia/Riyadh date, and its reveal is gated on
 *                   `document.fonts.ready` — Amiri arriving late under a بيت
 *                   already painted in a fallback face is the one flash this
 *                   product cannot afford (design-ux.md §7).
 *   omnibox         the way in for anyone who came with a line in their head.
 *   أبواب           four doors with REAL top-3 counts, so the corpus's shape is
 *                   visible before the first click.
 *   المساجلة        the game, with what you have already done in it.
 *   شاعر اليوم      one شاعر, chosen by the same daily seed.
 */
import { useEffect, useState } from "react"
import { ApiError } from "../api/client.ts"
import { getDailyBait } from "../api/queries.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { formatBayt, formatBaytWithPoet, writeClipboard } from "../bayt/copy.ts"
import { Chip } from "../components/Chip.tsx"
import { Omnibox } from "../components/Omnibox.tsx"
import { Rule, Shamsa } from "../components/Ornaments.tsx"
import { useArsenal } from "../hooks/useArsenal.ts"
import { loadFacets, loadMeta } from "../store/libraryStore.ts"
import { useCollections } from "../store/collectionsStore.ts"
import { useProfile } from "../store/profileStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { routeHash, type BrowseQuery, type Route } from "../router.ts"
import { formatCount, formatNumber, formatPoems, formatPoets } from "../../shared/format.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import type { DailyResponse, FacetsResponse, MetaResponse } from "../../shared/schema.ts"
import { headingOf } from "./shared.tsx"

/** How many values each door previews. */
const DOOR_TOP = 3

export function HomeView() {
  const settings = useSettings()
  const profile = useProfile()
  const arsenal = useArsenal()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)

  const [daily, setDaily] = useState<DailyResponse | null>(null)
  const [dailyError, setDailyError] = useState<ApiError | null>(null)
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [facets, setFacets] = useState<FacetsResponse | null>(null)
  const [fontsReady, setFontsReady] = useState(false)

  // The hero waits for Amiri. Never longer than a second, though: a بيت that
  // never appears because a font 404'd is worse than one in a fallback face.
  useEffect(() => {
    let live = true
    const mark = () => live && setFontsReady(true)
    const fonts = typeof document !== "undefined" ? document.fonts : undefined
    if (fonts?.ready) void fonts.ready.then(mark, mark)
    else mark()
    const t = setTimeout(mark, 1000)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    getDailyBait(undefined, { signal: ac.signal })
      .then((d) => !ac.signal.aborted && setDaily(d))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setDailyError(e instanceof ApiError ? e : new ApiError("network", "تعذّر جلب بيت اليوم", "/api/baits/daily"))
      })
    loadMeta(ac.signal)
      .then((m) => !ac.signal.aborted && setMeta(m))
      .catch(() => {})
    loadFacets({}, ac.signal)
      .then((f) => !ac.signal.aborted && setFacets(f))
      .catch(() => {})
    return () => ac.abort()
  }, [])

  const bait = daily?.bait
  const isSaved = bait ? favorites.some((f) => f.baytKey === bait.baytKey) : false

  return (
    <div className="view view--centred home">
      <header className="home__mast">
        <span className="wordmark wordmark--hero">
          <span className="wordmark__word">قريض</span>
          <span className="wordmark__rule" />
        </span>
        <p className="home__lede">
          {meta
            ? `${formatNumber(meta.counts.poems)} قصيدة، و${formatNumber(meta.counts.baits)} بيتًا، لـ${formatNumber(meta.counts.poets)} شاعرًا — تُقرأ وتُساجَل.`
            : "ديوان الشعر العربي: يُقرأ ويُساجَل."}
        </p>
      </header>

      {/* ── بيت اليوم ─────────────────────────────────────────────────── */}
      <section className="hero" aria-label="بيت اليوم">
        <div className="hero__head">
          <Shamsa size={13} />
          <h2 className="hero__title">بيت اليوم</h2>
          <Shamsa size={13} />
        </div>

        {dailyError ? (
          <p className="hero__error">{dailyError.message}</p>
        ) : !bait || !fontsReady ? (
          <BaytSkeleton rows={1} size="lg" />
        ) : (
          <div className="hero__plate">
            <BaytPlate
              variant="plate"
              size="lg"
              sadr={bait.sadr}
              ajuz={bait.ajuz}
              rawiyy={bait.rawiyy}
              showRawiyy={settings.showRawiyy}
              tashkeel={settings.tashkeel}
              numerals={settings.numerals}
              label="بيت اليوم"
              favorite={isSaved}
              onFavorite={() => {
                const now = toggleFavorite({
                  baytKey: bait.baytKey,
                  baitId: bait.id,
                  sadr: bait.sadr,
                  ajuz: bait.ajuz,
                  poemId: bait.poem.id,
                  poemTitle: bait.poem.title,
                  poet: bait.poet,
                  meter: bait.meter,
                })
                toast(now ? "أُضيف إلى المختارات" : "أُزيل من المختارات", now ? "ok" : "info")
              }}
              onCard={() => toast("بطاقة المشاركة تأتي مع المرحلة القادمة")}
              onCopy={() => {
                void writeClipboard(formatBaytWithPoet(bait.sadr, bait.ajuz, bait.poet.name, null)).then((ok) =>
                  toast(ok ? "نُسخ البيت" : "تعذّر النسخ", ok ? "ok" : "danger"),
                )
              }}
              copyText={formatBayt(bait.sadr, bait.ajuz)}
              duelHref={routeHash({ view: "duel" })}
              meta={
                <>
                  <a className="hero__poet" href={routeHash({ view: "poet", slug: bait.poet.slug })}>
                    <bdi>{bait.poet.name}</bdi>
                  </a>
                  {bait.era ? <Chip variant="asr" label={bait.era.name} /> : null}
                  {bait.meter ? <Chip variant="bahr" slug={bait.meter.slug} label={bait.meter.name} /> : null}
                  {bait.rawiyy ? <Chip variant="rawiyy" label={bait.rawiyy} title={`الرويّ: ${letterName(bait.rawiyy)}`} /> : null}
                  <a className="hero__poem" href={routeHash({ view: "poem", id: bait.poem.id, bayt: bait.position })}>
                    القصيدة ←
                  </a>
                </>
              }
            />
          </div>
        )}
      </section>

      {/* ── الطلب ─────────────────────────────────────────────────────── */}
      <Omnibox />

      {/* ── أبواب ─────────────────────────────────────────────────────── */}
      <nav className="doors" aria-label="أبواب الديوان">
        {doors(meta, facets).map((d) => (
          <section className="door" key={d.name}>
            <a className="door__name" href={routeHash(d.route)}>
              {d.name}
            </a>
            <div className="door__top">
              {d.top.length === 0 ? (
                <span className="door__note">{d.note}</span>
              ) : (
                /* Each line is its own link into the filtered browse — a door
                   with three named rooms behind it, not a label over a list. */
                d.top.map((t) => (
                  <a className="door__line" key={t.label} href={routeHash({ view: "browse", query: t.query })}>
                    <span className="door__label">{t.label}</span>
                    <span className="door__count">{formatCount(t.count)}</span>
                  </a>
                ))
              )}
            </div>
            <a className="door__more" href={routeHash(d.route)}>
              الكل ←
            </a>
          </section>
        ))}
      </nav>

      {/* ── المساجلة ──────────────────────────────────────────────────── */}
      <section className="duel-bar" aria-label="المساجلة">
        <div className="duel-bar__copy">
          <h2 className="duel-bar__title">المساجلة</h2>
          <p className="duel-bar__note">يُنشد الخصمُ بيتًا، فتُجيبَه ببيتٍ يبدأ برويّه.</p>
        </div>
        <dl className="duel-bar__stats">
          <div>
            <dt>أطول سلسلة</dt>
            <dd className="num">{profile.bestStreak}</dd>
          </div>
          <div>
            <dt>مساجلات</dt>
            <dd className="num">{profile.gamesPlayed}</dd>
          </div>
        </dl>
        <ArsenalRing covered={arsenal.covered} total={arsenal.total} />
        <a className="btn btn--primary" href={routeHash({ view: "duel" })}>
          ساجِلني
        </a>
      </section>

      <a className="daily-row" href={routeHash({ view: "daily" })}>
        <span className="daily-row__label">تحدّي اليوم</span>
        <span className="daily-row__note">
          مطلعٌ واحد للناس جميعًا، وروحٌ واحدة
          {daily ? (
            <>
              {" — "}
              {/* `2026-08-24` is ASCII in an RTL line: without its own LTR run
                  the neutral hyphens take the paragraph direction and the date
                  renders back to front (amendments §15). */}
              <bdi dir="ltr" className="daily-row__date">
                {daily.date}
              </bdi>
            </>
          ) : null}
        </span>
        <span className="daily-row__go">ابدأ ←</span>
      </a>

      {/* ── شاعر اليوم ────────────────────────────────────────────────── */}
      {daily ? (
        <section className="poet-day" aria-label="شاعر اليوم">
          <div className="poet-day__head">
            <h2 className="section-title">شاعر اليوم</h2>
            <Rule />
          </div>
          <a className="poet-day__card" href={routeHash({ view: "poet", slug: daily.poetOfTheDay.slug })}>
            <span className="poet-day__name">
              <bdi>{daily.poetOfTheDay.name}</bdi>
            </span>
            <span className="poet-day__meta">
              {daily.poetOfTheDay.era ? <Chip variant="asr" label={daily.poetOfTheDay.era.name} /> : null}
              <span>{formatPoems(daily.poetOfTheDay.poemCount)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatCount(daily.poetOfTheDay.baitCount)} بيتًا</span>
            </span>
            {daily.poetOfTheDay.description ? (
              <span className="poet-day__bio">{daily.poetOfTheDay.description}</span>
            ) : daily.poem ? (
              <span className="poet-day__bio poet-day__bio--matla">من ديوان اليوم: {headingOf(daily.poem).text}</span>
            ) : null}
          </a>
        </section>
      ) : null}

      {meta ? (
        <p className="home__foot">
          {formatPoets(meta.counts.poets)} · {formatPoems(meta.counts.poems)} · {formatCount(meta.counts.baits)} بيتًا
        </p>
      ) : null}
    </div>
  )
}

function letterName(letter: string): string {
  return LETTER_NAMES[letter as HijaiLetter] ?? letter
}

type DoorLine = { label: string; count: number; query: BrowseQuery }
type Door = { name: string; note: string; top: DoorLine[]; route: Route }

/**
 * The four doors, with real numbers. Eras, بحور and أغراض come from /api/meta
 * (precomputed at ingest); the قوافي counts come from the unfiltered
 * /api/facets, which the server serves straight out of `meta.facets_json` and
 * which is therefore just as cheap.
 *
 * The بحور door lists only `kind: 'bahr'` — التفعيلة, النثر and الموشح are
 * browsable but they are not بحور — and الأغراض drops the two buckets
 * قصيرة/عامة, which between them hold a quarter of the corpus and mean
 * "uncategorised" (amendments.md §11).
 */
function doors(meta: MetaResponse | null, facets: FacetsResponse | null): Door[] {
  const eras = [...(meta?.eras ?? [])].sort((a, b) => b.poemCount - a.poemCount).slice(0, DOOR_TOP)
  const meters = [...(meta?.meters ?? [])]
    .filter((m) => m.kind === "bahr")
    .sort((a, b) => b.poemCount - a.poemCount)
    .slice(0, DOOR_TOP)
  const themes = [...(meta?.themes ?? [])]
    .filter((t) => t.kind === "theme")
    .sort((a, b) => b.poemCount - a.poemCount)
    .slice(0, DOOR_TOP)
  const rhymes = [...(facets?.rhymes ?? [])].sort((a, b) => b.count - a.count).slice(0, DOOR_TOP)

  return [
    {
      name: "العصور",
      note: "من الجاهلي إلى الحديث",
      top: eras.map((e) => ({ label: e.name, count: e.poemCount, query: { era: e.slug } })),
      route: { view: "browse", query: {} },
    },
    {
      name: "البحور",
      note: "ستة عشر بحرًا",
      top: meters.map((m) => ({ label: m.name, count: m.poemCount, query: { meter: m.slug } })),
      route: { view: "browse", query: {} },
    },
    {
      name: "الأغراض",
      note: "مدحٌ ورثاءٌ وغزل",
      top: themes.map((t) => ({ label: t.display, count: t.poemCount, query: { theme: t.slug } })),
      route: { view: "browse", query: {} },
    },
    {
      name: "القوافي",
      note: "ثمانية وعشرون حرفًا",
      top: rhymes.map((r) => ({
        label: `قافية ${letterName(r.letter)}`,
        count: r.count,
        query: { rawiyy: r.letter },
      })),
      route: { view: "browse", query: rhymes[0] ? { rawiyy: rhymes[0].letter } : {} },
    },
  ]
}

/** «تغطية ٢١ من ٢٨ حرفًا» — the ترسانة at a glance (design-ux.md §5). */
function ArsenalRing({ covered, total }: { covered: number; total: number }) {
  const r = 22
  const c = 2 * Math.PI * r
  const ratio = total === 0 ? 0 : covered / total
  return (
    <div className="ring" title={`تغطية ${formatCount(covered)} من ${formatCount(total)} حرفًا`}>
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle cx="28" cy="28" r={r} stroke="var(--line-1)" strokeWidth="3" fill="none" />
        <circle
          cx="28"
          cy="28"
          r={r}
          stroke="var(--accent)"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
          transform="rotate(-90 28 28)"
          opacity={ratio === 0 ? 0.25 : 0.9}
        />
      </svg>
      <span className="ring__label">
        <span className="ring__n num">
          {covered}/{total}
        </span>
        <span className="ring__cap">الترسانة</span>
      </span>
    </div>
  )
}
