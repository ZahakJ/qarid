/**
 * #/poets — the شعراء index (design-ux.md §3 Poets, redesigned at v2.md §6).
 *
 * The v2 shape, top to bottom: a HERO whose medallion carries the active حرف
 * enlarged in Aref Ruqaa gold, the alphabet as a full-width RAIL under it, the
 * عصر strip with its counts, one context line saying what is being shown and
 * how it is sorted, and then the شعراء themselves grouped under حرف الشهرة.
 *
 * The rail moved from a 6.5rem column on the inline-end edge to a band across
 * the top for two reasons: twenty-eight letters read as an alphabet only when
 * they sit in one line, and the column was spending an eighth of the page's
 * width on a control the reader touches once.
 *
 * Three things this view does NOT do, on purpose:
 *  • it does not compute the grouping letter. `poets.letter` was written at
 *    ingest by `firstLetterOf(sortName(name))`, so المتنبي files under الميم
 *    and الأخطل under الألف; recomputing it here would be a second normalizer
 *    (CLAUDE.md invariant) and the two would drift on the first odd nisba.
 *  • it does not load all 6,941 شعراء. Pages of 100 arrive as the reader
 *    approaches the end, and the rendered rows are windowed on top of that —
 *    the list is long enough that both are needed.
 *  • it does not stagger more than eight entrances, and never staggers a row
 *    built mid-scroll — see `enterIndex` in ./poetsGrid.ts.
 *
 * `?era=` and `?letter=` are the URL's, not the store's. Picking a letter
 * narrows the query rather than merely scrolling: with 6,941 rows, scrolling to
 * a letter the reader has not loaded yet would just show them a gap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { listPoets } from "../api/queries.ts"
import { EmptyState } from "../components/EmptyState.tsx"
import { LetterRail } from "../components/LetterRail.tsx"
import { Shamsa } from "../components/Ornaments.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { useIntersection } from "../hooks/useIntersection.ts"
import { useMediaQuery, useNarrow } from "../hooks/useMediaQuery.ts"
import { useWindowedList } from "../hooks/useWindowedList.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { navigate } from "../router.ts"
import { HIJAI_LETTERS, LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import { formatCount, formatPoets } from "../../shared/format.ts"
import type { MetaResponse, PoetSummary, PoetsSort } from "../../shared/schema.ts"
import { enterIndex, gridRows, ROW_POET, ROW_POET_NARROW } from "./poetsGrid.ts"
import { PoetCard, RowSkeleton } from "./shared.tsx"

/** Poets per request. The server caps a list at 100. */
const PAGE = 100

/**
 * The step the LIST starts its entrance on. The four blocks above it — hero,
 * rail, عصر strip, context line — take steps 0…3, so the page arrives top
 * down; without the offset the first cards landed before the heading over
 * them. `enterIndex` clamps the whole thing to eight steps (v2.md §6).
 */
const LIST_STEP = 4

const SORTS: readonly { value: PoetsSort; label: string }[] = [
  { value: "name", label: "أبجديًّا" },
  { value: "poems", label: "الأكثر قصائد" },
  { value: "baits", label: "الأكثر أبياتًا" },
]

export function PoetsView({ era, letter }: { era?: string; letter?: string }) {
  const narrow = useNarrow()
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [items, setItems] = useState<PoetSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<PoetsSort>("name")
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [counts, setCounts] = useState<Map<string, number> | null>(null)

  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    loadMeta(ac.signal)
      .then((m) => !ac.signal.aborted && setMeta(m))
      .catch(() => {})
    return () => ac.abort()
  }, [])

  // ── first page whenever the query changes ────────────────────────────────
  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    setError(null)
    setItems([])
    setPage(1)
    listPoets({ era, letter, sort, page: 1, limit: PAGE }, { signal: ac.signal })
      .then((res) => {
        if (ac.signal.aborted) return
        setItems(res.items)
        setTotal(res.total)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر جلب الشعراء", "/api/poets"))
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
  }, [era, letter, sort])

  // ── the alphabet rail's counts ───────────────────────────────────────────
  //
  // There is no per-letter poet facet on the server, so the rail asks for 28
  // one-row pages and keeps their `total`s. Each is an indexed COUNT(*) on
  // `poets(letter, sort_key)` — under 2 ms apiece on the full corpus — and the
  // answer is cached per عصر, so the fan-out happens once per filter, not once
  // per render. The rail renders immediately and the numbers arrive under it.
  useEffect(() => {
    const ac = new AbortController()
    const cached = LETTER_COUNTS.get(era ?? "")
    if (cached) {
      setCounts(cached)
      return
    }
    setCounts(null)
    Promise.all(
      HIJAI_LETTERS.map((l) =>
        listPoets({ era, letter: l, limit: 1 }, { signal: ac.signal })
          .then((r) => [l, r.total] as const)
          .catch(() => [l, 0] as const),
      ),
    )
      .then((pairs) => {
        if (ac.signal.aborted) return
        const m = new Map<string, number>(pairs)
        LETTER_COUNTS.set(era ?? "", m)
        setCounts(m)
      })
      .catch(() => {})
    return () => ac.abort()
  }, [era])

  const fetchMore = useCallback(() => {
    if (loadingMore || loading || items.length >= total) return
    setLoadingMore(true)
    listPoets({ era, letter, sort, page: page + 1, limit: PAGE })
      .then((res) => {
        setItems((prev) => [...prev, ...res.items])
        setPage((p) => p + 1)
        setTotal(res.total)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [loadingMore, loading, items.length, total, era, letter, sort, page])

  useIntersection(sentinelRef, fetchMore, { enabled: items.length < total && !loading })

  // ── sections ─────────────────────────────────────────────────────────────
  // Grouping only makes sense under the alphabetical sort; by قصائد the reader
  // is asking for a ranking, and headings would cut it into meaningless pieces.
  //
  // The grid is folded into ROWS of `cols` cards before windowing, so the
  // window maths stays what `useWindowedList` promises: a fixed row height and
  // a pure function. A letter heading occupies one full row, which is also what
  // makes it read as a section break rather than a label.
  const mid = useMediaQuery("(max-width: 1080px)")
  const cols = narrow ? 1 : mid ? 2 : 3
  const grouped = sort === "name"
  const allRows = useMemo(() => gridRows(items, cols, grouped), [items, cols, grouped])
  // The FIRST heading is lifted out of the windowed list and rendered above it.
  // Inside the list it would have to be a full row like every other — 188px of
  // it, directly under the toolbar — and the first شاعر would open below the
  // fold. Every later heading keeps its row, where that same height is the
  // break between two sections and is exactly what it is for.
  const leadHead = allRows[0]?.kind === "head" ? allRows[0] : null
  const rows = leadHead ? allRows.slice(1) : allRows
  const rowHeight = narrow ? ROW_POET_NARROW : ROW_POET
  const { ref: listRef, window: win } = useWindowedList(rows.length, rowHeight)

  const eras = meta?.eras ?? []
  const activeEra = era ? eras.find((e) => e.slug === era) : undefined
  const activeLetter = letter && (HIJAI_LETTERS as readonly string[]).includes(letter) ? (letter as HijaiLetter) : null
  const filtered = Boolean(era || letter)

  const go = (next: { era?: string; letter?: string }) =>
    navigate({ view: "poets", ...(next.era ? { era: next.era } : {}), ...(next.letter ? { letter: next.letter } : {}) })

  return (
    <div className="view poets-view">
      {/* ── hero: the active حرف, enlarged, in Aref Ruqaa gold ───────────── */}
      <header className="poets-hero" data-enter="rise" style={enterStep(0)}>
        <div className="poets-hero__text">
          <h1 className="view__title poets-hero__title">الشعراء</h1>
          <p className="view__lede">
            {loading && items.length === 0
              ? "…"
              : `${formatPoets(total)} — مرتَّبون على حرف الشهرة، فالمتنبي في الميم والأخطل في الألف.`}
          </p>
        </div>

        <div className="medallion medallion--hero" data-enter="illuminate" style={enterStep(1)}>
          <span className="medallion__ring" aria-hidden="true" />
          {activeLetter ? (
            <span className="medallion__ch" aria-hidden="true">
              {activeLetter}
            </span>
          ) : (
            <span className="medallion__shamsa" aria-hidden="true">
              <Shamsa size={44} />
            </span>
          )}
          <span className="medallion__cap">
            {activeLetter ? LETTER_NAMES[activeLetter] : "كل الحروف"}
          </span>
        </div>
      </header>

      {/* ── the alphabet, as one band ────────────────────────────────────── */}
      <div className="poets-rail" data-enter="rise" style={enterStep(1)}>
        <LetterRail counts={counts} active={letter} onPick={(l) => go({ era, letter: l })} />
      </div>

      {/* ── العصر, with counts ───────────────────────────────────────────── */}
      <div className="era-strip" role="group" aria-label="العصر" data-enter="rise" style={enterStep(2)}>
        <button
          type="button"
          className="era-chip"
          data-active={era ? undefined : "1"}
          aria-pressed={era ? false : true}
          onClick={() => go({ letter })}
        >
          <span className="era-chip__name">كل العصور</span>
        </button>
        {eras.map((e) => (
          <button
            key={e.slug}
            type="button"
            className="era-chip"
            data-active={era === e.slug ? "1" : undefined}
            aria-pressed={era === e.slug}
            onClick={() => go({ era: era === e.slug ? undefined : e.slug, letter })}
          >
            <span className="era-chip__name">{e.name}</span>
            <span className="era-chip__n">{formatCount(e.poetCount)}</span>
          </button>
        ))}
      </div>

      {/* ── what is on screen, and in what order ─────────────────────────── */}
      <div className="poets-context" data-enter="rise" style={enterStep(3)}>
        <p className="poets-context__what">
          {loading && items.length === 0 ? "…" : formatPoets(total)}
          {activeLetter ? <span className="poets-context__where"> في {LETTER_NAMES[activeLetter]}</span> : null}
          {activeEra ? <span className="poets-context__where"> من {activeEra.name}</span> : null}
        </p>
        <span className="poets-context__rule" aria-hidden="true" data-enter="draw" style={enterStep(3)} />
        {filtered ? (
          <button type="button" className="btn btn--ghost poets-context__clear" onClick={() => go({})}>
            امسح القيود
          </button>
        ) : null}
        <Segmented label="الترتيب" value={sort} onChange={setSort} options={SORTS} />
      </div>

      <div className="poets-main">
        {leadHead && !error && !(loading && items.length === 0) ? (
          <LetterHead letter={leadHead.letter} count={counts?.get(leadHead.letter)} lead step={LIST_STEP} />
        ) : null}
        {error ? (
          <div className="view-error" role="alert">
            <p className="view-error__msg">{error.message}</p>
            <button type="button" className="btn" onClick={() => navigate({ view: "poets" })}>
              أعد المحاولة
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <RowSkeleton rows={6} height={rowHeight} />
        ) : items.length === 0 ? (
          <EmptyState flavor="facets-zero" title="لا شاعر بهذه القيود">
            <button type="button" className="btn" onClick={() => navigate({ view: "poets" })}>
              امسح الكل
            </button>
          </EmptyState>
        ) : (
          <div className="vlist" ref={listRef}>
            {win.padStart > 0 ? <div style={{ blockSize: `${win.padStart}px` }} aria-hidden="true" /> : null}
            {rows.slice(win.start, win.end).map((row, i) =>
              row.kind === "head" ? (
                <LetterHead
                  key={`h-${row.letter}`}
                  letter={row.letter}
                  count={counts?.get(row.letter)}
                  blockSize={rowHeight}
                  step={enterIndex(i + LIST_STEP, win.start)}
                />
              ) : (
                <div
                  className="pcard-row"
                  key={row.poets[0]!.slug}
                  data-enter="rise"
                  style={{
                    blockSize: `${rowHeight}px`,
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    ...enterStep(enterIndex(i + LIST_STEP, win.start)),
                  }}
                >
                  {row.poets.map((p) => (
                    <PoetCard poet={p} key={p.slug} />
                  ))}
                </div>
              ),
            )}
            {win.padEnd > 0 ? <div style={{ blockSize: `${win.padEnd}px` }} aria-hidden="true" /> : null}
          </div>
        )}

        {items.length > 0 && items.length < total ? (
          <div className="more-bar" ref={sentinelRef}>
            {loadingMore ? (
              <span className="more-bar__busy">…يُجلب المزيد</span>
            ) : (
              <button type="button" className="btn" onClick={fetchMore}>
                المزيد — بقي {formatPoets(total - items.length)}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** One letter section heading: the medallion, the letter's name, its count,
 *  and the dissolving rule that runs off the end of the line. */
function LetterHead({
  letter,
  count,
  blockSize,
  lead = false,
  step = 0,
}: {
  letter: HijaiLetter
  count?: number
  /** the windowed row height, when this heading is a row of the list */
  blockSize?: number
  /** the first heading, which sits above the list rather than inside it */
  lead?: boolean
  step?: number
}) {
  return (
    <h2
      className={lead ? "letter-head letter-head--lead" : "letter-head"}
      data-enter="rise"
      style={{ ...(blockSize ? { blockSize: `${blockSize}px` } : {}), ...enterStep(step) }}
    >
      <span className="medallion medallion--head">
        <span className="medallion__ring" aria-hidden="true" />
        <span className="medallion__ch" aria-hidden="true">
          {letter}
        </span>
      </span>
      <span className="letter-head__name">{LETTER_NAMES[letter]}</span>
      {count ? <span className="letter-head__n">{formatPoets(count)}</span> : null}
      <span className="letter-head__rule" aria-hidden="true" />
    </h2>
  )
}

/** One step of the entrance stagger, as the custom property motion.css reads. */
function enterStep(i: number): React.CSSProperties {
  return { "--enter-i": i } as React.CSSProperties
}

/** Per-عصر cache of the 28 letter counts, so the fan-out runs once. */
const LETTER_COUNTS = new Map<string, Map<string, number>>()
