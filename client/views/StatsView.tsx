/**
 * #/stats — إحصاءات الديوان (design-ux.md §8, v1.5 «simple»).
 *
 * Everything here comes from ONE request. `/api/stats` is read straight out of
 * `meta.stats_json`, computed once at ingest, so this page costs 0.3 ms on the
 * full corpus and there is no reason to compute anything client-side beyond the
 * bar widths.
 *
 * Every bar is a LINK into #/browse with the matching facet applied — a chart
 * you cannot click is a poster, and the point of showing the reader that
 * الطويل holds a fifth of the corpus is to let them go and read it.
 */
import { useEffect, useState } from "react"
import { ApiError } from "../api/client.ts"
import { getStats } from "../api/queries.ts"
import { Rule } from "../components/Ornaments.tsx"
import { routeHash, type BrowseQuery } from "../router.ts"
import { formatCount, formatNumber, histogramLabel } from "../../shared/format.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import { themeBySlug } from "../../shared/themes.ts"
import type { StatsResponse } from "../../shared/schema.ts"

/** How many rows each breakdown shows before it stops being a chart. */
const TOP = 12

export function StatsView() {
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    getStats({ signal: ac.signal })
      .then((s) => !ac.signal.aborted && setStats(s))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر جلب الإحصاءات", "/api/stats"))
      })
    return () => ac.abort()
  }, [])

  if (error) {
    return (
      <div className="view stats-view">
        <h1 className="view__title">إحصاءات الديوان</h1>
        <div className="view-error" role="alert">
          <p className="view-error__msg">{error.message}</p>
          <a className="btn" href={routeHash({ view: "home" })}>
            إلى الديوان
          </a>
        </div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="view stats-view">
        <h1 className="view__title">إحصاءات الديوان</h1>
        <div className="stat-tiles" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span className="skeleton" key={i} style={{ blockSize: "5.5rem" }} />
          ))}
        </div>
      </div>
    )
  }

  const meters = [...stats.meters].filter((m) => m.kind === "bahr").sort((a, b) => b.poems - a.poems).slice(0, TOP)
  const eras = [...stats.eras].sort((a, b) => a.sort - b.sort)
  // `stats.themes` carries the RAW name («قصيدة مدح»); the display form and the
  // bucket flag are the static table in shared/themes.ts, so no second request.
  const themes = [...stats.themes]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP)
    .map((t) => {
      const row = themeBySlug(t.slug)
      return { ...t, label: row?.display ?? t.name, bucket: row?.kind === "bucket" }
    })
  const rhymes = [...stats.rhymes].sort((a, b) => b.count - a.count)

  return (
    <div className="view stats-view">
      <header className="view__head">
        <h1 className="view__title">إحصاءات الديوان</h1>
        <p className="view__lede">
          ما في هذا الديوان، معدودًا. كلّ عمودٍ رابط: اضغطه لتقرأ ما تحته.
        </p>
      </header>

      <div className="stat-tiles">
        <Tile n={stats.counts.poems} cap="قصيدة" />
        <Tile n={stats.counts.baits} cap="بيتًا" />
        <Tile n={stats.counts.poets} cap="شاعرًا" />
        <Tile n={stats.counts.gameBaits} cap="بيتًا صالحًا للمساجلة" />
      </div>

      <Bars
        title="البحور"
        rows={meters.map((m) => ({ key: m.slug, label: m.name, n: m.poems, query: { meter: m.slug } }))}
      />
      <Bars
        title="الأعصر"
        rows={eras.map((e) => ({ key: e.slug, label: e.name, n: e.poems, query: { era: e.slug } }))}
      />
      <Bars
        title="الأغراض"
        /* the two buckets are counted here — a quarter of the corpus is not
           invisible — but named for what they are, not as أغراض */
        rows={themes.map((t) => ({
          key: t.slug,
          label: t.bucket ? `${t.label} (بلا غرض)` : t.label,
          n: t.count,
          query: { theme: t.slug },
        }))}
      />
      <Bars
        title="القوافي"
        rows={rhymes.map((r) => ({
          key: r.letter,
          label: `${r.letter} — ${LETTER_NAMES[r.letter as HijaiLetter] ?? r.letter}`,
          n: r.count,
          query: { rawiyy: r.letter },
        }))}
      />
      <Bars
        title="أطوال القصائد"
        rows={stats.poemLengths.map((b) => ({ key: b.label, label: histogramLabel(b), n: b.count, ltr: true }))}
      />

      <section className="rule-sec">
        <h2 className="section-title">أغزر الشعراء</h2>
        <Rule />
        <div className="search-poets">
          {stats.topPoets.slice(0, 12).map((p) => (
            <a className="search-poet" key={p.slug} href={routeHash({ view: "poet", slug: p.slug })}>
              <span className="search-poet__name">
                <bdi>{p.name}</bdi>
              </span>
              <span className="search-poet__n">{formatCount(p.poemCount)}</span>
            </a>
          ))}
        </div>
      </section>

      <p className="fav-note">
        بناء الديوان <span className="build-id">{stats.buildId}</span>
      </p>
    </div>
  )
}

function Tile({ n, cap }: { n: number; cap: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile__n">{formatNumber(n)}</span>
      <span className="stat-tile__cap">{cap}</span>
    </div>
  )
}

type BarRow = {
  key: string
  label: string
  n: number
  query?: BrowseQuery
  /**
   * `2–3` is two numbers around a NEUTRAL dash: in an RTL paragraph the dash
   * takes the paragraph direction and the range renders back to front («3–2»).
   * Its own LTR run is the fix (amendments §15) — and it is still the fix with
   * Western digits, because it is the DASH that is neutral, not the digits.
   */
  ltr?: boolean
}

/**
 * A breakdown as proportional bars. Scaled to the LARGEST row rather than to
 * the total: with 28 قوافي and a long tail, scaling to the sum makes every bar
 * a hairline and says nothing.
 */
function Bars({ title, rows }: { title: string; rows: BarRow[] }) {
  if (rows.length === 0) return null
  const max = Math.max(...rows.map((r) => r.n), 1)
  return (
    <section className="rule-sec">
      <h2 className="section-title">{title}</h2>
      <Rule />
      <div className="bars">
        {rows.map((r) => {
          // The track is scaled into 82% of the meter so its own number always
          // has room at the tip; the proportions are linear through zero, so
          // the bars still read against one another exactly as before.
          const share = `${Math.max(0.8, (r.n / max) * 82)}%`
          const bar = (
            <>
              <span className="bar__label">{r.ltr ? <bdi dir="ltr">{r.label}</bdi> : r.label}</span>
              <span className="bar__meter">
                <span className="bar__track" style={{ inlineSize: share }}>
                  <span className="bar__fill" style={{ inlineSize: "100%" }} />
                </span>
                <span className="bar__n">{formatCount(r.n)}</span>
              </span>
            </>
          )
          return r.query ? (
            <a className="bar" key={r.key} href={routeHash({ view: "browse", query: r.query })}>
              {bar}
            </a>
          ) : (
            <div className="bar" key={r.key}>
              {bar}
            </div>
          )
        })}
      </div>
    </section>
  )
}
