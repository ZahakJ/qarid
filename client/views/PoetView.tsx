/**
 * #/poet/<slug> — one شاعر (design-ux.md §3 Poet).
 *
 * Header (name in Aref Ruqaa, عصر, بلد) → ترجمة clamped to five lines with
 * «المزيد» → the signature بيت as a framed plate → a toolbar of sort orders and
 * بحر/غرض/قافية chips SCOPED TO THIS POET with their counts → the ديوان itself,
 * windowed.
 *
 * The ديوان rows show the مطلع when a قصيدة is untitled, which is the common
 * case in this corpus rather than the exception — `headingOf` in ./shared.tsx
 * is the single place that decides it.
 *
 * `/api/poets/:slug` already carries the first page of the ديوان and all three
 * chip breakdowns, so an unfiltered visit costs exactly one request; changing a
 * chip or a sort switches to `/api/poets/:slug/poems`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { listPoetPoems } from "../api/queries.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { Breadcrumbs, type Crumb } from "../components/Breadcrumbs.tsx"
import { Chip } from "../components/Chip.tsx"
import { ChipCloud } from "../components/ChipCloud.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { useIntersection } from "../hooks/useIntersection.ts"
import { useNarrow } from "../hooks/useMediaQuery.ts"
import { useWindowedList } from "../hooks/useWindowedList.ts"
import { loadMeta, loadPoet } from "../store/libraryStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { routeHash } from "../router.ts"
import { formatBaits, formatCount, formatPoems } from "../../shared/format.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import type { MetaResponse, PoemSummary, PoemsSort, PoetPageResponse } from "../../shared/schema.ts"
import { PoemRow, ROW_POEM, ROW_POEM_NARROW, RowSkeleton, themeLabel } from "./shared.tsx"

const PAGE = 100

/** The sorts a ديوان offers. `poet` and `title` mean nothing inside one poet. */
const SORTS: readonly { value: PoemsSort; label: string }[] = [
  { value: "fame", label: "الأشهر" },
  { value: "length", label: "الأطول" },
  { value: "title", label: "أبجديًّا" },
]

type Filters = { meter?: string; theme?: string; rhyme?: string }

export function PoetView({ slug }: { slug: string }) {
  const settings = useSettings()
  const narrow = useNarrow()
  const [data, setData] = useState<PoetPageResponse | null>(null)
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [filters, setFilters] = useState<Filters>({})
  const [sort, setSort] = useState<PoemsSort>("fame")
  const [poems, setPoems] = useState<PoemSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [bioOpen, setBioOpen] = useState(false)

  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    setData(null)
    setError(null)
    setFilters({})
    setSort("fame")
    setBioOpen(false)
    loadPoet(slug, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return
        setData(res)
        setPoems(res.poems)
        setTotal(res.poemsTotal)
        setPage(1)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر جلب الشاعر", slug))
      })
    loadMeta(ac.signal)
      .then((m) => !ac.signal.aborted && setMeta(m))
      .catch(() => {})
    return () => ac.abort()
  }, [slug])

  const pristine = sort === "fame" && !filters.meter && !filters.theme && !filters.rhyme

  // A filtered or re-sorted ديوان is a different list; the untouched one is
  // already in `data.poems` and must not cost a second request.
  useEffect(() => {
    if (!data || pristine) return
    const ac = new AbortController()
    setLoadingList(true)
    listPoetPoems(slug, { ...filters, sort, page: 1, limit: PAGE }, { signal: ac.signal })
      .then((res) => {
        if (ac.signal.aborted) return
        setPoems(res.items)
        setTotal(res.total)
        setPage(1)
      })
      .catch(() => {})
      .finally(() => {
        if (!ac.signal.aborted) setLoadingList(false)
      })
    return () => ac.abort()
  }, [slug, data, pristine, filters, sort])

  // Back to the untouched view: restore the page the detail response carried.
  useEffect(() => {
    if (!data || !pristine) return
    setPoems(data.poems)
    setTotal(data.poemsTotal)
    setPage(1)
  }, [data, pristine])

  const fetchMore = useCallback(() => {
    if (loadingMore || loadingList || poems.length >= total) return
    setLoadingMore(true)
    listPoetPoems(slug, { ...filters, sort, page: page + 1, limit: PAGE })
      .then((res) => {
        setPoems((prev) => [...prev, ...res.items])
        setPage((p) => p + 1)
        setTotal(res.total)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [loadingMore, loadingList, poems.length, total, slug, filters, sort, page])

  useIntersection(sentinelRef, fetchMore, { enabled: poems.length < total && !loadingList })

  const rowHeight = narrow ? ROW_POEM_NARROW : ROW_POEM
  const { ref: listRef, window: win } = useWindowedList(poems.length, rowHeight)

  const themeDisplay = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of meta?.themes ?? []) m.set(t.slug, t.display)
    return m
  }, [meta])

  if (error) {
    return (
      <div className="view">
        <h1 className="view__title">{error.status === 404 ? "لا شاعر بهذا الاسم" : "تعذّر جلب الشاعر"}</h1>
        {error.status === 404 ? null : <p className="view__lede">{error.message}</p>}
        <a className="btn" href={routeHash({ view: "poets" })}>
          إلى فهرس الشعراء
        </a>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="view poet-view">
        <span className="skeleton" style={{ inlineSize: "16rem", blockSize: "2rem" }} />
        <Rule />
        <RowSkeleton rows={6} height={rowHeight} />
      </div>
    )
  }

  const poet = data.poet
  const crumbs: Crumb[] = [{ label: "الشعراء", route: { view: "poets" } }]
  if (poet.era) crumbs.push({ label: poet.era.name, route: { view: "poets", era: poet.era.slug } })
  crumbs.push({ label: poet.name })

  const setFilter = (key: keyof Filters) => (value: string | undefined) =>
    setFilters((f) => ({ ...f, [key]: value }))

  const anyFilter = Boolean(filters.meter || filters.theme || filters.rhyme)

  return (
    <div className="view poet-view">
      <Breadcrumbs items={crumbs} />

      <header className="poet-head">
        <h1 className="poet-name">
          <bdi>{poet.name}</bdi>
        </h1>
        <div className="poet-badges">
          {poet.era ? (
            <a className="badge-link" href={routeHash({ view: "poets", era: poet.era.slug })}>
              <Chip variant="asr" label={poet.era.name} />
            </a>
          ) : null}
          {poet.location ? <Chip variant="gharad" label={poet.location} /> : null}
          <span className="poet-count">
            {formatPoems(poet.poemCount)} · {formatBaits(poet.baitCount)}
          </span>
        </div>

        {poet.description ? (
          <div className="poet-bio">
            <p className={bioOpen ? "poet-bio__text poet-bio__text--open" : "poet-bio__text"}>{poet.description}</p>
            <button type="button" className="btn btn--ghost" onClick={() => setBioOpen((v) => !v)}>
              {bioOpen ? "أقلّ" : "المزيد"}
            </button>
          </div>
        ) : null}
      </header>

      {data.signatureBait ? (
        <section className="poet-signature" aria-label="بيت مختار">
          <BaytPlate
            variant="plate"
            size="md"
            sadr={data.signatureBait.sadr}
            ajuz={data.signatureBait.ajuz}
            rawiyy={data.signatureBait.rawiyy}
            showRawiyy={settings.showRawiyy}
            tashkeel={settings.tashkeel}
            label="البيت المختار"
            meta={
              <a
                className="hero__poem"
                href={routeHash({ view: "poem", id: data.signatureBait.poem.id, bayt: data.signatureBait.position })}
              >
                القصيدة ←
              </a>
            }
          />
        </section>
      ) : null}

      <section className="poet-toolbar" aria-label="ترتيب الديوان وتصفيته">
        <Segmented label="الترتيب" value={sort} onChange={setSort} options={SORTS} />
        {anyFilter ? (
          <button type="button" className="btn btn--ghost" onClick={() => setFilters({})}>
            امسح القيود
          </button>
        ) : null}
      </section>

      <div className="poet-facets">
        {data.meters.length > 1 ? (
          <div className="poet-facet">
            <h2 className="facet-title">البحر</h2>
            <ChipCloud
              variant="bahr"
              items={data.meters.map((m) => ({ slug: m.slug, label: m.name, count: m.count }))}
              active={filters.meter}
              onPick={setFilter("meter")}
            />
          </div>
        ) : null}
        {data.themes.length > 1 ? (
          <div className="poet-facet">
            <h2 className="facet-title">الغرض</h2>
            <ChipCloud
              variant="gharad"
              items={data.themes.map((t) => ({ slug: t.slug, label: themeDisplay.get(t.slug) ?? t.name, count: t.count }))}
              active={filters.theme}
              onPick={setFilter("theme")}
            />
          </div>
        ) : null}
        {data.rhymes.length > 1 ? (
          <div className="poet-facet">
            <h2 className="facet-title">القافية</h2>
            <div className="chip-cloud">
              {data.rhymes.map((r) => (
                <Chip
                  key={r.letter}
                  variant="rawiyy"
                  label={r.letter}
                  active={filters.rhyme === r.letter}
                  title={`${LETTER_NAMES[r.letter as HijaiLetter] ?? r.letter} — ${formatCount(r.count)}`}
                  onClick={() => setFilter("rhyme")(filters.rhyme === r.letter ? undefined : r.letter)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="poet-diwan">
        <h2 className="section-title">
          الديوان <span className="section-title__n">{formatPoems(total)}</span>
        </h2>
        <Rule />

        {loadingList ? (
          <RowSkeleton rows={6} height={rowHeight} />
        ) : poems.length === 0 ? (
          <EmptyState flavor="facets-zero" title="لا قصيدة بهذه القيود">
            <button type="button" className="btn" onClick={() => setFilters({})}>
              امسح القيود
            </button>
          </EmptyState>
        ) : (
          <div className="vlist" ref={listRef}>
            {win.padStart > 0 ? <div style={{ blockSize: `${win.padStart}px` }} aria-hidden="true" /> : null}
            {poems.slice(win.start, win.end).map((p) => (
              <div className="prow-slot" key={p.id} style={{ blockSize: `${rowHeight}px` }}>
                <PoemRow poem={p} showPoet={false} theme={themeLabel(meta, p.theme)} />
              </div>
            ))}
            {win.padEnd > 0 ? <div style={{ blockSize: `${win.padEnd}px` }} aria-hidden="true" /> : null}
          </div>
        )}

        {poems.length > 0 && poems.length < total ? (
          <div className="more-bar" ref={sentinelRef}>
            {loadingMore ? (
              <span className="more-bar__busy">…يُجلب المزيد</span>
            ) : (
              <button type="button" className="btn" onClick={fetchMore}>
                المزيد — بقي {formatCount(total - poems.length)} قصيدة
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
