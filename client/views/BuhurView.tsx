/**
 * `#/buhur` — صفحة البحور. The sixteen, taught.
 *
 * The bar this page is held to is not «lists the بحور» but «a reader leaves
 * knowing what الطويل sounds like». Four things in that order do the teaching,
 * and each one is on every card:
 *
 *  1. **التفعيلات**, as separate cells so they can be COUNTED — four for
 *     الطويل, three for الكامل. A single run of text cannot be counted.
 *  2. **المفتاح** — the mnemonic بيت that scans as its own metre («طويلٌ له دونَ
 *     البحورِ فضائلُ»), set in the verse face with its own تفعيلات beneath it,
 *     aligned to the same cells. This is the classical teaching device and it
 *     is why the page can teach a sound at all: the line IS the rhythm.
 *  3. **بيتٌ من الديوان** on that بحر, voweled and complete, with the same
 *     تفعيلات under it again. The مفتاح shows the pattern in the abstract; a
 *     real بيت shows a poet using it, and the repeat under both is what lets
 *     the eye carry one onto the other.
 *  4. **العدد** — how many قصائد the ديوان holds on this بحر, and a door into
 *     them.
 *
 * And the cards are grouped by **دائرة**, not run out flat. الخليل did not
 * name sixteen metres; he drew five circles and read the metres off them, so
 * five headings with one clause each are the difference between a list and an
 * explanation — see `client/data/buhur.ts`.
 *
 * Everything except the example بيت is in the bundle. The counts come from
 * `/api/meta` (precomputed at ingest, already in the library store) and the
 * sixteen examples from `/api/buhur` (memoised per DB handle and pre-warmed at
 * boot — see that route's header for the two slower shapes it replaced). So the
 * page renders complete on the first paint of static data and fills in the
 * أبيات when they land; a card with no example still has its مفتاح, which is
 * the point of having one.
 */
import { useEffect, useMemo, useRef, useState } from "react"

import { ApiError } from "../api/client.ts"
import { getBuhur } from "../api/queries.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { formatBayt, formatBaytWithPoet, writeClipboard } from "../bayt/copy.ts"
import { PanelCorners, Rule, Shamsa } from "../components/Ornaments.tsx"
import { openShareCard } from "../share/ShareDialog.tsx"
import { savedFromBait, useCollections } from "../store/collectionsStore.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { routeHash } from "../router.ts"
import { BUHUR, DAWAIR, type Bahr } from "../data/buhur.ts"
import { formatPoems } from "../../shared/format.ts"
import type { BaitDto, MetaResponse } from "../../shared/schema.ts"
import { albumAction } from "../albums/AlbumPicker.tsx"

export function BuhurView({ bahr }: { bahr?: string }) {
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [examples, setExamples] = useState<Map<string, BaitDto | null> | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    loadMeta(ac.signal)
      .then((m) => !ac.signal.aborted && setMeta(m))
      .catch(() => {})
    return () => ac.abort()
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    getBuhur({ signal: ac.signal })
      .then((d) => {
        if (ac.signal.aborted) return
        setExamples(new Map(d.items.map((i) => [i.slug, i.bait])))
      })
      .catch((e: unknown) => {
        // The lesson survives without the أبيات — every card keeps its مفتاح,
        // its تفعيلات and its دائرة. So a failure here is a quiet note under
        // the head, never an error screen over the whole page.
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e : new ApiError("network", "تعذّر جلب الشواهد", "/api/buhur"))
      })
    return () => ac.abort()
  }, [])

  /**
   * `?b=<slug>` brings that card up — once per target, the قصيدة's `?bayt=N`
   * rule (`jumped` in PoemView).
   *
   * It waits for the page to SETTLE, and that wait is the whole correctness of
   * it. `#/buhur` paints its sixteen cards from static data immediately, but
   * every card is ~200px shorter until its شاهد lands, so a jump computed
   * before `/api/buhur` answers is measured against a page that is about to
   * grow by three thousand pixels underneath it. Measured on the real corpus:
   * `?b=kamil` landed with 76px of the card on screen and `?b=mujtath` 1,996px
   * below the fold. `settled` is «the أبيات are in, or they are not coming».
   *
   * Two `requestAnimationFrame`s then put it after React's commit and after
   * any layout effect scheduled with it — including App.tsx's «a new page
   * starts at its top», because arriving from a بحر chip IS a new page — with
   * no magic milliseconds to go stale. And it abandons the moment the reader
   * scrolls themselves.
   */
  const settled = examples !== null || error !== null
  const jumped = useRef<string | null>(null)
  useEffect(() => {
    if (!bahr || !settled || jumped.current === bahr) return
    jumped.current = bahr
    let live = true
    const stop = () => {
      live = false
    }
    window.addEventListener("wheel", stop, { once: true, passive: true })
    window.addEventListener("touchstart", stop, { once: true, passive: true })
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!live) return
        document.getElementById(`bahr-${bahr}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      }),
    )
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("wheel", stop)
      window.removeEventListener("touchstart", stop)
    }
  }, [bahr, settled])

  /** قصائد per بحر, off `/api/meta` — no facets request, no second count. */
  const poemCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const row of meta?.meters ?? []) m.set(row.slug, row.poemCount)
    return m
  }, [meta])

  return (
    <div className="view view--centred buhur-view">
      <header className="view__head">
        <h1 className="view__title">بحور الشعر</h1>
        <p className="view__lede">
          استخرج الخليلُ بن أحمد أوزانَ العرب من خمس دوائر، فكان منها ستّة عشر بحرًا. هذه هي، بتفعيلاتها ومفاتيحها،
          وبيتٍ من الديوان على كلِّ واحدٍ منها.
        </p>
        {error ? <p className="buhur-note">لم تصلنا الشواهد من الديوان، والمفاتيح تكفي إلى أن تعود.</p> : null}
      </header>

      {DAWAIR.map((daira, i) => (
        <section className="buhur-daira" key={daira.slug} data-enter style={{ "--enter-i": i } as React.CSSProperties}>
          <header className="buhur-daira__head">
            <h2 className="buhur-daira__name">{daira.name}</h2>
            <Rule className="buhur-daira__rule" />
            <p className="buhur-daira__why">{daira.why}</p>
          </header>
          <div className="buhur-grid">
            {BUHUR.filter((b) => b.daira === daira.slug).map((b) => (
              <BahrCard
                key={b.slug}
                bahr={b}
                poems={poemCounts.get(b.slug) ?? null}
                example={examples ? (examples.get(b.slug) ?? null) : undefined}
                open={bahr === b.slug}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/**
 * One بحر.
 *
 * `example === undefined` is «not asked yet» and `null` is «the ديوان has
 * none» — the same distinction the letter grid draws between a count in flight
 * and a count of zero, and for the same reason: a card that says «ليس في
 * الديوان بيتٌ عليه» while the request is still open is a lie that corrects
 * itself, which is worse than a quiet ruled space.
 */
function BahrCard({
  bahr,
  poems,
  example,
  open,
}: {
  bahr: Bahr
  poems: number | null
  example: BaitDto | null | undefined
  open: boolean
}) {
  const settings = useSettings()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)

  return (
    // The scroll itself lives in the VIEW, which knows the target; the card
    // only says which one it is and whether it is the one that was asked for.
    <article className="buhur-card" data-open={open ? "1" : undefined} id={`bahr-${bahr.slug}`}>
      <PanelCorners size={14} />

      <header className="buhur-card__head">
        <h3 className="buhur-card__name">{bahr.name}</h3>
        {poems === null ? null : (
          <a className="buhur-card__n" href={routeHash({ view: "browse", query: { meter: bahr.slug } })}>
            {formatPoems(poems)} في الديوان ←
          </a>
        )}
      </header>

      <Tafilat cells={bahr.tafilat} label={`تفعيلات ${bahr.name}`} />

      <div className="buhur-card__miftah">
        <span className="buhur-card__caption">
          <Shamsa size={10} />
          المفتاح
        </span>
        <p className="buhur-card__key">{bahr.miftah}</p>
      </div>

      {bahr.note ? <p className="buhur-card__note">{bahr.note}</p> : null}

      <div className="buhur-card__shahid">
        <span className="buhur-card__caption">
          <Shamsa size={10} />
          من الديوان
        </span>
        {example === undefined ? (
          <div className="buhur-card__ghost" aria-hidden="true">
            <span className="skeleton" style={{ inlineSize: "82%", blockSize: "1.05rem" }} />
            <span className="skeleton" style={{ inlineSize: "64%", blockSize: "1.05rem" }} />
          </div>
        ) : example === null ? (
          <p className="buhur-card__none">لا شاهدَ عليه في الديوان.</p>
        ) : (
          <>
            <BaytPlate
              variant="row"
              size="sm"
              sadr={example.sadr}
              ajuz={example.ajuz}
              rawiyy={example.rawiyy}
              tashkeel={settings.tashkeel}
              showRawiyy={settings.showRawiyy}
              label={`بيت ${example.poet.name}`}
              favorite={favorites.some((f) => f.baytKey === example.baytKey)}
              onFavorite={() => {
                const now = toggleFavorite(savedFromBait(example))
                toast(now ? "أُضيف إلى المختارات" : "أُزيل من المختارات", now ? "ok" : "info")
              }}
              onAlbum={albumAction(example)}
              onCard={() => openShareCard({ sadr: example.sadr, ajuz: example.ajuz, poet: example.poet.name })}
              onCopy={() => {
                void writeClipboard(
                  formatBaytWithPoet(example.sadr, example.ajuz, example.poet.name, null),
                ).then((ok) => toast(ok ? "نُسخ البيت" : "تعذّر النسخ", ok ? "ok" : "danger"))
              }}
              copyText={formatBayt(example.sadr, example.ajuz)}
              duelHref={routeHash({ view: "duel" })}
            />
            {/* The same تفعيلات a second time, directly under the بيت. This is
                the repeat that does the teaching: the eye carries the pattern
                from the cells above onto the line, and then onto this line. */}
            <Tafilat cells={bahr.tafilat} label={`تفعيلات البيت على ${bahr.name}`} muted />
            <p className="buhur-card__by">
              <a href={routeHash({ view: "poet", slug: example.poet.slug })}>
                <bdi>{example.poet.name}</bdi>
              </a>
              <span className="buhur-card__dot" aria-hidden="true">
                ·
              </span>
              <a href={routeHash({ view: "poem", id: example.poem.id, bayt: example.position })}>القصيدة ←</a>
            </p>
          </>
        )}
      </div>
    </article>
  )
}

/**
 * التفعيلات as separate cells, with a hairline between them.
 *
 * They are cells and not a sentence because the first thing anyone is told
 * about a بحر is HOW MANY أجزاء it has, and a reader cannot count a run of
 * words with spaces in it as fast as they can count four boxes.
 */
function Tafilat({ cells, label, muted }: { cells: readonly string[]; label: string; muted?: boolean }) {
  return (
    <ol className="buhur-tafilat" data-muted={muted ? "1" : undefined} aria-label={label}>
      {cells.map((t, i) => (
        <li className="buhur-tafila" key={`${t}-${i}`}>
          {t}
        </li>
      ))}
    </ol>
  )
}
