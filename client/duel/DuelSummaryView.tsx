/**
 * `#/duel/summary` — what the مساجلة amounted to (design-ux.md §4 Summary).
 *
 * The order is the order the doc puts it in, because it is an argument: the
 * headline says what happened, the four numbers say how well, the ribbon shows
 * the SHAPE of the chain, the أبيات are re-read with their شعراء finally named,
 * and only then comes the retention mechanic — «لقيت 47 شاعرًا من 2400», with
 * the شعراء you met for the first time marked with a gold نِيب.
 *
 * A شاعر counts as new against the snapshot `duelStore` took BEFORE the duel
 * (`poetsMetBefore`), not against the profile as it stands now — by the time
 * this view renders, the profile has already absorbed this duel's شعراء.
 *
 * «الشعراء الذين لقيتهم» is the real PoetCard grid design-ux.md §4 asks for,
 * not a row of chips. An `Exchange` denormalizes only `{slug, name}` — enough
 * to render offline, not enough for a card — so the slugs are traded for full
 * rows in ONE request (`/api/poets?slugs=`). That request is allowed to fail:
 * the name it already has is rendered as the old chip, so a summary read on a
 * dead connection still names every شاعر the مساجلة met.
 */
import { useEffect, useMemo, useState } from "react"
import {
  BAYT_FORMS,
  SHAIR_FORMS,
  countedNounAccusative,
  countedNounGenitive,
  formatBaits,
  formatClock,
  formatCount,
  formatScore,
} from "../../shared/format.ts"
import type { PoetSummary } from "../../shared/schema.ts"
import { getPoetsBySlugs } from "../api/queries.ts"
import { PoetCard } from "../views/shared.tsx"
import { FLAVOR } from "../data/flavor.ts"
import { Nib, Rule } from "../components/Ornaments.tsx"
import { Panel } from "../components/Panel.tsx"
import { navigate, routeHash } from "../router.ts"
import { useCollections } from "../store/collectionsStore.ts"
import { openShareCard } from "../share/ShareDialog.tsx"
import { loadMeta } from "../store/libraryStore.ts"
import { motionReduced, useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import {
  arsenalLettersBefore,
  exitDuel,
  loadProfile,
  playAgain,
  poetsMetBefore,
  recordFinishedDuel,
  useDuel,
} from "../store/duelStore.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { writeClipboard } from "../bayt/copy.ts"
import { nativeShareText } from "../platform/share.ts"
import { ExchangeLog, pulseExchange } from "./ExchangeLog.tsx"
import { playerTurns, type DuelOutcome, type DuelState } from "./machine.ts"
import { shareText } from "./share.ts"
import { firstLetterOf } from "../../shared/arabic.ts"

/** An `Exchange` is already the denormalized shape المختارات persist. */
function savedFromBait2(e: {
  baytKey: string
  baitId: number | null
  sadr: string
  ajuz: string | null
  poemId: string | null
  poet: { slug: string; name: string } | null
  meter: { slug: string; name: string; variant: string | null } | null
}) {
  return { baytKey: e.baytKey, baitId: e.baitId, sadr: e.sadr, ajuz: e.ajuz, poemId: e.poemId, poet: e.poet, meter: e.meter }
}

export function headlineOf(outcome: DuelOutcome, chain: number): string {
  switch (outcome) {
    case "stumped":
      return "أفحمتَ الخصم"
    case "defeat":
      return "انقضت الأرواح"
    case "abandoned":
      return "انسحبتَ"
    case "match":
      return "انتهت المبارزة"
    default:
      return chain > 0 ? `سلسلة من ${countedNounGenitive(chain, BAYT_FORMS)}` : "لم تبدأ المساجلة"
  }
}

/** Distinct شعراء met in this مساجلة, in the order they were recited. */
export function poetsOf(s: DuelState): { slug: string; name: string }[] {
  const seen = new Map<string, { slug: string; name: string }>()
  for (const e of s.exchanges) if (e.poet && !seen.has(e.poet.slug)) seen.set(e.poet.slug, e.poet)
  return [...seen.values()]
}

/** Letters the PLAYER actually answered on — what the arsenal gained. */
export function lettersGained(s: DuelState): string[] {
  const out: string[] = []
  for (const e of s.exchanges) {
    if (e.side !== "player") continue
    const l = firstLetterOf(e.sadr)
    if (l && !out.includes(l)) out.push(l)
  }
  return out
}

function BigNumber({ label, value }: { label: string; value: string }) {
  return (
    <div className="bignum">
      <span className="bignum__val">{value}</span>
      <span className="bignum__label">{label}</span>
    </div>
  )
}

export function DuelSummaryView() {
  const session = useDuel((s) => s.session)
  const settings = useSettings()
  const reduced = motionReduced(settings)
  const add = useCollections((s) => s.add)
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)
  const [totalPoets, setTotalPoets] = useState<number | null>(null)
  /** slug → the full row, once `/api/poets?slugs=` has answered */
  const [poetCards, setPoetCards] = useState<ReadonlyMap<string, PoetSummary>>(new Map())
  /** bumped once the duel has been written, so «لقيت …» re-reads the profile */
  const [recorded, setRecorded] = useState(0)
  const profile = useMemo(() => loadProfile(), [session?.endedAt, recorded])
  const metBefore = useMemo(() => poetsMetBefore(), [session?.startedAt])
  const lettersBefore = useMemo(() => arsenalLettersBefore(), [session?.startedAt])

  useEffect(() => {
    if (!session) navigate({ view: "duel" }, true)
  }, [session])

  // The مساجلة lands in the profile and the ترسانة here, not only on the
  // transition that opened this screen — a summary that survived a reload has
  // dispatched nothing, and the letters it won would otherwise never be
  // counted. `recordFinishedDuel` is idempotent per session.
  useEffect(() => {
    recordFinishedDuel()
    setRecorded((n) => n + 1)
  }, [session?.startedAt, session?.exchanges.length])

  useEffect(() => {
    let live = true
    loadMeta()
      .then((m) => {
        if (live) setTotalPoets(m.counts.poets)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // One batch request for every شاعر this مساجلة met. Keyed on the joined
  // slugs rather than on `session`, so a re-render (a ♥, a toast) does not
  // re-ask, and so a «مرة أخرى» that meets different شعراء does.
  const metSlugs = useMemo(() => (session ? poetsOf(session).map((p) => p.slug) : []), [session?.exchanges.length])
  const metKey = metSlugs.join(",")
  useEffect(() => {
    if (metSlugs.length === 0) return
    let live = true
    getPoetsBySlugs(metSlugs)
      .then((res) => {
        if (live) setPoetCards(new Map(res.items.map((p) => [p.slug, p])))
      })
      .catch(() => {
        /* the chip fallback below is the offline answer */
      })
    return () => {
      live = false
    }
  }, [metKey])

  if (!session) return null

  const chain = playerTurns(session)
  // `endedAt` IS persisted now (v2), so a reloaded summary keeps its real
  // elapsed time. The last بيت's timestamp stays the floor: a v1 payload
  // migrated forward, or a session that ended before either was recorded.
  const lastAt = session.exchanges.length ? session.exchanges[session.exchanges.length - 1]!.at : 0
  const elapsed = Math.max(0, Math.max(session.endedAt ?? 0, lastAt) - session.startedAt)
  const poets = poetsOf(session)
  const gained = lettersGained(session)
  type Bead = { letter: string; side: "player" | "opponent"; key: string; i: number }
  const ribbon: Bead[] = []
  session.exchanges.forEach((e, i) => {
    if (e.requiredLetter) ribbon.push({ letter: e.requiredLetter, side: e.side, key: e.baytKey, i })
  })

  const share = () => {
    const text = shareText({
      dayKey: session.dailyDate,
      letters: ribbon.map((r) => r.letter),
      chainLength: chain,
      score: session.score,
      stumped: session.outcome === "stumped",
      poetName: session.config.poetName,
      albumTitle: session.config.album?.title ?? null,
    })
    void nativeShareText(text).then((shared) => {
      if (shared) return
      void writeClipboard(text).then((ok) => toast(ok ? "نُسخت الخلاصة" : "تعذّر النسخ", ok ? "ok" : "warn"))
    })
  }

  const keep = () => {
    let n = 0
    for (const e of session.exchanges) {
      if (e.side !== "player") continue
      add({
        baytKey: e.baytKey,
        baitId: e.baitId,
        sadr: e.sadr,
        ajuz: e.ajuz,
        poemId: e.poemId,
        poet: e.poet,
        meter: e.meter,
      })
      n++
    }
    toast(n ? `حُفظ ${formatBaits(n)} في المختارات` : "لا أبيات لك في هذه المساجلة", n ? "ok" : "warn")
  }

  const again = () => {
    playAgain()
    navigate({ view: "duel-play" })
  }

  const leave = () => {
    exitDuel()
    navigate({ view: "duel" })
  }

  return (
    <div className="view duel-summary">
      <h1 className="summary-headline">{headlineOf(session.outcome, chain)}</h1>
      {/* The قيد the مساجلة was fought under, under the headline that says how
          it ended — «سلسلة من 6 أبيات» means one thing against the whole ديوان
          and another inside one شاعر's, whose قوافي may only answer on four
          letters. It is the same sentence the share text carries, and it is a
          LINK: the fastest thing a reader wants after a duel in a ديوان is that
          ديوان. Only the شاعر is named here; عصر and بحر narrow a pool, a شاعر
          names an opponent. */}
      {session.config.album ? (
        <p className="summary-scope">
          مساجلة في ديوان{" "}
          <a href={routeHash({ view: "diwan", code: session.config.album.code })}>
            <bdi>«{session.config.album.title}»</bdi>
          </a>
        </p>
      ) : null}
      {!session.config.album && session.config.poetName && session.config.filters.poet ? (
        <p className="summary-scope">
          مساجلة في ديوان{" "}
          <a href={routeHash({ view: "poet", slug: session.config.filters.poet })}>
            <bdi>{session.config.poetName}</bdi>
          </a>
        </p>
      ) : null}
      <Rule style={{ inlineSize: "min(22rem, 70%)" }} />

      {/* the SAME scale the HUD showed all duel — a player who watched «320»
          for ten exchanges must not be handed «٥٣٤» here (Hud.tsx header) */}
      <div className="bignums">
        <BigNumber label="النقاط" value={formatScore(session.score)} />
        <BigNumber label="أطول سلسلة" value={formatScore(session.best)} />
        <BigNumber label="أبياتك" value={formatScore(chain)} />
        <BigNumber label="الوقت" value={formatClock(elapsed)} />
      </div>

      {/* The one line meant to land after a loss, so it is set as a بيت — the
          two-hemistich plate at verse scale, through the only بيت renderer —
          not as a single ellipsis-joined run smaller than the meta beneath it. */}
      {session.outcome === "defeat" ? (
        <div className="summary-flavor">
          <BaytPlate
            variant="plate"
            size="sm"
            sadr={FLAVOR.defeat.sadr}
            ajuz={FLAVOR.defeat.ajuz}
            tashkeel={settings.tashkeel}
            label="بيت الخسارة"
          />
          {FLAVOR.defeat.poet ? <p className="summary-flavor__poet">{FLAVOR.defeat.poet}</p> : null}
        </div>
      ) : null}

      {ribbon.length ? (
        <section className="summary-sect" aria-labelledby="sum-ribbon">
          <h2 className="section-title" id="sum-ribbon">
            سلسلة الحروف
          </h2>
          <ol className="ribbon">
            {ribbon.map((r) => (
              <li key={`${r.key}:${r.i}`}>
                <button
                  type="button"
                  className="ribbon__letter"
                  data-side={r.side}
                  onClick={() => pulseExchange(r.key)}
                  title={r.side === "player" ? "بيتك" : "بيت الخصم"}
                >
                  <bdi>{r.letter}</bdi>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {session.exchanges.length ? (
        <section className="summary-sect" aria-labelledby="sum-abyat">
          <h2 className="section-title" id="sum-abyat">
            الأبيات
          </h2>
          <ExchangeLog
            exchanges={session.exchanges}
            variant="summary"
            ended
            reduced={reduced}
            tashkeel={settings.tashkeel}
            showRawiyy={settings.showRawiyy}
            isFavorite={(k) => favorites.some((f) => f.baytKey === k)}
            onFavorite={(e) => {
              const on = toggleFavorite(savedFromBait2(e))
              toast(on ? "أُضيف إلى المختارات" : "أُزيل من المختارات", on ? "ok" : "info")
            }}
            onCard={(e) => openShareCard({ sadr: e.sadr, ajuz: e.ajuz, poet: e.poet?.name ?? null })}
            onCopied={() => toast("نُسخ البيت", "ok")}
          />
        </section>
      ) : null}

      {poets.length ? (
        <section className="summary-sect" aria-labelledby="sum-poets">
          <h2 className="section-title" id="sum-poets">
            الشعراء الذين لقيتهم
          </h2>
          <ul className="met-grid">
            {poets.map((p) => {
              const fresh = !metBefore.has(p.slug)
              const card = poetCards.get(p.slug)
              return (
                <li key={p.slug} className="met-cell" data-new={fresh ? "1" : undefined}>
                  {card ? <PoetCard poet={card} /> : (
                    <a className="met" href={routeHash({ view: "poet", slug: p.slug })}>
                      <bdi className="met__name">{p.name}</bdi>
                    </a>
                  )}
                  {fresh ? (
                    <span className="met-cell__nib" title="جديد عليك" aria-label="جديد عليك">
                      <Nib size={16} />
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <p className="met-total">
            {/* «لقيتَ» is transitive, so the معدود is مفعول به and منصوب:
                «لقيتَ شاعرًا واحدًا», never «لقيتَ شاعر واحد» — which is what
                the first and second summary of every new player said. */}
            لقيتَ {countedNounAccusative(profile.poetsMet.length, SHAIR_FORMS)}
            {totalPoets ? <> من {formatCount(totalPoets)}</> : null}
          </p>
        </section>
      ) : null}

      {gained.length ? (
        <section className="summary-sect" aria-labelledby="sum-arsenal">
          <h2 className="section-title" id="sum-arsenal">
            زدتَ في ترسانتك
          </h2>
          <ul className="gained">
            {gained.map((l) => (
              <li key={l} className="gained__letter" data-new={lettersBefore.has(l) ? undefined : "1"}>
                <bdi>{l}</bdi>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Panel quiet className="summary-acts">
        <div className="summary-acts__inner">
          <button type="button" className="btn btn--primary" onClick={again}>
            مرة أخرى
          </button>
          <button type="button" className="btn" onClick={keep}>
            احفظ أبياتك
          </button>
          <button type="button" className="btn" onClick={share}>
            شارك
          </button>
          <button type="button" className="btn btn--ghost" onClick={leave}>
            إلى الإعداد
          </button>
        </div>
      </Panel>
    </div>
  )
}
