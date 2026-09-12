/**
 * #/wander — التجوال (design-ux.md §1, §8 v1.5).
 *
 * One بيت and three doors: شاعره · بحره · قافيته. Each door is a filtered
 * random sample — «another بيت by this شاعر», «another on this بحر», «another
 * on this قافية» — so a walk through the corpus is a chain of real
 * resemblances instead of a shuffle. It is the ديوان read the way a person
 * actually reads one: you do not choose a قصيدة, you follow the thread out of
 * the one you are holding.
 *
 * Everything is one call to `/api/baits/random`, which samples the precomputed
 * `bucket` window (never `ORDER BY RANDOM()` — CLAUDE.md invariant), so a door
 * costs a couple of index range scans however deep the walk goes.
 *
 * The trail is kept so «رجوع» walks BACK rather than re-rolling: a بيت you
 * liked and clicked past is otherwise gone for good, and that is the one thing
 * a serendipity walk must not do.
 */
import { useCallback, useEffect, useState } from "react"

import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import type { BaitDto } from "../../shared/schema.ts"
import { ApiError } from "../api/client.ts"
import { getRandomBait } from "../api/queries.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { formatBayt, formatBaytWithPoet, writeClipboard } from "../bayt/copy.ts"
import { Chip } from "../components/Chip.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { routeHash } from "../router.ts"
import { openShareCard } from "../share/ShareDialog.tsx"
import { useCollections } from "../store/collectionsStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { albumAction } from "../albums/AlbumPicker.tsx"

type DoorKind = "poet" | "meter" | "rhyme"

/** One step of the walk: the بيت, and the door that led to it. */
type Step = { bait: BaitDto; via: DoorKind | null; label: string | null }

type Door = {
  kind: DoorKind
  title: string
  /** what the door is a door TO — the شاعر's name, the بحر, the letter */
  value: string | null
  params: Record<string, string> | null
}

/** The three doors this بيت opens. A door with nothing behind it is disabled. */
export function doorsOf(bait: BaitDto): Door[] {
  return [
    {
      kind: "poet",
      title: "شاعره",
      value: bait.poet.name,
      params: { poet: bait.poet.slug },
    },
    {
      kind: "meter",
      title: "بحره",
      value: bait.meter?.name ?? null,
      params: bait.meter ? { meter: bait.meter.slug } : null,
    },
    {
      kind: "rhyme",
      title: "قافيته",
      value: bait.rawiyy ? LETTER_NAMES[bait.rawiyy as HijaiLetter] : null,
      params: bait.rawiyy ? { rhyme: bait.rawiyy } : null,
    },
  ]
}

export function WanderView() {
  const settings = useSettings()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)

  const [trail, setTrail] = useState<Step[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const current = trail[trail.length - 1] ?? null

  /** Pull one بيت under `params` and push it onto the trail. */
  const walk = useCallback(async (params: Record<string, string>, via: DoorKind | null, label: string | null) => {
    setBusy(true)
    setError(null)
    try {
      // Two tries, and the order matters. `fame >= 2` keeps the walk among the
      // أبيات people have actually met — a random بيت 300 of a 500-بيت ديوان is
      // technically a step and nobody has ever quoted it. But a minor شاعر may
      // have nothing famous at all, and a door that answers «لا شيء هنا» is a
      // dead end in a room whose whole promise is another door, so the second
      // try drops the filter rather than the walk.
      const bait = await getRandomBait({ fame: 2, ...params }).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return getRandomBait(params)
        throw e
      })
      setTrail((t) => [...t, { bait, via, label }])
    } catch (e) {
      const notFound = e instanceof ApiError && e.status === 404
      if (notFound) toast("لا بيت آخر من هذا الباب", "info")
      else setError(e instanceof ApiError ? e.message : "تعذّر الاتصال بالخادم")
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void walk({}, null, null)
  }, [walk])

  const doors = current ? doorsOf(current.bait) : []
  const saved = current ? favorites.some((f) => f.baytKey === current.bait.baytKey) : false

  return (
    <div className="view wander-view">
      <header className="view__head">
        <h1 className="view__title">التجوال</h1>
        <p className="view__lede">بيتٌ واحد، وثلاثة أبواب: شاعرُه، أو بحرُه، أو قافيتُه. اختر بابًا يخرج بك إلى بيتٍ آخر.</p>
      </header>

      {error ? <p className="wander-error">{error}</p> : null}

      {current ? (
        <>
          <BaytPlate
            variant="plate"
            size="lg"
            sadr={current.bait.sadr}
            ajuz={current.bait.ajuz}
            rawiyy={current.bait.rawiyy}
            tashkeel={settings.tashkeel}
            showRawiyy={settings.showRawiyy}
            label="بيت التجوال"
            className={busy ? "is-walking" : undefined}
            favorite={saved}
            onFavorite={() => {
              const bait = current.bait
              const on = toggleFavorite({
                baytKey: bait.baytKey,
                baitId: bait.id,
                sadr: bait.sadr,
                ajuz: bait.ajuz,
                poemId: bait.poem.id,
                poemTitle: bait.poem.title,
                poet: bait.poet,
                meter: bait.meter,
              })
              toast(on ? "أُضيف إلى المختارات" : "أُزيل من المختارات", on ? "ok" : "info")
            }}
            onAlbum={albumAction(current.bait)}
            onCard={() =>
              openShareCard({
                sadr: current.bait.sadr,
                ajuz: current.bait.ajuz,
                poet: current.bait.poet.name,
              })
            }
            onCopy={() => {
              void writeClipboard(
                formatBaytWithPoet(current.bait.sadr, current.bait.ajuz, current.bait.poet.name, null),
              ).then((ok) => toast(ok ? "نُسخ البيت" : "تعذّر النسخ", ok ? "ok" : "danger"))
            }}
            copyText={formatBayt(current.bait.sadr, current.bait.ajuz)}
            duelHref={routeHash({ view: "duel" })}
            meta={
              <>
                <a className="hero__poet" href={routeHash({ view: "poet", slug: current.bait.poet.slug })}>
                  <bdi>{current.bait.poet.name}</bdi>
                </a>
                {current.bait.era ? <Chip variant="asr" label={current.bait.era.name} /> : null}
                {current.bait.meter ? <Chip variant="bahr" slug={current.bait.meter.slug} label={current.bait.meter.name} /> : null}
                {current.bait.rawiyy ? (
                  <Chip
                    variant="rawiyy"
                    label={current.bait.rawiyy}
                    title={`الرويّ: ${LETTER_NAMES[current.bait.rawiyy as HijaiLetter]}`}
                  />
                ) : null}
                <a
                  className="hero__poem"
                  href={routeHash({ view: "poem", id: current.bait.poem.id, bayt: current.bait.position })}
                >
                  القصيدة ←
                </a>
              </>
            }
          />

          <nav className="doors doors--wander" aria-label="أبواب التجوال">
            {doors.map((door) => (
              <button
                type="button"
                key={door.kind}
                className="door door--wander"
                disabled={busy || door.params === null}
                onClick={() => door.params && void walk(door.params, door.kind, door.value)}
              >
                <span className="door__name">{door.title}</span>
                <span className="door__note">
                  {door.value ? <bdi>{door.value}</bdi> : "لا يُعرف لهذا البيت"}
                </span>
                <span className="door__go">اخرج ←</span>
              </button>
            ))}
          </nav>

          <div className="wander-foot">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={trail.length < 2 || busy}
              onClick={() => setTrail((t) => t.slice(0, -1))}
            >
              رجوع →
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void walk({}, null, null)}>
              بيتٌ آخر
            </button>
          </div>

          {trail.length > 1 ? (
            <section className="wander-trail" aria-label="أثر التجوال">
              <Rule style={{ inlineSize: "min(18rem, 60%)" }} />
              <ol className="wander-trail__list">
                {trail.map((step, i) => (
                  <li className="wander-trail__step" key={`${step.bait.baytKey}-${i}`} data-current={i === trail.length - 1 ? "1" : undefined}>
                    {step.via ? (
                      <span className="wander-trail__via">
                        {step.via === "poet" ? "شاعره" : step.via === "meter" ? "بحره" : "قافيته"}
                        {step.label ? <span className="wander-trail__label"> — {step.label}</span> : null}
                      </span>
                    ) : (
                      <span className="wander-trail__via">البداية</span>
                    )}
                    <span className="wander-trail__bayt">
                      <bdi>{step.bait.sadr}</bdi>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      ) : (
        <BaytSkeleton rows={1} numbered={false} size="lg" />
      )}
    </div>
  )
}
