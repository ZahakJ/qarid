/**
 * #/browse — faceted browsing (design-ux.md §3 Browse).
 *
 * The URL owns the facet state outright; this view is a projection of it. Every
 * chip writes a new hash, and a reload or a shared link lands on exactly the
 * same page — which is also why the «المزيد» pages are recorded as `?p=`.
 *
 * Layout: a sticky facet rail on the inline-start edge, five accordions —
 * العصر · البحر · الغرض · الروي · حرف البداية — the last two as 7×4 letter
 * grids. Counts come from one `/api/facets?<query>` per facet change, and a
 * value at zero is DISABLED, never hidden: a rail that reshapes as you filter
 * stops being a map of the corpus.
 *
 * The unit of the result changes with the query. With a روي or a حرف بداية
 * applied the reader is asking about LINES, so the list becomes أبيات served by
 * /api/baits and rendered as BaytPlates; otherwise it is قصائد. `isBaytMode` in
 * ./browseQuery.ts is the single place that decides.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { listBaits, listPoems } from "../api/queries.ts"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { Chip } from "../components/Chip.tsx"
import { ChipCloud } from "../components/ChipCloud.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { LetterGrid } from "../components/LetterGrid.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { useIntersection } from "../hooks/useIntersection.ts"
import { useKeyboard } from "../hooks/useKeyboard.ts"
import { useNarrow } from "../hooks/useMediaQuery.ts"
import { useWindowedList } from "../hooks/useWindowedList.ts"
import { loadFacets, loadMeta } from "../store/libraryStore.ts"
import { savedFromBait, useCollections } from "../store/collectionsStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { browseQueryString, navigate, type BrowseQuery, type BrowseSort } from "../router.ts"
import { formatBaits, formatCount, formatPoems } from "../../shared/format.ts"
import type { BaitDto, FacetsResponse, MetaResponse, PoemSummary } from "../../shared/schema.ts"
import {
  BROWSE_PAGE,
  BROWSE_SORTS,
  FACET_KEYS,
  FACET_LABEL,
  appliedChips,
  clearFacets,
  facetParams,
  hasFacets,
  isBaytMode,
  listParams,
  withFacet,
  type FacetKey,
} from "./browseQuery.ts"
import { BaytCard, PoemRow, ROW_POEM, ROW_POEM_NARROW, RowSkeleton, themeLabel } from "./shared.tsx"

/** How many pages a `?p=N` deep link will replay on entry. */
const MAX_REPLAY_PAGES = 20

export function BrowseView({ query }: { query: BrowseQuery }) {
  const settings = useSettings()
  const narrow = useNarrow()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)
  const isFavorite = (k: string) => favorites.some((f) => f.baytKey === k)

  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [facets, setFacets] = useState<FacetsResponse | null>(null)
  const [poems, setPoems] = useState<PoemSummary[]>([])
  const [baits, setBaits] = useState<BaitDto[]>([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [culprits, setCulprits] = useState<FacetKey[] | null>(null)
  const [railOpen, setRailOpen] = useState(false)

  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // The facet state alone — page and sort excluded, so paging does not refetch
  // the facet counts and a sort change does not reset the rail.
  const facetKey = browseQueryString({ ...facetsOnly(query) })
  const sortKey = query.sort ?? "fame"
  const baytMode = isBaytMode(query)

  useEffect(() => {
    const ac = new AbortController()
    loadMeta(ac.signal)
      .then((m) => !ac.signal.aborted && setMeta(m))
      .catch(() => {})
    return () => ac.abort()
  }, [])

  // ── facet counts ─────────────────────────────────────────────────────────
  useEffect(() => {
    const ac = new AbortController()
    loadFacets(facetParams(query), ac.signal)
      .then((f) => !ac.signal.aborted && setFacets(f))
      .catch(() => {})
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- facetKey IS the query's facet identity
  }, [facetKey])

  // ── results ──────────────────────────────────────────────────────────────
  const wanted = Math.min(Math.max(1, query.page ?? 1), MAX_REPLAY_PAGES)

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setError(null)
    setCulprits(null)
    const wantPages = Array.from({ length: wanted }, (_, i) => i + 1)

    const fetchPage = (p: number) =>
      baytMode
        ? listBaits(listParams(query, p), { signal: ac.signal }).then((r) => ({ items: r.items, total: r.total }))
        : listPoems(listParams(query, p), { signal: ac.signal }).then((r) => ({ items: r.items, total: r.total }))

    Promise.all(wantPages.map(fetchPage))
      .then((results) => {
        if (ac.signal.aborted) return
        const items: (BaitDto | PoemSummary)[] = results.flatMap((r) => r.items as (BaitDto | PoemSummary)[])
        setTotal(results[0]?.total ?? 0)
        setPages(wanted)
        if (baytMode) {
          setBaits(items as BaitDto[])
          setPoems([])
        } else {
          setPoems(items as PoemSummary[])
          setBaits([])
        }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر جلب النتائج", "/api/poems"))
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the three keys ARE the request identity
  }, [facetKey, sortKey, baytMode, wanted])

  const loaded = baytMode ? baits.length : poems.length
  const hasMore = loaded < total && loaded > 0

  const fetchMore = useCallback(() => {
    if (loadingMore || loading || !hasMore) return
    const next = pages + 1
    setLoadingMore(true)
    const req = baytMode
      ? listBaits(listParams(query, next)).then((r) => r.items as (BaitDto | PoemSummary)[])
      : listPoems(listParams(query, next)).then((r) => r.items as (BaitDto | PoemSummary)[])
    req
      .then((items) => {
        if (baytMode) setBaits((prev) => [...prev, ...(items as BaitDto[])])
        else setPoems((prev) => [...prev, ...(items as PoemSummary[])])
        setPages(next)
        // `?p=` records how far the reader has paged, so a reload or a shared
        // link comes back to the same depth. replace: paging is not history.
        navigate({ view: "browse", query: { ...query, page: next } }, true)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [loadingMore, loading, hasMore, pages, baytMode, query])

  useIntersection(sentinelRef, fetchMore, { enabled: hasMore && !loading })

  // ── which chip emptied the combination ───────────────────────────────────
  //
  // Only asked when there is nothing to show, and answered exactly: one count
  // request per applied facet with that facet removed. The facet response
  // cannot answer it — each dimension there drops ITSELF, so with three chips
  // applied every number is the same zero.
  useEffect(() => {
    if (loading || total > 0 || !hasFacets(query)) return
    const ac = new AbortController()
    const applied = FACET_KEYS.filter((k) => query[k] !== undefined)
    Promise.all(
      applied.map((k) => {
        const without = withFacet(query, k, undefined)
        const probe = isBaytMode(without)
          ? listBaits({ ...facetParams(without), limit: 1 }, { signal: ac.signal })
          : listPoems({ ...facetParams(without), limit: 1 }, { signal: ac.signal })
        return probe.then((r) => [k, r.total] as const).catch(() => [k, 0] as const)
      }),
    )
      .then((pairs) => {
        if (ac.signal.aborted) return
        setCulprits(pairs.filter(([, n]) => n > 0).map(([k]) => k))
      })
      .catch(() => {})
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- facetKey IS the query's facet identity
  }, [loading, total, facetKey])

  // ← next page, → previous — mirrored under RTL (amendments §15).
  useKeyboard({
    keys: {
      ArrowLeft: () => hasMore && fetchMore(),
      ArrowRight: () => window.scrollTo({ top: 0, behavior: "smooth" }),
    },
  })

  const rowHeight = narrow ? ROW_POEM_NARROW : ROW_POEM
  const { ref: listRef, window: win } = useWindowedList(poems.length, rowHeight)

  const themeDisplay = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of meta?.themes ?? []) m.set(t.slug, t.display)
    return m
  }, [meta])

  const chips = appliedChips(query, meta)
  const go = (q: BrowseQuery) => navigate({ view: "browse", query: q })
  const pick = (key: FacetKey) => (value: string | undefined) => go(withFacet(query, key, value))

  return (
    <div className="view browse-view">
      <header className="view__head browse-head">
        <div>
          <h1 className="view__title">التصفح</h1>
          <p className="view__lede">
            {loading && loaded === 0
              ? "…"
              : baytMode
                ? `${formatBaits(total)} على هذه القيود`
                : `${formatPoems(total)} على هذه القيود`}
          </p>
        </div>
        <div className="browse-tools">
          {baytMode ? null : (
            <Segmented
              label="الترتيب"
              value={(query.sort ?? "fame") as BrowseSort}
              onChange={(sort) => go({ ...query, sort, page: undefined })}
              options={BROWSE_SORTS}
            />
          )}
          <button type="button" className="btn btn--ghost browse-rail-toggle" onClick={() => setRailOpen((v) => !v)}>
            {railOpen ? "إخفاء القيود" : "القيود"}
          </button>
        </div>
      </header>

      {chips.length > 0 ? (
        <div className="applied" role="group" aria-label="القيود المطبَّقة">
          {chips.map((c) => (
            <button
              key={`${c.key}:${c.value}`}
              type="button"
              className="applied__chip"
              data-kind={c.kind}
              onClick={() => go(withFacet(query, c.key, undefined))}
              aria-label={`أزِل ${c.label}`}
            >
              <span>{c.label}</span>
              <span className="applied__x" aria-hidden="true">
                ✕
              </span>
            </button>
          ))}
          <button type="button" className="applied__clear" onClick={() => go(clearFacets(query))}>
            امسح الكل
          </button>
        </div>
      ) : null}

      <div className="browse-shell" data-rail-open={railOpen ? "1" : undefined}>
        {/* ── the facet rail ───────────────────────────────────────────── */}
        <aside className="facet-rail" aria-label="القيود">
          <Accordion label={FACET_LABEL.era} open count={facets?.eras.filter((e) => e.count > 0).length}>
            <ChipCloud
              variant="asr"
              items={(facets?.eras ?? meta?.eras.map((e) => ({ slug: e.slug, name: e.name, count: e.poemCount })) ?? []).map((e) => ({
                slug: e.slug,
                label: e.name,
                count: e.count,
              }))}
              active={query.era}
              onPick={pick("era")}
            />
          </Accordion>

          <Accordion label={FACET_LABEL.meter} open count={facets?.meters.filter((m) => m.count > 0).length}>
            <ChipCloud
              variant="bahr"
              items={(facets?.meters ?? []).map((m) => ({ slug: m.slug, label: m.name, count: m.count }))}
              active={query.meter}
              onPick={pick("meter")}
            />
          </Accordion>

          <Accordion label={FACET_LABEL.theme} open={Boolean(query.theme)}>
            <ChipCloud
              variant="gharad"
              /* the two buckets قصيرة/عامة are not أغراض (amendments §11) — they
                 stay reachable by URL but never appear as a chip */
              items={(facets?.themes ?? [])
                .filter((t) => meta?.themes.find((x) => x.slug === t.slug)?.kind !== "bucket")
                .map((t) => ({ slug: t.slug, label: themeDisplay.get(t.slug) ?? t.name, count: t.count }))}
              active={query.theme}
              onPick={pick("theme")}
            />
          </Accordion>

          <Accordion label={FACET_LABEL.rawiyy} open={Boolean(query.rawiyy)}>
            <LetterGrid label="الروي" counts={facets?.rhymes ?? null} active={query.rawiyy} onPick={(l) => pick("rawiyy")(l)} />
          </Accordion>

          <Accordion label={FACET_LABEL.letter} open={Boolean(query.letter)}>
            <LetterGrid
              label="حرف البداية"
              counts={facets?.firstLetters ?? null}
              active={query.letter}
              onPick={(l) => pick("letter")(l)}
            />
          </Accordion>
        </aside>

        {/* ── results ──────────────────────────────────────────────────── */}
        <div className="browse-main">
          {error ? (
            <p className="view__lede">{error.message}</p>
          ) : loading && loaded === 0 ? (
            baytMode ? (
              <BaytSkeleton rows={6} size={settings.verseSize} />
            ) : (
              <RowSkeleton rows={8} height={rowHeight} />
            )
          ) : total === 0 ? (
            <EmptyState flavor="facets-zero">
              {culprits && culprits.length > 0 ? (
                <div className="empty__hints">
                  <p className="empty__hint">جرّب إزالة:</p>
                  <div className="chip-cloud">
                    {culprits.map((k) => (
                      <Chip
                        key={k}
                        variant="asr"
                        label={`${FACET_LABEL[k]}: ${chips.find((c) => c.key === k)?.label ?? query[k]}`}
                        onClick={() => go(withFacet(query, k, undefined))}
                      />
                    ))}
                  </div>
                </div>
              ) : hasFacets(query) ? (
                <button type="button" className="btn" onClick={() => go(clearFacets(query))}>
                  امسح الكل
                </button>
              ) : null}
            </EmptyState>
          ) : baytMode ? (
            <div className="bayt-list" data-bayt-list="">
              {baits.map((b) => (
                <BaytCard
                  key={b.baytKey}
                  bait={b}
                  size={settings.verseSize}
                  tashkeel={settings.tashkeel}
                  showRawiyy={settings.showRawiyy}
                  numerals={settings.numerals}
                  favorite={isFavorite(b.baytKey)}
                  onFavorite={() => {
                    const now = toggleFavorite(savedFromBait(b))
                    toast(now ? "أُضيف إلى المختارات" : "أُزيل من المختارات", now ? "ok" : "info")
                  }}
                  onCopied={() => toast("نُسخ البيت", "ok")}
                />
              ))}
            </div>
          ) : (
            <div className="vlist" ref={listRef}>
              {win.padStart > 0 ? <div style={{ blockSize: `${win.padStart}px` }} aria-hidden="true" /> : null}
              {poems.slice(win.start, win.end).map((p) => (
                <div className="prow-slot" key={p.id} style={{ blockSize: `${rowHeight}px` }}>
                  <PoemRow poem={p} theme={themeLabel(meta, p.theme)} />
                </div>
              ))}
              {win.padEnd > 0 ? <div style={{ blockSize: `${win.padEnd}px` }} aria-hidden="true" /> : null}
            </div>
          )}

          {hasMore ? (
            <div className="more-bar" ref={sentinelRef}>
              {loadingMore ? (
                <span className="more-bar__busy">…يُجلب المزيد</span>
              ) : (
                <button type="button" className="btn" onClick={fetchMore}>
                  المزيد — بقي {formatCount(total - loaded)} {baytMode ? "بيتًا" : "قصيدة"}
                </button>
              )}
            </div>
          ) : loaded > 0 && loaded >= total ? (
            <p className="more-bar__end">
              <Rule style={{ inlineSize: "min(14rem, 50%)" }} />
              انتهى ما على هذه القيود
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** Only the facet keys — the identity a fetch depends on. */
function facetsOnly(q: BrowseQuery): BrowseQuery {
  const out: BrowseQuery = {}
  for (const k of FACET_KEYS) {
    const v = q[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * One accordion of the rail.
 *
 * `open` is the DEFAULT, not the state: العصر and البحر arrive open because a
 * rail of five closed drawers tells a first-time reader nothing about what the
 * ديوان can be cut by, and a facet that is APPLIED opens itself for the same
 * reason — the reader must be able to see, and undo, what they chose. Once
 * they touch a header, their choice wins for the rest of the visit.
 */
function Accordion({
  label,
  open,
  count,
  children,
}: {
  label: string
  open: boolean
  count?: number
  children: React.ReactNode
}) {
  const [manual, setManual] = useState<boolean | null>(null)
  const isOpen = manual ?? open
  return (
    <section className="facet" data-open={isOpen ? "1" : undefined}>
      <button
        type="button"
        className="facet__head"
        aria-expanded={isOpen}
        onClick={() => setManual(!isOpen)}
      >
        <span className="facet__label">{label}</span>
        {count !== undefined ? <span className="facet__n">{formatCount(count)}</span> : null}
        <span className="facet__caret" aria-hidden="true">
          {isOpen ? "−" : "+"}
        </span>
      </button>
      {isOpen ? <div className="facet__body">{children}</div> : null}
    </section>
  )
}
