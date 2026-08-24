/**
 * `#/duel/summary` — what the مساجلة amounted to (design-ux.md §4 Summary).
 *
 * The order is the order the doc puts it in, because it is an argument: the
 * headline says what happened, the four numbers say how well, the ribbon shows
 * the SHAPE of the chain, the أبيات are re-read with their شعراء finally named,
 * and only then comes the retention mechanic — «لقيت ٤٧ شاعرًا من ٢٤٠٠», with
 * the شعراء you met for the first time marked with a gold نِيب.
 *
 * A شاعر counts as new against the snapshot `duelStore` took BEFORE the duel
 * (`poetsMetBefore`), not against the profile as it stands now — by the time
 * this view renders, the profile has already absorbed this duel's شعراء.
 */
import { useEffect, useMemo, useState } from "react"
import { formatBaits, formatClock, formatCount, formatPoets, formatScore } from "../../shared/format.ts"
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
      return chain > 0 ? `سلسلة من ${formatBaits(chain)}` : "لم تبدأ المساجلة"
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

  if (!session) return null

  const chain = playerTurns(session)
  // `endedAt` is transient (it is not in DuelSessionSlice), so a summary that
  // survived a reload has none — the last بيت's timestamp is the honest floor.
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
    })
    void writeClipboard(text).then((ok) => toast(ok ? "نُسخت الخلاصة" : "تعذّر النسخ", ok ? "ok" : "warn"))
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
            numerals={settings.numerals}
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
            numerals={settings.numerals}
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
              return (
                <li key={p.slug}>
                  <a className="met" href={routeHash({ view: "poet", slug: p.slug })} data-new={fresh ? "1" : undefined}>
                    {fresh ? (
                      <span className="met__nib" title="جديد عليك">
                        <Nib size={16} />
                      </span>
                    ) : null}
                    <bdi className="met__name">{p.name}</bdi>
                  </a>
                </li>
              )
            })}
          </ul>
          <p className="met-total">
            لقيتَ {formatPoets(profile.poetsMet.length)}
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
