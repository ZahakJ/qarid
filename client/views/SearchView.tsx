/**
 * #/search — full-text search over the ديوان (design-ux.md §3 Search).
 *
 * The UNIT of an answer is the بيت. شعراء and قصائد still appear, but as two
 * quiet strips above the أبيات: someone typing «المتنبي» wants the شاعر, and
 * someone typing half a line wants the line.
 *
 * Three things this view must not get wrong:
 *
 *  1. THE HIGHLIGHT IS NOT RENDERED. `hit.highlight` is an FTS5 snippet of the
 *     NORMALIZED text — no tashkeel — so painting it would silently strip the
 *     vocalization. What we take from it is the »marked« WORDS, and
 *     `client/bayt/highlight.tsx` maps those back onto the ORIGINAL صدر/عجز
 *     through `foldedIndex`. The mark is a lapis UNDERLINE (amendment 14).
 *
 *  2. THE MODES ARE NOT THREE VALUES OF ONE PARAMETER. كلمات leaves `mode`
 *     UNSET, which is what arms the server's AND-then-OR fallback; أي كلمة pins
 *     `mode=or`; and عبارة is not a mode at all — it is QUOTING, `q="…"`, which
 *     `ftsQuery` turns into a phrase term. Because عبارة lives in the query
 *     string it round-trips through the URL for free.
 *
 *  3. `total` IS CAPPED at the server's bounded scan (SEARCH_SCAN_CAP = 400),
 *     so this view never computes `ceil(total/limit)` page numbers. «المزيد» +
 *     autoload until a page comes back empty is the pattern.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { search as searchApi } from "../api/queries.ts"
import { markedTerms } from "../bayt/highlight.tsx"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { ChipCloud } from "../components/ChipCloud.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { LetterGrid } from "../components/LetterGrid.tsx"
import { Omnibox } from "../components/Omnibox.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { useIntersection } from "../hooks/useIntersection.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { savedFromBait, useCollections } from "../store/collectionsStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { navigate, routeHash } from "../router.ts"
import { formatCount, formatPoems, formatResults } from "../../shared/format.ts"
import type { BaitHit, MetaResponse, PoemHit, PoetHit, SearchResponse } from "../../shared/schema.ts"
import { BaytCard, PoemRow, headingOf } from "./shared.tsx"
import { SEARCH_MODES, modeOfQuery, modeParam, queryFor, unquote, type SearchMode3 } from "./searchQuery.ts"

/** أبيات per page. The server caps a search page at 40. */
const SEARCH_PAGE = 20

/** How many pages a `?p=N` deep link replays on entry. */
const MAX_REPLAY_PAGES = 10

type Filters = { era?: string; meter?: string; rhyme?: string }

export function SearchView({ q, page }: { q: string; page: number }) {
  const settings = useSettings()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)

  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [res, setRes] = useState<SearchResponse | null>(null)
  const [baits, setBaits] = useState<BaitHit[]>([])
  const [pages, setPages] = useState(1)
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [mode, setMode] = useState<SearchMode3>(() => modeOfQuery(q))
  const [filters, setFilters] = useState<Filters>({})
  const [facetsOpen, setFacetsOpen] = useState(false)

  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // A new query from the URL re-decides the mode: a link carrying «…» is a
  // phrase search wherever it was pasted from.
  useEffect(() => setMode(modeOfQuery(q)), [q])

  useEffect(() => {
    const ac = new AbortController()
    loadMeta(ac.signal)
      .then((m) => !ac.signal.aborted && setMeta(m))
      .catch(() => {})
    return () => ac.abort()
  }, [])

  const sent = queryFor(q, mode)
  const filterKey = `${filters.era ?? ""}|${filters.meter ?? ""}|${filters.rhyme ?? ""}`
  const wanted = Math.min(Math.max(1, page), MAX_REPLAY_PAGES)

  const params = useCallback(
    (p: number) => ({
      q: sent,
      scope: "all" as const,
      page: p,
      limit: SEARCH_PAGE,
      ...(modeParam(mode) ? { mode: modeParam(mode)! } : {}),
      ...(filters.era ? { era: filters.era } : {}),
      ...(filters.meter ? { meter: filters.meter } : {}),
      ...(filters.rhyme ? { rhyme: filters.rhyme } : {}),
    }),
    [sent, mode, filters],
  )

  // ── the query itself ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!sent) {
      setRes(null)
      setBaits([])
      setError(null)
      return
    }
    const ac = new AbortController()
    setLoading(true)
    setError(null)
    setExhausted(false)
    Promise.all(Array.from({ length: wanted }, (_, i) => searchApi(params(i + 1), { signal: ac.signal })))
      .then((all) => {
        if (ac.signal.aborted) return
        const first = all[0]!
        setRes(first)
        setBaits(all.flatMap((r) => r.baits))
        setPages(wanted)
        setExhausted(all[all.length - 1]!.baits.length < SEARCH_PAGE)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر تنفيذ البحث", "/api/search"))
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- these four ARE the request identity
  }, [sent, mode, filterKey, wanted])

  const hasMore = Boolean(res) && !exhausted && baits.length > 0

  const fetchMore = useCallback(() => {
    if (loadingMore || loading || !hasMore) return
    const next = pages + 1
    setLoadingMore(true)
    searchApi(params(next))
      .then((r) => {
        setBaits((prev) => [...prev, ...r.baits])
        setPages(next)
        if (r.baits.length < SEARCH_PAGE) setExhausted(true)
        // `?p=` records the depth so a reload lands where the reader was.
        navigate({ view: "search", q, page: next }, true)
      })
      .catch(() => setExhausted(true))
      .finally(() => setLoadingMore(false))
  }, [loadingMore, loading, hasMore, pages, params, q])

  useIntersection(sentinelRef, fetchMore, { enabled: hasMore && !loading })

  const eraItems = useMemo(
    () => (meta?.eras ?? []).map((e) => ({ slug: e.slug, label: e.name })),
    [meta],
  )
  const meterItems = useMemo(
    () => (meta?.meters ?? []).filter((m) => m.kind === "bahr").map((m) => ({ slug: m.slug, label: m.name })),
    [meta],
  )
  // /api/search takes a رويّ but has no facet COUNTS of its own; the corpus-wide
  // per-letter tallies from /api/meta are the honest thing to show, and they are
  // what stops a letter with no قصائد at all from looking clickable.
  const rhymeCounts = useMemo(
    () => (meta?.letters ?? []).map((l) => ({ letter: l.letter, count: l.endsWith })),
    [meta],
  )

  const appliedCount = [filters.era, filters.meter, filters.rhyme].filter(Boolean).length
  const anyFilter = appliedCount > 0
  const terms = (hit: { highlight: string | null }) => markedTerms(hit.highlight)

  return (
    <div className="view search-view">
      <header className="view__head">
        <h1 className="view__title">البحث</h1>
      </header>

      <div className="search-bar">
        <Omnibox key={q} initial={unquote(q)} autoFocus={!q} />

        <div className="search-modes">
          <Segmented
            label="نمط البحث"
            value={mode}
            onChange={(m) => {
              setMode(m)
              // عبارة lives in the query string, so it must be written back to
              // the URL; the other two are pins on an unchanged query.
              const next = queryFor(q, m)
              if (next !== q) navigate({ view: "search", q: next, page: 1 }, true)
            }}
            options={SEARCH_MODES}
          />

          <div className="search-modes__side">
            {/* a control, so it is shaped like one: chrome, a caret, and the
                number of constraints it is hiding — it used to be bare text
                sitting beside the segmented control and reading as its label */}
            <button
              type="button"
              className="btn facet-toggle"
              aria-expanded={facetsOpen}
              onClick={() => setFacetsOpen((v) => !v)}
            >
              القيود
              {appliedCount > 0 ? <span className="facet-toggle__n">{formatCount(appliedCount)}</span> : null}
              <span className="facet-toggle__caret" aria-hidden="true">
                {facetsOpen ? "−" : "+"}
              </span>
            </button>
          </div>
        </div>

        {facetsOpen ? (
          <div className="search-facets">
            <div className="search-facet">
              <h2 className="facet-title">العصر</h2>
              <ChipCloud
                variant="asr"
                items={eraItems}
                active={filters.era}
                showCounts={false}
                onPick={(slug) => setFilters((f) => ({ ...f, era: slug }))}
              />
            </div>
            <div className="search-facet">
              <h2 className="facet-title">البحر</h2>
              <ChipCloud
                variant="bahr"
                items={meterItems}
                active={filters.meter}
                showCounts={false}
                onPick={(slug) => setFilters((f) => ({ ...f, meter: slug }))}
              />
            </div>
            <div className="search-facet">
              <h2 className="facet-title">القافية</h2>
              <LetterGrid
                label="القافية"
                counts={rhymeCounts.length > 0 ? rhymeCounts : null}
                active={filters.rhyme}
                showCounts={false}
                onPick={(l) => setFilters((f) => ({ ...f, rhyme: f.rhyme === l ? undefined : l }))}
              />
            </div>
            {anyFilter ? (
              <button type="button" className="btn btn--ghost" onClick={() => setFilters({})}>
                امسح القيود
              </button>
            ) : null}
          </div>
        ) : null}

        {/* The ledger line belongs to the RESULTS, so it sits at the foot of
            the bar and directly above the first one. Parked at the far end of
            the modes row it was 800px of empty column away from what it
            counted — the same mistake `.prow__n` in views.css carries a note
            about. */}
        {res ? (
          <p className="search-count">
            <span className="search-count__n">{formatResults(res.total)}</span>
            {res.ms > 0 ? (
              <>
                <span className="search-count__sep" aria-hidden="true">
                  ·
                </span>
                <span>
                  {/* ONLY the number gets the LTR isolate. Wrapping the whole
                      phrase in it made the Arabic words an LTR run too, so they
                      reordered and the reader got «مِلّي ثانية 6.1». */}
                  <span className="search-ms">{res.ms.toFixed(res.ms < 10 ? 1 : 0)}</span> مِلّي ثانية
                </span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* «لا نتيجة بكل الكلمات» — only when the OR pass genuinely widened it. */}
      {res && res.mode === "or" && mode !== "any" ? (
        <p className="search-note">لا نتيجة بكلّ الكلمات — هذه نتائجُ بعضِها.</p>
      ) : null}

      {error ? (
        <div className="view-error" role="alert">
          <p className="view-error__msg">{error.message}</p>
        </div>
      ) : !sent ? (
        <p className="view__lede">اكتب بيتًا، أو شطرًا منه، أو اسم شاعر. وضَعْ «…» حول العبارة لتُطلب كما هي.</p>
      ) : loading && baits.length === 0 ? (
        <BaytSkeleton rows={5} size={settings.verseSize} />
      ) : res && res.total === 0 ? (
        <EmptyState flavor="search-none">
          <p className="search-count">
            لا شيء يطابق «<bdi>{q}</bdi>»{anyFilter ? " على هذه القيود" : ""}.
          </p>
          {anyFilter ? (
            <button type="button" className="btn" onClick={() => setFilters({})}>
              امسح القيود
            </button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          {res && res.poets.length > 0 ? <PoetStrip poets={res.poets} /> : null}
          {res && res.poems.length > 0 ? <PoemStrip poems={res.poems} /> : null}

          {baits.length > 0 ? (
            <section className="search-group">
              <h2 className="section-title">
                <span>أبيات</span>
                <span className="section-title__n">{formatCount(baits.length)}</span>
              </h2>
              <div className="bayt-list" data-bayt-list="">
                {baits.map((b) => (
                  <BaytCard
                    key={b.baytKey}
                    bait={b}
                    size={settings.verseSize}
                    tashkeel={settings.tashkeel}
                    showRawiyy={settings.showRawiyy}
                    highlight={terms(b)}
                    favorite={favorites.some((f) => f.baytKey === b.baytKey)}
                    onFavorite={() => {
                      const now = toggleFavorite(savedFromBait(b))
                      toast(now ? "أُضيف إلى المختارات" : "أُزيل من المختارات", now ? "ok" : "info")
                    }}
                    onCopied={() => toast("نُسخ البيت", "ok")}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {hasMore ? (
            <div className="more-bar" ref={sentinelRef}>
              {loadingMore ? (
                <span className="more-bar__busy">…يُجلب المزيد</span>
              ) : (
                <button type="button" className="btn" onClick={fetchMore}>
                  المزيد
                </button>
              )}
            </div>
          ) : baits.length > 0 ? (
            <p className="more-bar__end">
              <Rule style={{ inlineSize: "min(14rem, 50%)" }} />
              انتهت النتائج
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}

/** شعراء whose name or ترجمة matched — a strip, not a list. */
function PoetStrip({ poets }: { poets: readonly PoetHit[] }) {
  return (
    <section className="search-group">
      <h2 className="section-title">
        <span>شعراء</span>
        <span className="section-title__n">{formatCount(poets.slice(0, 6).length)}</span>
      </h2>
      <div className="search-poets">
        {poets.slice(0, 6).map((p) => (
          <a className="search-poet" key={p.slug} href={routeHash({ view: "poet", slug: p.slug })}>
            <span className="search-poet__name">
              <bdi>{p.name}</bdi>
            </span>
            <span className="search-poet__n">{formatPoems(p.poemCount)}</span>
          </a>
        ))}
      </div>
    </section>
  )
}

/** قصائد whose عنوان or شاعر matched. */
function PoemStrip({ poems }: { poems: readonly PoemHit[] }) {
  const shown = poems.filter((p) => headingOf(p).text).slice(0, 5)
  if (shown.length === 0) return null
  return (
    <section className="search-group">
      <h2 className="section-title">
        <span>قصائد</span>
        <span className="section-title__n">{formatCount(shown.length)}</span>
      </h2>
      <div>
        {shown.map((p) => (
          <div className="prow-slot" key={p.id}>
            <PoemRow poem={p} />
          </div>
        ))}
      </div>
    </section>
  )
}
