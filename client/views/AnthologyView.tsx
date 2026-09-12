/**
 * `#/anthology` and `#/anthology/<slug>` — المختارات المنظومة.
 *
 * The entrance a library deserves: two shelves, curated in
 * `shared/anthologies.ts` and resolved against the corpus by
 * `/api/anthologies` (never at ingest — see that file's header).
 *
 *   `AnthologyIndexView`  the two shelf cards, each a framed panel with its own
 *                         شمسة, tagline, blurb and honest count.
 *   `AnthologyShelfView`  one shelf. المعلقات renders قصيدة cards — ordinal,
 *                         name, شاعر, مطلع through `BaytPlate` — and مئة بيت
 *                         سائر renders BaytPlate ROWS, so ♥ / بطاقة / ساجِلني
 *                         all work exactly as they do in المختارات.
 *   `AnthologyStrip`      the compact two-card strip HomeView puts under بيت
 *                         اليوم. Same data, one request, no second component
 *                         tree.
 *
 * The one rule that shapes the markup: an entry the corpus cannot answer is
 * still an item. It renders its own مطلع in a quiet state and says «ليست في
 * الديوان» — a shelf that silently prints nine of ten odes would be lying
 * about the ديوان, and the reader would never know to look elsewhere.
 */
import { useEffect, useState } from "react"

import { ApiError } from "../api/client.ts"
import { getAnthologies, getAnthology } from "../api/queries.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { formatBayt, formatBaytWithPoet, writeClipboard } from "../bayt/copy.ts"
import { Chip } from "../components/Chip.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { PanelCorners, Rule, Shamsa } from "../components/Ornaments.tsx"
import { openShareCard } from "../share/ShareDialog.tsx"
import { useCollections } from "../store/collectionsStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { routeHash } from "../router.ts"
import { formatBaits, formatNumber } from "../../shared/format.ts"
import type { AnthologiesResponse, AnthologyItem, AnthologyResponse, AnthologyShelf } from "../../shared/schema.ts"

// ─────────────────────────────────────────────────────────────────────────────
// #/anthology — the shelf strip's own page
// ─────────────────────────────────────────────────────────────────────────────

export function AnthologyIndexView() {
  const { shelves, error } = useShelves()

  return (
    <div className="view anth-index">
      <header className="view__head">
        <h1 className="view__title">المختارات المنظومة</h1>
        <p className="view__lede">
          رفٌّ لما يُبدأ به الشعر العربي، ورفٌّ لما بقي منه على الألسنة. وكلّ ما فيهما موصولٌ بالديوان نفسه:
          تقرأ القصيدة كاملة، أو تأخذ البيت إلى مساجلتك.
        </p>
      </header>

      {error ? (
        <EmptyState flavor="facets-zero" title="تعذّر فتح المختارات">
          <p className="anth-error">{error.message}</p>
        </EmptyState>
      ) : shelves === null ? (
        <div className="anth-shelves" aria-hidden="true">
          <div className="anth-card anth-card--ghost" />
          <div className="anth-card anth-card--ghost" />
        </div>
      ) : (
        <div className="anth-shelves">
          {shelves.map((shelf, i) => (
            <ShelfCard key={shelf.slug} shelf={shelf} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

function ShelfCard({ shelf, index }: { shelf: AnthologyShelf; index: number }) {
  return (
    <article className="anth-card" data-enter style={{ "--enter-i": index } as React.CSSProperties}>
      <PanelCorners size={16} />
      <header className="anth-card__head">
        <Shamsa size={14} />
        <h2 className="anth-card__title">{shelf.title}</h2>
      </header>
      <p className="anth-card__tagline">{shelf.tagline}</p>
      <Rule className="anth-card__rule" />
      <p className="anth-card__blurb">{shelf.blurb}</p>
      {shelf.preview.length > 0 ? (
        <div className="anth-card__shelf">
          <ul className="anth-card__spines">
            {shelf.preview.map((line) => (
              <li className="anth-card__spine" key={line}>
                {line}
              </li>
            ))}
          </ul>
          {/* «and the rest» — the dissolving hairline, not an ellipsis. A bare
              «…» is a neutral character alone on an RTL line, and it drifts. */}
          <Rule className="anth-card__spines-end" />
        </div>
      ) : null}
      <footer className="anth-card__foot">
        <span className="anth-card__count">{shelfCount(shelf)}</span>
        <a className="anth-card__go" href={routeHash({ view: "anthology-shelf", slug: shelf.slug })}>
          افتح الرفّ ←
        </a>
      </footer>
    </article>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// #/anthology/<slug> — one shelf
// ─────────────────────────────────────────────────────────────────────────────

export function AnthologyShelfView({ slug }: { slug: string }) {
  const [data, setData] = useState<AnthologyResponse | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    setData(null)
    setError(null)
    getAnthology(slug, { signal: ac.signal })
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر فتح الرفّ", "/api/anthologies"))
      })
    return () => ac.abort()
  }, [slug])

  const shelf = data?.shelf

  return (
    <div className="view anth-shelf">
      <header className="view__head anth-shelf__head">
        <a className="anth-shelf__up" href={routeHash({ view: "anthology" })}>
          → المختارات المنظومة
        </a>
        <h1 className="view__title">{shelf?.title ?? "المختارات المنظومة"}</h1>
        {shelf ? <p className="view__lede">{shelf.blurb}</p> : null}
        {shelf ? (
          <p className="anth-shelf__count">
            <Shamsa size={11} />
            <span>{shelfCount(shelf)}</span>
          </p>
        ) : null}
      </header>

      {error ? (
        <EmptyState flavor="facets-zero" title="تعذّر فتح الرفّ">
          <p className="anth-error">{error.message}</p>
        </EmptyState>
      ) : !data ? (
        <BaytSkeleton rows={6} />
      ) : data.shelf.kind === "poems" ? (
        <ol className="anth-odes">
          {data.items.map((item) => (
            <OdeCard key={item.index} item={item} />
          ))}
        </ol>
      ) : (
        <ol className="anth-baits" data-bayt-list>
          {data.items.map((item) => (
            <SairRow key={item.index} item={item} />
          ))}
        </ol>
      )}
    </div>
  )
}

/** One معلقة: an ordinal, its name, its شاعر, and its مطلع as a real بيت. */
function OdeCard({ item }: { item: AnthologyItem }) {
  const settings = useSettings()
  const poem = item.poem

  return (
    <li className="anth-ode" data-enter style={{ "--enter-i": Math.min(item.index, 7) } as React.CSSProperties}>
      <span className="anth-ode__ord num" aria-hidden="true">
        {formatNumber(item.index + 1)}
      </span>
      <div className="anth-ode__body">
        <header className="anth-ode__head">
          <h2 className="anth-ode__name">{item.name ?? item.matla}</h2>
          {poem ? (
            <a className="anth-ode__poet" href={routeHash({ view: "poet", slug: poem.poet.slug })}>
              <bdi>{poem.poet.name}</bdi>
            </a>
          ) : (
            <span className="anth-ode__poet anth-ode__poet--plain">
              <bdi>{item.poet}</bdi>
            </span>
          )}
        </header>

        {poem ? (
          <BaytPlate
            variant="row"
            size="sm"
            sadr={poem.previewSadr ?? item.matla}
            ajuz={poem.previewAjuz}
            rawiyy={poem.rhyme}
            showRawiyy={settings.showRawiyy}
            tashkeel={settings.tashkeel}
          />
        ) : (
          <p className="anth-ode__matla">{item.matla}</p>
        )}

        <footer className="anth-ode__meta">
          {poem ? (
            <>
              {poem.meter ? <Chip variant="bahr" slug={poem.meter.slug} label={poem.meter.name} /> : null}
              {poem.rhyme ? <Chip variant="rawiyy" label={poem.rhyme} title={`الرويّ: ${poem.rhyme}`} /> : null}
              <span className="anth-ode__len">{formatBaits(poem.baitCount)}</span>
              <a className="anth-ode__go" href={routeHash({ view: "poem", id: poem.id })}>
                اقرأها ←
              </a>
            </>
          ) : (
            <span className="anth-missing">ليست في الديوان</span>
          )}
        </footer>
      </div>
    </li>
  )
}

/** One بيت سائر: a real `BaytPlate` row, with the whole rail live. */
function SairRow({ item }: { item: AnthologyItem }) {
  const settings = useSettings()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)
  const bait = item.bait

  if (!bait) {
    return (
      <li className="anth-bayt anth-bayt--missing">
        <p className="anth-ode__matla">{item.matla}</p>
        <p className="anth-bayt__meta">
          <bdi>{item.poet}</bdi>
          <span className="anth-missing">ليس في الديوان</span>
        </p>
      </li>
    )
  }

  const saved = favorites.some((f) => f.baytKey === bait.baytKey)

  return (
    <li className="anth-bayt">
      <span className="anth-bayt__ord num" aria-hidden="true">
        {formatNumber(item.index + 1)}
      </span>
      <div className="anth-bayt__card">
        <BaytPlate
          variant="row"
          size="md"
          sadr={bait.sadr}
          ajuz={bait.ajuz}
          rawiyy={bait.rawiyy}
          showRawiyy={settings.showRawiyy}
          tashkeel={settings.tashkeel}
          label={`بيت ${bait.poet.name}`}
          favorite={saved}
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
          onCard={() =>
            openShareCard({
              sadr: bait.sadr,
              ajuz: bait.ajuz,
              poet: bait.poet.name,
            })
          }
          onCopy={() => {
            void writeClipboard(formatBaytWithPoet(bait.sadr, bait.ajuz, bait.poet.name, null)).then((ok) =>
              toast(ok ? "نُسخ البيت" : "تعذّر النسخ", ok ? "ok" : "danger"),
            )
          }}
          copyText={formatBayt(bait.sadr, bait.ajuz)}
          duelHref={routeHash({ view: "duel" })}
        />
        <p className="anth-bayt__meta">
          <a className="anth-bayt__poet" href={routeHash({ view: "poet", slug: bait.poet.slug })}>
            <bdi>{bait.poet.name}</bdi>
          </a>
          {bait.era ? <Chip variant="asr" label={bait.era.name} /> : null}
          {bait.meter ? <Chip variant="bahr" slug={bait.meter.slug} label={bait.meter.name} /> : null}
          <a
            className="anth-bayt__go"
            href={routeHash({ view: "poem", id: bait.poem.id, bayt: bait.position })}
          >
            القصيدة ←
          </a>
        </p>
      </div>
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The home strip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two shelves as a strip, for HomeView.
 *
 * It renders NOTHING until the request lands and nothing at all if it fails —
 * a skeleton here would push بيت اليوم's neighbours around on every visit, and
 * a shelf strip is an invitation, not a load-bearing part of the page.
 */
export function AnthologyStrip() {
  const { shelves } = useShelves()
  if (!shelves || shelves.length === 0) return null

  return (
    <section className="anth-strip" aria-label="المختارات المنظومة">
      <div className="anth-strip__head">
        <h2 className="section-title">المختارات المنظومة</h2>
        <Rule />
      </div>
      <div className="anth-strip__row">
        {shelves.map((shelf) => (
          <a
            className="anth-tile"
            key={shelf.slug}
            href={routeHash({ view: "anthology-shelf", slug: shelf.slug })}
          >
            <span className="anth-tile__mark" aria-hidden="true">
              <Shamsa size={13} />
            </span>
            <span className="anth-tile__title">{shelf.title}</span>
            <span className="anth-tile__tagline">{shelf.tagline}</span>
            {shelf.preview[0] ? <span className="anth-tile__spine">{shelf.preview[0]}</span> : null}
          </a>
        ))}
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One request, one shape, three call sites — the strip on `#/`, the index page
 * and (through it) the shelf page's header. `/api/anthologies` is cached an
 * hour and pre-warmed at boot, so the second caller costs a conditional GET.
 */
function useShelves(): { shelves: AnthologyShelf[] | null; error: ApiError | null } {
  const [shelves, setShelves] = useState<AnthologyShelf[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    getAnthologies({ signal: ac.signal })
      .then((d: AnthologiesResponse) => !ac.signal.aborted && setShelves(d.shelves))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر فتح المختارات", "/api/anthologies"))
      })
    return () => ac.abort()
  }, [])

  return { shelves, error }
}

/**
 * What the shelf actually holds, said the way a person would say it.
 *
 * `resolved` is what the corpus answered, `total` what the anthology asked for.
 * They normally agree, and then the line is «كلّها في الديوان» — the shelf's
 * own title and tagline have already said how many, and repeating the number
 * beside them would be an assembled sentence rather than a written one.
 *
 * When they DISAGREE the line names both, because that difference is the one
 * fact worth printing: «8 من 10 في الديوان» tells the reader the two missing
 * odes are missing from the ديوان and not from the anthology.
 *
 * Neither branch glues a number to a noun — which is also how it avoids
 * `countedNoun`'s one blind spot: an exact hundred takes the معدود مفردًا
 * مجرورًا («مئة بيتٍ»), not the تمييز منصوب of 11–99, and «100 بيتًا» on the
 * shelf card was the first thing the 1440 screenshot showed.
 */
export function shelfCount(shelf: AnthologyShelf): string {
  if (shelf.resolved === shelf.total) return "كلّها في الديوان"
  return `${formatNumber(shelf.resolved)} من ${formatNumber(shelf.total)} في الديوان`
}
