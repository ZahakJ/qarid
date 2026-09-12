/**
 * `#/qafiya` — باحث القافية.
 *
 * Every other surface in قريض is built for someone READING the ديوان. This one
 * is built for someone WRITING: a poet with half a بيت and a روي to answer,
 * who wants to know what the فحول did with that letter before deciding what to
 * do with it himself. Same corpus, same `/api/baits` door التصفح uses in
 * بيت-mode — a different question asked of it.
 *
 * Three things follow from that and shape the whole screen.
 *
 * **The روي is the axis, not a facet.** It is the first thing on the page, as a
 * full 28-cell letter well, and nothing at all is fetched until one is chosen —
 * the tool has no meaning without it, and a default روي would be this page
 * answering a question nobody asked. البحر and العصر sit UNDER it as
 * narrowings, in that order, because that is the order the question is asked in
 * («على الراء… من الطويل… في العصر العباسي»).
 *
 * **The counts come from `/api/meta`, and they are the right counts.** Each
 * cell shows `letters[].endsWith` — how many playable أبيات END on that letter
 * — which `scripts/ingest/build.ts` derives as `COUNT(*) … GROUP BY rawiyy`
 * over `game_baits`, exactly what `/api/baits?rhyme=` then counts. So the
 * number on the cell and the number over the results agree by construction, and
 * the grid costs no request at all: `meta` is precomputed into `meta_json` at
 * ingest and the library store already holds it.
 *
 * **The list is fame-first and nothing else.** No sort control. A poet hunting
 * a قافية wants the lines that are ALREADY in the reader's ear first — that is
 * the whole value — and `/api/baits` orders by `gb.fame DESC` through the
 * `gb_chain(rawiyy, era_id, meter_id, …)` covering index: 10 ms for the fattest
 * روي on the real corpus. The narrowing chips carry no counts on purpose. They
 * would have to be counts of قصائد (that is what `/api/facets` returns) printed
 * beside a list of أبيات, and a number that answers a different question than
 * the one on screen is worse than no number.
 *
 * ── ON A PHONE the well FOLDS ────────────────────────────────────────────
 *
 * Four columns of twenty-eight wells is 945px tall on a 390 screen. Left inline
 * it would have stood between the poet and every answer they asked for, on
 * every look. So once a روي is chosen the whole well becomes one line — «الرويّ
 * ر الراء · غيِّر» — and the grid moves into a bottom sheet, which is the browse
 * rail's own answer to the identical problem. `well` is built ONCE and rendered
 * in whichever surface applies: two copies of a picker is two places to add the
 * next narrowing to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ApiError } from "../api/client.ts"
import { listBaits } from "../api/queries.ts"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { Chip } from "../components/Chip.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { LetterGrid } from "../components/LetterGrid.tsx"
import { PanelCorners, Rule, Shamsa } from "../components/Ornaments.tsx"
import { Sheet } from "../components/Sheet.tsx"
import { useIntersection } from "../hooks/useIntersection.ts"
import { useNativeChrome } from "../hooks/useNativeChrome.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { savedFromBait, useCollections } from "../store/collectionsStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { navigate, qafiyaQueryString, type QafiyaQuery } from "../router.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import { formatBaits } from "../../shared/format.ts"
import type { BaitDto, LetterFacet, MetaResponse } from "../../shared/schema.ts"
import { BaytCard } from "./shared.tsx"

/** One «المزيد» press, in أبيات. */
const QAFIYA_PAGE = 30

/** How many pages a `?p=N` deep link replays on entry (BrowseView's rule). */
const MAX_REPLAY_PAGES = 20

export function QafiyaView({ query }: { query: QafiyaQuery }) {
  const settings = useSettings()
  const native = useNativeChrome()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)

  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [baits, setBaits] = useState<BaitDto[]>([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const rawiyy = query.rawiyy
  // The three keys that ARE the request. `?p=` rides along so a shared link
  // comes back to the depth it was shared at.
  const hunt = qafiyaQueryString({ rawiyy: query.rawiyy, meter: query.meter, era: query.era })
  const wanted = Math.min(Math.max(1, query.page ?? 1), MAX_REPLAY_PAGES)

  useEffect(() => {
    const ac = new AbortController()
    loadMeta(ac.signal)
      .then((m) => !ac.signal.aborted && setMeta(m))
      .catch(() => {})
    return () => ac.abort()
  }, [])

  // ── the أبيات ────────────────────────────────────────────────────────────
  useEffect(() => {
    // Nothing is asked of the corpus until a روي is chosen. This is the one
    // place the page's shape and its network behaviour have to agree: an
    // unchosen روي is an invitation on screen, so it must be silence on the
    // wire too.
    if (!rawiyy) {
      setBaits([])
      setTotal(0)
      setPages(1)
      setError(null)
      setLoading(false)
      return
    }
    const ac = new AbortController()
    setLoading(true)
    setError(null)
    const wantPages = Array.from({ length: wanted }, (_, i) => i + 1)
    Promise.all(wantPages.map((p) => listBaits(paramsFor(query, p), { signal: ac.signal })))
      .then((results) => {
        if (ac.signal.aborted) return
        setBaits(results.flatMap((r) => r.items))
        setTotal(results[0]?.total ?? 0)
        setPages(wanted)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر جلب الأبيات", "/api/baits"))
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `hunt` IS the request identity
  }, [hunt, wanted])

  const loaded = baits.length
  const hasMore = loaded < total && loaded > 0

  const fetchMore = useCallback(() => {
    if (loadingMore || loading || !hasMore) return
    const next = pages + 1
    setLoadingMore(true)
    listBaits(paramsFor(query, next))
      .then((r) => {
        setBaits((prev) => [...prev, ...r.items])
        setPages(next)
        // Paging is not history — it is how far down the hunt the poet has read.
        navigate({ view: "qafiya", query: { ...query, page: next } }, true)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [loadingMore, loading, hasMore, pages, query])

  useIntersection(sentinelRef, fetchMore, { enabled: hasMore && !loading })

  /**
   * The cell numbers: أبيات that END on each letter, straight off `meta`. They
   * are the قافية supply of the whole playable ديوان, so they do NOT narrow
   * with the بحر and العصر chips — and that is right, because they are what the
   * poet is choosing BETWEEN. A grid that reshaped under the narrowings would
   * stop being a map of the alphabet (the browse rail's own rule).
   */
  const letterCounts = useMemo<LetterFacet[] | null>(
    () => meta?.letters.map((l) => ({ letter: l.letter, count: l.endsWith })) ?? null,
    [meta],
  )

  const buhur = useMemo(() => (meta?.meters ?? []).filter((m) => m.kind === "bahr"), [meta])
  const eras = useMemo(() => (meta?.eras ?? []).filter((e) => e.poemCount > 0), [meta])

  const go = (q: QafiyaQuery) => navigate({ view: "qafiya", query: q })
  /** Every change of the hunt drops `?p=` — a new hunt starts at its first بيت. */
  const set = <K extends keyof QafiyaQuery>(key: K, value: QafiyaQuery[K]) =>
    go({ ...query, [key]: query[key] === value ? undefined : value, page: undefined })

  const narrowed = Boolean(query.meter || query.era)
  // «على الراء», not «على راء» — the name of a letter is definite when you are
  // naming THE letter, and `LETTER_NAMES` holds the bare form because the
  // browse rail's `title` wants it bare. ال prefixes correctly onto all 28,
  // اللام included.
  const letterName = rawiyy ? `ال${LETTER_NAMES[rawiyy as HijaiLetter]}` : null
  const folded = native && Boolean(rawiyy)

  /** The picker itself — one set of nodes, rendered inline or inside a sheet. */
  const well = (
    <div className="qaf-picker">
      <div className="qaf-well__head">
        {/* شمسة and title on ONE line: as a grid row of its own the mark sat
            alone above the heading and read as a stray dot rather than as the
            illumination that opens it. */}
        <h2 className="qaf-well__title">
          <Shamsa size={13} />
          <span>الرويّ</span>
        </h2>
        <p className="qaf-well__note">تحت كلِّ حرفٍ عددُ ما في الديوان من أبياتٍ تنتهي إليه.</p>
      </div>

      <LetterGrid label="الرويّ" counts={letterCounts} active={rawiyy ?? null} onPick={(l) => set("rawiyy", l)} />

      {rawiyy ? (
        <>
          <Rule className="qaf-well__rule" />
          <div className="qaf-narrow">
            <div className="qaf-narrow__row">
              <span className="qaf-narrow__label">البحر</span>
              <div className="chip-cloud">
                {buhur.map((m) => (
                  <Chip
                    key={m.slug}
                    variant="bahr"
                    slug={m.slug}
                    label={m.name}
                    active={query.meter === m.slug}
                    onClick={() => set("meter", m.slug)}
                  />
                ))}
              </div>
            </div>
            <div className="qaf-narrow__row">
              <span className="qaf-narrow__label">العصر</span>
              <div className="chip-cloud">
                {eras.map((e) => (
                  <Chip
                    key={e.slug}
                    variant="asr"
                    label={e.name}
                    active={query.era === e.slug}
                    onClick={() => set("era", e.slug)}
                  />
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )

  return (
    <div className="view qaf-view">
      <header className="view__head">
        <h1 className="view__title">باحث القافية</h1>
        <p className="view__lede">اختر الرويّ، فنُريك ما قافاه به الفحول.</p>
      </header>

      {folded ? (
        <button type="button" className="qaf-chosen" onClick={() => setPickerOpen(true)}>
          <span className="qaf-chosen__letter" aria-hidden="true">
            {rawiyy}
          </span>
          <span className="qaf-chosen__text">
            <span className="qaf-chosen__name">{letterName}</span>
            <span className="qaf-chosen__note">
              {narrowed ? "الرويّ، مع تضييق" : "الرويّ المختار"}
            </span>
          </span>
          <span className="qaf-chosen__change">غيِّر</span>
        </button>
      ) : (
        <section className="qaf-well" aria-label="اختيار القافية">
          <PanelCorners size={16} />
          {well}
        </section>
      )}

      {/* ── the answer ─────────────────────────────────────────────────── */}
      {!rawiyy ? (
        <section className="qaf-invite">
          <Shamsa size={18} />
          <p className="qaf-invite__line">
            القافيةُ أوّلُ ما يُختار وآخِرُ ما يُقال. اختر حرفًا من الأعلى، ونَسوقُ إليك أشهرَ ما خُتم به.
          </p>
        </section>
      ) : error ? (
        <div className="view-error" role="alert">
          <p className="view-error__msg">{error.message}</p>
          <button type="button" className="btn" onClick={() => go({ ...query })}>
            أعد المحاولة
          </button>
        </div>
      ) : (
        <>
          <div className="qaf-count">
            <p className="qaf-count__line">
              {loading && loaded === 0
                ? "…"
                : total === 0
                  ? "لا شيء على هذه القيود."
                  : `${formatBaits(total)} على ${letterName} — والأشهرُ أوّلًا.`}
            </p>
            {narrowed ? (
              <button type="button" className="qaf-count__clear" onClick={() => go({ rawiyy: query.rawiyy })}>
                امسح التضييق
              </button>
            ) : null}
          </div>

          {loading && loaded === 0 ? (
            <BaytSkeleton rows={5} size={settings.verseSize} />
          ) : total === 0 ? (
            <EmptyState flavor="facets-zero" title="ما وجدنا قافيةً على هذا">
              {narrowed ? (
                <button type="button" className="btn" onClick={() => go({ rawiyy: query.rawiyy })}>
                  جرّب الرويّ وحده
                </button>
              ) : null}
            </EmptyState>
          ) : (
            <div className="bayt-list" data-bayt-list="">
              {baits.map((b) => (
                <BaytCard
                  key={b.baytKey}
                  bait={b}
                  size={settings.verseSize}
                  tashkeel={settings.tashkeel}
                  /* The lapis روي underline is ON here whatever the global
                     setting says. Everywhere else it is a reading aid the
                     reader opts into; on this page it is the answer — it marks
                     the very letter they came to look at, in every line. */
                  showRawiyy
                  favorite={favorites.some((f) => f.baytKey === b.baytKey)}
                  onFavorite={() => {
                    const now = toggleFavorite(savedFromBait(b))
                    toast(now ? "أُضيف إلى المختارات" : "أُزيل من المختارات", now ? "ok" : "info")
                  }}
                  onCopied={() => toast("نُسخ البيت", "ok")}
                />
              ))}
            </div>
          )}

          {hasMore ? (
            <div className="more-bar" ref={sentinelRef}>
              {loadingMore ? (
                <span className="more-bar__busy">…يُجلب المزيد</span>
              ) : (
                <button type="button" className="btn" onClick={fetchMore}>
                  المزيد — بقي {formatBaits(total - loaded)}
                </button>
              )}
            </div>
          ) : loaded > 0 && loaded >= total ? (
            <p className="more-bar__end">
              <Rule style={{ inlineSize: "min(14rem, 50%)" }} />
              انتهى ما على هذه القافية
            </p>
          ) : null}
        </>
      )}

      {folded && pickerOpen ? (
        <Sheet
          title="الرويّ"
          note="اختر حرفًا، أو ضيِّق ببحرٍ أو عصر — والأبيات تتبدّل تحتك."
          onClose={() => setPickerOpen(false)}
          footer={
            <div className="sheet__acts">
              <button type="button" className="btn btn--primary" onClick={() => setPickerOpen(false)}>
                أظهر الأبيات
                <span className="sheet__act-n">{formatBaits(total)}</span>
              </button>
            </div>
          }
        >
          {well}
        </Sheet>
      ) : null}
    </div>
  )
}

/** The hunt, as `/api/baits` takes it. */
function paramsFor(q: QafiyaQuery, page: number): Record<string, string | number | undefined> {
  return {
    rhyme: q.rawiyy,
    meter: q.meter,
    era: q.era,
    page,
    limit: QAFIYA_PAGE,
  }
}
