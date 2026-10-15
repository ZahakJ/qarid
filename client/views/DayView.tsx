/**
 * `#/day/<YYYY-MM-DD>` — بيت اليوم of one day, and bare `#/day` today's.
 *
 * It is where a shared `/d/<date>` link lands (server/daily.ts folds into it
 * through client/router.ts), so it shows THAT day's بيت, not today's: the
 * reader who opens a link from last week must see the بيت the card showed.
 * A day after today has no بيت yet.
 */
import { useEffect, useState } from "react"
import { ApiError } from "../api/client.ts"
import { getDailyBait } from "../api/queries.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { formatBayt, formatBaytWithPoet, writeClipboard } from "../bayt/copy.ts"
import { Rule, Shamsa } from "../components/Ornaments.tsx"
import { riyadhDay } from "../duel/daily.ts"
import { routeHash } from "../router.ts"
import { shareDailyBait } from "../share/dailyShare.ts"
import { openShareCard } from "../share/ShareDialog.tsx"
import { useCollections } from "../store/collectionsStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { arabicDay } from "../../shared/format.ts"
import type { DailyResponse } from "../../shared/schema.ts"
import { albumAction } from "../albums/AlbumPicker.tsx"
import { headingOf } from "./shared.tsx"

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function validDay(day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day
}

export function DayView({ date }: { date?: string }) {
  const settings = useSettings()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)
  const today = riyadhDay()
  const day = date ?? today
  const unavailable = !validDay(day) || day > today

  const [daily, setDaily] = useState<DailyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (unavailable) return
    const ac = new AbortController()
    getDailyBait(day, { signal: ac.signal })
      .then((d) => !ac.signal.aborted && setDaily(d))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError(e instanceof ApiError ? e.message : "تعذّر جلب البيت")
      })
    return () => ac.abort()
  }, [day, unavailable])

  const bait = daily?.bait
  const isSaved = bait ? favorites.some((f) => f.baytKey === bait.baytKey) : false
  const heading = day === today ? "بيت اليوم" : `بيت يوم ${arabicDay(day)} ${day.slice(0, 4)}`

  return (
    <div className="view view--centred home">
      <section className="hero" aria-label={heading}>
        <div className="hero__head">
          <Shamsa size={13} />
          <h1 className="hero__title">{heading}</h1>
          <Shamsa size={13} />
        </div>

        {unavailable ? (
          <p className="hero__error">لا بيت لهذا اليوم.</p>
        ) : error ? (
          <p className="hero__error">{error}</p>
        ) : !bait ? (
          <BaytSkeleton rows={1} size="lg" />
        ) : (
          <div className="hero__plate">
            <BaytPlate
              variant="plate"
              size="lg"
              sadr={bait.sadr}
              ajuz={bait.ajuz}
              rawiyy={bait.rawiyy}
              showRawiyy={settings.showRawiyy}
              tashkeel={settings.tashkeel}
              label={heading}
              favorite={isSaved}
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
              onAlbum={albumAction(bait)}
              onCard={() =>
                openShareCard({
                  sadr: bait.sadr,
                  ajuz: bait.ajuz,
                  poet: bait.poet.name,
                  poem: daily?.poem ? headingOf(daily.poem).text : null,
                })
              }
              onCopy={() => {
                void writeClipboard(formatBaytWithPoet(bait.sadr, bait.ajuz, bait.poet.name, null)).then((ok) =>
                  toast(ok ? "نُسخ البيت" : "تعذّر النسخ", ok ? "ok" : "danger"),
                )
              }}
              copyText={formatBayt(bait.sadr, bait.ajuz)}
              meta={
                <>
                  <a className="hero__poet" href={routeHash({ view: "poet", slug: bait.poet.slug })}>
                    <bdi>{bait.poet.name}</bdi>
                  </a>
                  <a className="hero__poem" href={routeHash({ view: "poem", id: bait.poem.id, bayt: bait.position })}>
                    القصيدة ←
                  </a>
                  <button
                    type="button"
                    className="hero__poem"
                    onClick={() =>
                      void shareDailyBait({ date: day, sadr: bait.sadr, ajuz: bait.ajuz, poet: bait.poet.name })
                    }
                  >
                    شارك
                  </button>
                </>
              }
            />
          </div>
        )}
      </section>

      <Rule />
      <nav aria-label="الأيام" style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "1.5rem" }}>
        {validDay(day) ? (
          <a className="hero__poem" href={routeHash({ view: "day", date: shiftDay(day, -1) })}>
            → اليوم السابق
          </a>
        ) : null}
        {validDay(day) && day < today ? (
          <a className="hero__poem" href={routeHash({ view: "day", date: shiftDay(day, 1) })}>
            اليوم التالي ←
          </a>
        ) : null}
        {day !== today ? (
          <a className="hero__poem" href={routeHash({ view: "home" })}>
            بيت اليوم
          </a>
        ) : null}
      </nav>
    </div>
  )
}
