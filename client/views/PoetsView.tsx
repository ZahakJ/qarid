/**
 * #/poets — the شعراء index (design-ux.md §3 Poets).
 *
 * Shape: a sticky عصر chip strip, an alphabet rail, and then the شعراء
 * themselves grouped under حرف الشهرة headings.
 *
 * Two things this view does NOT do, on purpose:
 *  • it does not compute the grouping letter. `poets.letter` was written at
 *    ingest by `firstLetterOf(sortName(name))`, so المتنبي files under الميم
 *    and الأخطل under الألف; recomputing it here would be a second normalizer
 *    (CLAUDE.md invariant) and the two would drift on the first odd nisba.
 *  • it does not load all 6,997 شعراء. Pages of 100 arrive as the reader
 *    approaches the end, and the rendered rows are windowed on top of that —
 *    the list is long enough that both are needed.
 *
 * `?era=` and `?letter=` are the URL's, not the store's. Picking a letter
 * narrows the query rather than merely scrolling: with 6,997 rows, scrolling to
 * a letter the reader has not loaded yet would just show them a gap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { listPoets } from "../api/queries.ts"
import { ChipCloud } from "../components/ChipCloud.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { LetterRail } from "../components/LetterRail.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { useIntersection } from "../hooks/useIntersection.ts"
import { useMediaQuery, useNarrow } from "../hooks/useMediaQuery.ts"
import { useWindowedList } from "../hooks/useWindowedList.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { navigate } from "../router.ts"
import { HIJAI_LETTERS, LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import { formatCount, formatPoets } from "../../shared/format.ts"
import type { MetaResponse, PoetSummary, PoetsSort } from "../../shared/schema.ts"
import { PoetCard, ROW_POET, ROW_POET_NARROW, RowSkeleton } from "./shared.tsx"

/** Poets per request. The server caps a list at 100. */
const PAGE = 100

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
  const mid = useMediaQuery("(max-width: 1180px)")
  const cols = narrow ? 1 : mid ? 2 : 3
  const rows = useMemo(() => gridRows(items, cols, sort === "name"), [items, cols, sort])
  const rowHeight = narrow ? ROW_POET_NARROW : ROW_POET
  const { ref: listRef, window: win } = useWindowedList(rows.length, rowHeight)

  const eraItems = (meta?.eras ?? []).map((e) => ({ slug: e.slug, label: e.name, count: e.poetCount }))

  return (
    <div className="view poets-view">
      <header className="view__head">
        <h1 className="view__title">الشعراء</h1>
        <p className="view__lede">
          {loading && items.length === 0 ? "…" : `${formatPoets(total)} — مرتَّبون على حرف الشهرة، فالمتنبي في الميم والأخطل في الألف.`}
        </p>
      </header>

      <div className="poets-filters">
        <ChipCloud
          variant="asr"
          items={eraItems}
          active={era}
          onPick={(slug) => navigate({ view: "poets", ...(slug ? { era: slug } : {}), ...(letter ? { letter } : {}) })}
        />
        <Segmented label="الترتيب" value={sort} onChange={setSort} options={SORTS} />
      </div>

      <div className="poets-shell">
        <LetterRail
          counts={counts}
          active={letter}
          onPick={(l) => navigate({ view: "poets", ...(era ? { era } : {}), ...(l ? { letter: l } : {}) })}
        />

        <div className="poets-main">
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
              <button
                type="button"
                className="btn"
                onClick={() => navigate({ view: "poets" })}
              >
                امسح الكل
              </button>
            </EmptyState>
          ) : (
            <div className="vlist" ref={listRef}>
              {win.padStart > 0 ? <div style={{ blockSize: `${win.padStart}px` }} aria-hidden="true" /> : null}
              {rows.slice(win.start, win.end).map((row) =>
                row.kind === "head" ? (
                  <h2 className="letter-head" key={`h-${row.letter}`} style={{ blockSize: `${rowHeight}px` }}>
                    <span className="letter-head__ch">{row.letter}</span>
                    <span className="letter-head__name">{LETTER_NAMES[row.letter]}</span>
                    <Rule />
                  </h2>
                ) : (
                  <div
                    className="pcard-row"
                    key={row.poets[0]!.slug}
                    style={{ blockSize: `${rowHeight}px`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
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
    </div>
  )
}

/** Per-عصر cache of the 28 letter counts, so the fan-out runs once. */
const LETTER_COUNTS = new Map<string, Map<string, number>>()

type Row = { kind: "head"; letter: HijaiLetter } | { kind: "poets"; poets: PoetSummary[] }

/**
 * Cards folded into rows of `cols`, with a heading row inserted whenever the
 * شهرة letter changes. A section never continues on the previous section's
 * row — a half-full row before a heading is correct, not a bug.
 */
export function gridRows(items: readonly PoetSummary[], cols: number, grouped: boolean): Row[] {
  const width = Math.max(1, Math.floor(cols))
  const out: Row[] = []
  let current: string | null = null
  let bucket: PoetSummary[] = []

  const flush = () => {
    if (bucket.length > 0) out.push({ kind: "poets", poets: bucket })
    bucket = []
  }

  for (const poet of items) {
    if (grouped && poet.letter !== current) {
      flush()
      current = poet.letter
      out.push({ kind: "head", letter: poet.letter })
    }
    bucket.push(poet)
    if (bucket.length === width) flush()
  }
  flush()
  return out
}
