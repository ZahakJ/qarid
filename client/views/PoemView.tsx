/**
 * #/poem/<id> — the crown jewel (design-ux.md §3 Poem, amendments.md §12).
 *
 * What this view owes the reader:
 *  • the قصيدة as a printed ديوان page: two hemistichs on the outer margins,
 *    a quiet centre channel, بيت numbers in Arabic-Indic in the inline-start
 *    margin. All of that lives in BaytPlate — this file never lays out verse.
 *  • its identity: عنوان or مطلع, the شاعر, breadcrumbs, and the four badges
 *    (بحر with its تفعيلات, قافية, عصر, غرض) plus the بيت count.
 *  • control over the reading itself: تشكيل (only offered when the قصيدة has
 *    any), إظهار الروي, حجم الخط — all persisted in `qarid:v1:settings` — and
 *    نسخ القصيدة.
 *  • `?bayt=N`: page forward until that بيت is loaded, scroll to it, pulse twice.
 *  • the long-poem strategy: `content-visibility:auto` per row, NOT
 *    virtualization, so Ctrl+F, text selection and anchors keep working on the
 *    11,608-hemistich قصيدة (amendments.md §12). Pages of 300 أبيات arrive
 *    from /api/poems/:id/baits as the reader approaches the end.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { BaitDto, PoemDetailResponse, PoemSummary } from "../../shared/schema.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { COPY_MODES, formatBayt, formatBaytWithPoet, formatPoem, writeClipboard, type CopyMode } from "../bayt/copy.ts"
import { formatBaits, toArabicDigits } from "../../shared/format.ts"
import { displayText, displayTextOrNull } from "../bayt/tashkeel.ts"
import { Breadcrumbs, type Crumb } from "../components/Breadcrumbs.tsx"
import { Chip } from "../components/Chip.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { bahrBySlug } from "../data/buhur.ts"
import { ApiError } from "../api/client.ts"
import { getPoemBaits } from "../api/queries.ts"
import { cachePoemBaits, loadPoem, loadSimilarPoems } from "../store/libraryStore.ts"
import { savedFromBait, useCollections } from "../store/collectionsStore.ts"
import { useKeyboard } from "../hooks/useKeyboard.ts"
import { openShareCard } from "../share/ShareDialog.tsx"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { routeHash } from "../router.ts"
import { headingOf, showsRhyme } from "./shared.tsx"

/** One page of أبيات; the server caps this at LIMITS.maxBaitsLimit. */
const PAGE = 300
/** Guard on «نسخ القصيدة» / a deep link into a monstrous قصيدة. */
const MAX_AUTO_PAGES = 40

/* `headingOf` / `showsRhyme` live in ./shared.tsx: the poem page, the browse
 * results, a poet's ديوان and the favourites list must all decide "عنوان or
 * مطلع?" and "may this قصيدة claim a قافية?" the same way. */

export function PoemView({ id, bayt }: { id: string; bayt?: number }) {
  const settings = useSettings()
  const favorites = useCollections((s) => s.favorites)
  const isFavorite = (k: string) => favorites.some((f) => f.baytKey === k)
  const [data, setData] = useState<PoemDetailResponse | null>(null)
  const [baits, setBaits] = useState<BaitDto[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [similar, setSimilar] = useState<PoemSummary[]>([])
  const [pulse, setPulse] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [copyMenu, setCopyMenu] = useState<{ bait: BaitDto; x: number; y: number } | null>(null)
  const [meterOpen, setMeterOpen] = useState(false)

  const listRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const jumped = useRef<string>("")

  const total = data?.total ?? 0
  const loaded = baits.length
  const hasMore = loaded < total

  // ── the قصيدة ────────────────────────────────────────────────────────────
  useEffect(() => {
    const ac = new AbortController()
    setData(null)
    setBaits([])
    setError(null)
    setSimilar([])
    setPulse(null)
    jumped.current = ""
    loadPoem(id, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return
        setData(res)
        setBaits(res.baits)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر جلب القصيدة", id))
      })
    return () => ac.abort()
  }, [id])

  // ── «قصائد على الوزن والقافية» (amendments.md §9) ────────────────────────
  useEffect(() => {
    if (!data) return
    const ac = new AbortController()
    loadSimilarPoems(id, 8, ac.signal)
      .then((res) => {
        if (!ac.signal.aborted) setSimilar(res.items)
      })
      .catch(() => {
        /* a missing «شبيهات» rail is not worth an error state */
      })
    return () => ac.abort()
  }, [id, data])

  /** Append the next page of أبيات. Returns the new full list. */
  const loadMore = useCallback(
    async (current: BaitDto[]): Promise<BaitDto[]> => {
      const res = await getPoemBaits(id, { offset: current.length, limit: PAGE })
      const next = [...current, ...res.items]
      cachePoemBaits(id, next)
      return next
    },
    [id],
  )

  const fetchMore = useCallback(() => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    loadMore(baits)
      .then((next) => setBaits(next))
      .catch(() => toast("تعذّر جلب بقية الأبيات", "danger"))
      .finally(() => setLoadingMore(false))
  }, [loadingMore, hasMore, baits, loadMore])

  // Autoload as the reader nears the end — a «المزيد» button is still rendered
  // for keyboard and for browsers with the observer disabled.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || typeof IntersectionObserver !== "function") return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fetchMore()
      },
      { rootMargin: "800px 0px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, fetchMore])

  // ── `?bayt=N`: page forward until it exists, then scroll + pulse ─────────
  useEffect(() => {
    if (!data || !bayt) return
    const key = `${id}:${bayt}`
    if (jumped.current === key) return
    if (bayt > total) {
      jumped.current = key
      return
    }
    if (loaded < bayt) {
      if (!loadingMore && loaded / PAGE < MAX_AUTO_PAGES) fetchMore()
      return
    }
    jumped.current = key
    const el = document.getElementById(anchorId(bayt))
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" })
      el.focus({ preventScroll: true })
    }
    setPulse(bayt)
  }, [data, bayt, id, total, loaded, loadingMore, fetchMore])

  // The pulse lives on its own clock: the jump effect re-runs whenever another
  // page lands, and a cleanup there would cancel the animation mid-beat.
  useEffect(() => {
    if (pulse === null) return
    const t = setTimeout(() => setPulse(null), 2000)
    return () => clearTimeout(t)
  }, [pulse])

  // ── copy menu dismissal ─────────────────────────────────────────────────
  useEffect(() => {
    if (!copyMenu) return
    const close = () => setCopyMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    window.addEventListener("pointerdown", close)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("pointerdown", close)
      window.removeEventListener("keydown", onKey)
    }
  }, [copyMenu])

  const poem = data?.poem
  const poet = data?.poet

  /** Load every remaining بيت — «نسخ القصيدة» has to copy the whole thing. */
  const ensureAll = useCallback(async (): Promise<BaitDto[]> => {
    let current = baits
    let pages = 0
    while (current.length < total && pages < MAX_AUTO_PAGES) {
      current = await loadMore(current)
      pages++
    }
    setBaits(current)
    return current
  }, [baits, total, loadMore])

  const copyWholePoem = useCallback(() => {
    if (!poem || !poet) return
    void ensureAll()
      .then((all) =>
        writeClipboard(
          formatPoem({
            title: headingOf(poem).text,
            poet: poet.name,
            baits: all.map((b) => ({
              sadr: displayText(b.sadr, settings.tashkeel),
              ajuz: displayTextOrNull(b.ajuz, settings.tashkeel),
            })),
          }),
        ),
      )
      .then((ok) => toast(ok ? "نُسخت القصيدة" : "تعذّر النسخ", ok ? "ok" : "danger"))
      .catch(() => toast("تعذّر النسخ", "danger"))
  }, [poem, poet, ensureAll, settings.tashkeel])

  const runCopy = useCallback(
    (mode: CopyMode, b: BaitDto) => {
      setCopyMenu(null)
      if (!poem || !poet) return
      const sadr = displayText(b.sadr, settings.tashkeel)
      const ajuz = displayTextOrNull(b.ajuz, settings.tashkeel)
      if (mode === "poem") {
        copyWholePoem()
        return
      }
      const text =
        mode === "bayt-poet"
          ? formatBaytWithPoet(sadr, ajuz, poet.name, headingOf(poem).isMatla ? null : poem.title)
          : formatBayt(sadr, ajuz)
      void writeClipboard(text).then((ok) => toast(ok ? "نُسخ البيت" : "تعذّر النسخ", ok ? "ok" : "danger"))
    },
    [poem, poet, settings.tashkeel, copyWholePoem],
  )

  /* المختارات live in `qarid:v1:favorites`, not in this component: a ♥ that
   * only lives until the reader navigates away is a lie, and #/favorites reads
   * the same store the search results and بيت اليوم write to. */
  const toggleFavorite = useCallback(
    (b: BaitDto) => {
      const title = poem ? headingOf(poem).text : null
      const on = useCollections.getState().toggle(savedFromBait(b, title))
      toast(on ? "أُضيف إلى المختارات" : "أُزيل من المختارات", on ? "ok" : "info")
    },
    [poem],
  )

  /** بطاقة البيت — opens the card dialog: preview, shape, then save or share. */
  const runCard = useCallback(
    (b: BaitDto) => {
      if (!poet) return
      openShareCard({
        sadr: displayText(b.sadr, settings.tashkeel),
        ajuz: displayTextOrNull(b.ajuz, settings.tashkeel),
        poet: poet.name,
        poem: poem && !headingOf(poem).isMatla ? poem.title : null,
      })
    },
    [poem, poet, settings.tashkeel],
  )

  // ── the keymap of the قصيدة (client/data/shortcuts.ts, scope "poem") ────
  // BaytPlate already owns j/k/c/f/s ON A FOCUSED ROW — every بيت row is
  // `tabindex=0` and handles them itself. What was missing is the way IN:
  // until something focuses a row, every one of those keys is dead, and
  // nothing on the page focuses one for you. So this view adds exactly two
  // things and duplicates none: j/k as the entry point when no بيت has focus
  // yet, and `t`, which is a page-level setting no row can own.
  const enterList = useCallback(
    (from: "first" | "last") => {
      const box = listRef.current
      if (!box) return
      const rows = [...box.querySelectorAll<HTMLElement>("[data-bayt-row]")]
      const row = from === "first" ? rows[0] : rows[rows.length - 1]
      if (!row) return
      row.focus()
      row.scrollIntoView({ block: "center", behavior: "smooth" })
    },
    [],
  )

  /** True while a بيت row (or something inside one) holds focus. */
  const inList = () => (document.activeElement as HTMLElement | null)?.closest?.("[data-bayt-row]") != null

  useKeyboard({
    keys: {
      j: () => {
        if (!inList()) enterList("first")
      },
      k: () => {
        if (!inList()) enterList("last")
      },
      t: () => {
        if (data?.hasTashkeel) settings.patch({ tashkeel: !settings.tashkeel })
      },
    },
  })

  // ── states ──────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="view poem-view">
        <div className="poem-error">
          <h1 className="view__title">{error.status === 404 ? "لا قصيدة بهذا الرقم" : "تعذّر جلب القصيدة"}</h1>
          {/* the headline already says it on a 404; anything else the server
              had to add would only repeat it */}
          {error.status === 404 ? null : <p className="view__lede">{error.message}</p>}
          <a className="btn" href={routeHash({ view: "home" })}>
            إلى الديوان
          </a>
        </div>
      </div>
    )
  }

  if (!poem || !poet) {
    return (
      <div className="view poem-view">
        <div className="poem-head">
          <span className="skeleton" style={{ inlineSize: "14rem", blockSize: "1.6rem" }} />
        </div>
        <Rule />
        <BaytSkeleton rows={7} size={settings.verseSize} />
      </div>
    )
  }

  const heading = headingOf(poem)
  const meter = poem.meter
  const bahr = bahrBySlug(meter?.slug)
  const crumbs: Crumb[] = [{ label: "الشعراء", route: { view: "poets" } }]
  if (poem.era) crumbs.push({ label: poem.era.name, route: { view: "poets", era: poem.era.slug } })
  crumbs.push({ label: poet.name, route: { view: "poet", slug: poet.slug } })
  crumbs.push({ label: heading.isMatla ? "القصيدة" : heading.text })

  return (
    <div className="view poem-view">
      <Breadcrumbs items={crumbs} />

      <header className="poem-head">
        <h1 className={heading.isMatla ? "poem-title poem-title--matla" : "poem-title"}>
          <bdi>{heading.text}</bdi>
        </h1>
        <p className="poem-byline">
          <a className="poem-byline__poet" href={routeHash({ view: "poet", slug: poet.slug })}>
            <bdi>{poet.name}</bdi>
          </a>
          {poet.era ? <span className="poem-byline__sep"> · </span> : null}
          {poet.era ? <span>{poet.era.name}</span> : null}
        </p>

        <div className="poem-badges">
          {meter ? (
            <span className="popover-anchor">
              <Chip
                variant="bahr"
                slug={meter.slug}
                label={meter.variant ? `${meter.name} (${meter.variant})` : meter.name}
                active={meterOpen}
                title="التفعيلات"
                onClick={() => setMeterOpen((v) => !v)}
              />
              {meterOpen ? (
                <MeterPopover
                  name={meter.name}
                  variant={meter.variant}
                  tafilat={bahr?.tafilat ?? null}
                  miftah={bahr?.miftah ?? null}
                  slug={meter.slug}
                  onClose={() => setMeterOpen(false)}
                />
              ) : null}
            </span>
          ) : null}

          {showsRhyme(poem) && poem.rhyme ? (
            <a
              className="badge-link"
              href={routeHash({ view: "browse", query: { rawiyy: poem.rhyme } })}
              title={`القافية: ${letterName(poem.rhyme)}`}
            >
              <Chip variant="rawiyy" label={poem.rhyme} />
            </a>
          ) : null}

          {poem.era ? (
            <a className="badge-link" href={routeHash({ view: "browse", query: { era: poem.era.slug } })}>
              <Chip variant="asr" label={poem.era.name} />
            </a>
          ) : null}

          {poem.theme ? (
            <a className="badge-link" href={routeHash({ view: "browse", query: { theme: poem.theme.slug } })}>
              <Chip variant="gharad" label={poem.theme.display} />
            </a>
          ) : null}

          <span className="poem-count">{formatBaits(total)}</span>
        </div>
      </header>

      <Rule />

      <div className="poem-toolbar" role="toolbar" aria-label="أدوات القراءة">
        {data.hasTashkeel ? (
          <button
            type="button"
            className="btn btn--ghost"
            aria-pressed={settings.tashkeel}
            onClick={() => settings.patch({ tashkeel: !settings.tashkeel })}
          >
            تشكيل
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--ghost"
          aria-pressed={settings.showRawiyy}
          onClick={() => settings.patch({ showRawiyy: !settings.showRawiyy })}
        >
          إظهار الروي
        </button>
        <Segmented
          label="حجم الخط"
          value={settings.verseSize}
          onChange={(verseSize) => settings.patch({ verseSize })}
          options={[
            { value: "sm", label: "صغير" },
            { value: "md", label: "وسط" },
            { value: "lg", label: "كبير" },
          ]}
        />
        <button type="button" className="btn" onClick={copyWholePoem}>
          نسخ القصيدة
        </button>
      </div>

      <div className="bayt-list" data-bayt-list="" ref={listRef}>
        {baits.map((b) => (
          <BaytPlate
            key={b.baytKey}
            sadr={b.sadr}
            ajuz={b.ajuz}
            rawiyy={b.rawiyy}
            number={b.position}
            numerals={settings.numerals}
            size={settings.verseSize}
            tashkeel={settings.tashkeel}
            showRawiyy={settings.showRawiyy}
            anchorId={anchorId(b.position)}
            pulse={pulse === b.position}
            label={`البيت ${toArabicDigits(b.position)}`}
            favorite={isFavorite(b.baytKey)}
            onFavorite={() => toggleFavorite(b)}
            onCard={() => runCard(b)}
            duelHref={routeHash({ view: "duel" })}
            onCopy={(e) => {
              if (e.altKey) {
                setCopyMenu({ bait: b, x: e.clientX, y: e.clientY })
                return
              }
              runCopy("bayt", b)
            }}
          />
        ))}
      </div>

      {hasMore ? (
        <div className="poem-more" ref={sentinelRef}>
          {loadingMore ? (
            <BaytSkeleton rows={2} size={settings.verseSize} />
          ) : (
            <button type="button" className="btn" onClick={fetchMore}>
              المزيد — بقي {formatBaits(total - loaded)}
            </button>
          )}
        </div>
      ) : null}

      {similar.length ? (
        <section className="poem-similar">
          <h2 className="section-title">قصائد على الوزن والقافية</h2>
          <Rule />
          <ul className="poem-similar__list">
            {similar.map((s) => {
              const h = headingOf(s)
              return (
                <li key={s.id}>
                  <a className="poem-similar__row" href={routeHash({ view: "poem", id: s.id })}>
                    <span className={h.isMatla ? "poem-similar__name poem-similar__name--matla" : "poem-similar__name"}>
                      <bdi>{h.text}</bdi>
                    </span>
                    <span className="poem-similar__meta">
                      <bdi>{s.poet.name}</bdi>
                      <span aria-hidden="true"> · </span>
                      {formatBaits(s.baitCount)}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {copyMenu ? (
        <div
          className="copy-menu"
          role="menu"
          /* clientX/clientY are viewport coordinates, so the menu is placed
             with physical left/top — logical insets would mirror it under RTL */
          style={{ left: `${copyMenu.x}px`, top: `${copyMenu.y}px` }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {COPY_MODES.map((m) => (
            <button key={m.key} type="button" role="menuitem" onClick={() => runCopy(m.key, copyMenu.bait)}>
              {m.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** `?bayt=7` → the DOM id BaytPlate carries. */
function anchorId(position: number): string {
  return `bayt-${position}`
}

function letterName(letter: string): string {
  return LETTER_NAMES[letter as HijaiLetter] ?? letter
}

/**
 * The بحر popover: التفعيلات as separate cells (so the reader can count them)
 * and the مفتاح — the mnemonic hemistich that scans as the meter itself.
 * Static, from client/data/buhur.ts; the 16 بحور do not change.
 */
function MeterPopover({
  name,
  variant,
  tafilat,
  miftah,
  slug,
  onClose,
}: {
  name: string
  variant: string | null
  tafilat: readonly string[] | null
  miftah: string | null
  slug: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="popover" role="dialog" aria-label={`تفعيلات ${name}`}>
      <div className="popover__head">
        <span className="popover__title">{name}</span>
        {variant ? <span className="popover__variant">{variant}</span> : null}
      </div>
      {tafilat ? (
        <div className="tafilat">
          {tafilat.map((t, i) => (
            <span className="tafila" key={`${t}-${i}`}>
              {t}
            </span>
          ))}
        </div>
      ) : (
        <p className="popover__note">لا تفعيلات معروفة لهذا الوزن.</p>
      )}
      {miftah ? <p className="popover__miftah">{miftah}</p> : null}
      <a className="popover__link" href={routeHash({ view: "browse", query: { meter: slug } })}>
        قصائد هذا البحر ←
      </a>
    </div>
  )
}
