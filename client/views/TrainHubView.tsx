/**
 * #/train — the التحفيظ hub (design-ux.md §5).
 *
 * Four questions, answered in the order a memoriser asks them:
 *   ما المستحقّ اليوم؟   the due count, and the one button that starts it
 *   كم يومًا تواليتُ؟     the review streak, as a ribbon of the last seven days
 *   أين ترسانتي ضعيفة؟   the heatmap thumbnail and the three weakest letters
 *   ما الذي عاندني؟      the leeches, with a way out of each
 *
 * Nothing here computes: `client/training/schedule.ts` decides what is due and
 * `client/training/arsenal.ts` decides what is weak. The view reloads the slice
 * on mount because a مساجلة may have written the ترسانة while it was gone
 * (`trainingStore` header).
 */
import { useEffect, useState } from "react"

import { formatCount } from "../../shared/format.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import type { MetaResponse } from "../../shared/schema.ts"
import { EmptyState } from "../components/EmptyState.tsx"
import { Nib, Rule } from "../components/Ornaments.tsx"
import { Panel } from "../components/Panel.tsx"
import { arabicDay } from "../duel/share.ts"
import { navigate, routeHash } from "../router.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { useTraining } from "../store/trainingStore.ts"
import { ArsenalHeatmap } from "../training/ArsenalHeatmap.tsx"
import { coverageOf, letterStats, weakestLetters } from "../training/arsenal.ts"
import { MAX_NEW_PER_DAY, dayKeyOf, dueCount, leechesOf, previousDay } from "../training/schedule.ts"

/** How many days of the streak the ribbon shows. */
const RIBBON_DAYS = 7

export function TrainHubView() {
  const cards = useTraining((s) => s.cards)
  const arsenal = useTraining((s) => s.arsenal)
  const reviewStreak = useTraining((s) => s.reviewStreak)
  const lastReviewDay = useTraining((s) => s.lastReviewDay)
  const introducedToday = useTraining((s) => s.newIntroducedToday)
  const reload = useTraining((s) => s.reload)
  const restore = useTraining((s) => s.restore)
  const drop = useTraining((s) => s.drop)

  const [meta, setMeta] = useState<MetaResponse | null>(null)

  useEffect(() => reload(), [reload])

  useEffect(() => {
    const ac = new AbortController()
    loadMeta(ac.signal)
      .then((m) => !ac.signal.aborted && setMeta(m))
      .catch(() => undefined)
    return () => ac.abort()
  }, [])

  const now = Date.now()
  const today = dayKeyOf(now)
  const due = dueCount(cards, now)
  const total = Object.keys(cards).length
  const leeches = leechesOf(cards)
  const stats = letterStats({ letters: meta?.letters ?? null, arsenal, cards })
  const coverage = coverageOf(stats)
  const weakest = weakestLetters(stats, 3)
  const newLeft = Math.max(0, MAX_NEW_PER_DAY - introducedToday)

  return (
    <div className="view train-view">
      <header className="view__head">
        <h1 className="view__title">التحفيظ</h1>
        <p className="view__lede">
          بطاقةٌ في اليوم تبني ترسانةً في السنة: يُعرض الصدرُ ويُطلب العجز، وما أخطأتَ فيه يعود إليك أقرب.
        </p>
      </header>

      {/* ── المذاكرة ─────────────────────────────────────────────────── */}
      <Panel illuminated className="train-due">
        <div className="train-due__body">
          <div className="train-due__count">
            <span className="train-due__n num">{due}</span>
            <span className="train-due__cap">بطاقة مستحقّة</span>
          </div>
          <div className="train-due__copy">
            <h2 className="train-due__title">المذاكرة</h2>
            <p className="train-due__note">
              {total === 0
                ? "ديوانك فارغ بعد — ابدأ بأبياتٍ مشهورة، تُختار على حروفك الضعيفة."
                : due > 0
                  ? `في ترسانتك ${formatCount(total)} بيتًا محفوظًا أو قيد الحفظ.`
                  : `لا مستحقَّ اليوم. ${newLeft > 0 ? `ولك أن تضيف ${formatCount(newLeft)} أبياتٍ جديدة.` : "وقد أخذتَ نصيبك من الجديد اليوم."}`}
            </p>
            <StreakRibbon streak={reviewStreak} lastDay={lastReviewDay} today={today} />
          </div>
          <a className="btn btn--primary train-due__go" href={routeHash({ view: "train-drill" })}>
            {due > 0 ? "ابدأ المذاكرة" : total === 0 ? "ابدأ من الأبيات المشهورة" : "أبيات جديدة"}
          </a>
        </div>
      </Panel>

      {/* ── الترسانة ─────────────────────────────────────────────────── */}
      <Panel
        title="الترسانة"
        note={`تغطية ${formatCount(coverage.covered)} من ${formatCount(coverage.total)} حرفًا`}
        actions={
          <a className="btn btn--ghost" href={routeHash({ view: "train-arsenal" })}>
            الترسانة كاملة ←
          </a>
        }
        className="train-arsenal-card"
      >
        <div className="train-arsenal-card__body">
          <a
            className="train-arsenal-card__thumb"
            href={routeHash({ view: "train-arsenal" })}
            aria-label="الترسانة كاملة"
          >
            <ArsenalHeatmap stats={stats} interactive={false} compact />
          </a>
          <div className="train-arsenal-card__side">
            <CoverageRing covered={coverage.covered} total={coverage.total} />
            <div className="weak">
              <h3 className="weak__title">الحروف الضعيفة</h3>
              {weakest.length === 0 ? (
                <p className="weak__none">
                  {meta ? "لا حرف ضعيفًا بعد — أو لم تلعب بما يكفي ليُعرف ضعفك." : "…تُحسب من الديوان"}
                </p>
              ) : (
                <ul className="weak__list">
                  {weakest.map((s) => (
                    <li key={s.letter}>
                      <span className="weak__ch" aria-hidden="true">
                        {s.letter}
                      </span>
                      <span className="weak__name">{LETTER_NAMES[s.letter as HijaiLetter]}</span>
                      <span className="weak__n num" title="ما عندك من الأبيات على هذا الحرف">
                        {s.supply}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => navigate({ view: "train-drill", letter: s.letter })}
                      >
                        تدرّب
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </Panel>

      {/* ── تحدّي اليوم ──────────────────────────────────────────────── */}
      <a className="daily-row" href={routeHash({ view: "daily" })}>
        <span className="daily-row__label">تحدّي اليوم</span>
        <span className="daily-row__note">
          مطلعٌ واحد للناس جميعًا، وروحٌ واحدة — <bdi className="daily-row__date">{arabicDay(today)}</bdi>
        </span>
        <span className="daily-row__go">ابدأ ←</span>
      </a>

      {/* ── ما عاندك ─────────────────────────────────────────────────── */}
      {leeches.length > 0 ? (
        <section className="leeches" aria-labelledby="leeches-title">
          <div className="leeches__head">
            <h2 className="section-title" id="leeches-title">
              أبياتٌ عاندتك
            </h2>
            <Rule />
          </div>
          <p className="leeches__note">
            نسيتَ كلًّا منها ثماني مرّات. أعِدها من أوّلها، أو دعها — فما كلّ بيتٍ يُحفظ.
          </p>
          <ul className="leeches__list">
            {leeches.map((card) => (
              <li className="leech" key={card.id}>
                <span className="leech__bayt">
                  <bdi>{card.sadr}</bdi>
                </span>
                <span className="leech__meta">
                  {card.poet ? <bdi className="leech__poet">{card.poet.name}</bdi> : null}
                  {/* `.num` is already `direction: ltr; unicode-bidi: isolate`,
                      which is what keeps the neutral × on the left of the count */}
                  <span className="leech__n num" title="مرّات النسيان">
                    ×{card.lapses}
                  </span>
                </span>
                <span className="leech__acts">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => restore(card.id)}>
                    استبدل
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => drop(card.id)}>
                    احذف
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {total === 0 ? (
        <EmptyState flavor="no-due" title="لم تبدأ الحفظ بعد">
          <p className="empty__hint">
            أوّل عشرة أبيات تُختار لك من مشاهير الشعر، ومن الحروف التي تنقصك في المساجلة.
          </p>
        </EmptyState>
      ) : null}
    </div>
  )
}

/** «تغطية 21 من 28 حرفًا» — the same ring the home screen shows. */
function CoverageRing({ covered, total }: { covered: number; total: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  const ratio = total === 0 ? 0 : covered / total
  return (
    <div className="ring ring--lg" title={`تغطية ${formatCount(covered)} من ${formatCount(total)} حرفًا`}>
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} stroke="var(--line-1)" strokeWidth="3" fill="none" />
        <circle
          cx="32"
          cy="32"
          r={r}
          stroke="var(--accent)"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
          transform="rotate(-90 32 32)"
          opacity={ratio === 0 ? 0.25 : 0.9}
        />
      </svg>
      <span className="ring__label">
        <span className="ring__n num">
          {covered}/{total}
        </span>
        <span className="ring__cap">حرفًا في ترسانتك</span>
      </span>
    </div>
  )
}

/**
 * The last seven days, newest at the START of the line (this is RTL: the ribbon
 * reads right to left like everything else). A day is lit when the streak that
 * ended on `lastDay` still covers it — the slice stores a length and an end,
 * not a calendar, so the ribbon shows exactly what is known and no more.
 */
function StreakRibbon({ streak, lastDay, today }: { streak: number; lastDay: string | null; today: string }) {
  const days: { key: string; lit: boolean }[] = []
  let day = today
  for (let i = 0; i < RIBBON_DAYS; i++) {
    const offsetFromEnd = lastDay === null ? Infinity : distanceInDays(day, lastDay)
    days.push({ key: day, lit: offsetFromEnd >= 0 && offsetFromEnd < streak })
    day = previousDay(day)
  }
  return (
    <p className="streak" title={`${formatCount(streak)} يومًا متتاليًا`}>
      <span className="streak__nib" aria-hidden="true">
        <Nib size={14} />
      </span>
      <span className="streak__dots" aria-hidden="true">
        {days.map((d) => (
          <span className="streak__dot" key={d.key} data-lit={d.lit ? "1" : undefined} />
        ))}
      </span>
      <span className="streak__label">
        {streak > 0 ? `${formatCount(streak)} يومًا متتاليًا` : "لم تبدأ سلسلة المذاكرة"}
      </span>
    </p>
  )
}

/** Whole days between two `YYYY-MM-DD` keys; negative when `a` is after `b`. */
function distanceInDays(a: string, b: string): number {
  const parse = (k: string) => {
    const [y, m, d] = k.split("-").map(Number)
    return y && m && d ? new Date(y, m - 1, d).getTime() : NaN
  }
  const x = parse(a)
  const y = parse(b)
  if (Number.isNaN(x) || Number.isNaN(y)) return Infinity
  return Math.round((y - x) / 86_400_000)
}
