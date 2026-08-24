/**
 * #/train/arsenal — ثمانية وعشرون حرفًا، وما تحتها (design-ux.md §5,
 * amendments.md §10).
 *
 * The page answers one question: which letter is going to end your next
 * مساجلة? The heatmap shows what you hold, the demand column shows what the
 * corpus will ask of you, and «الضعف» multiplies the two — a letter you have
 * nothing on is only a danger in proportion to how often a عجز ends on it.
 * ظ is empty for everybody and almost never demanded; م is demanded constantly
 * and is the letter to have eight أبيات ready on.
 *
 * Both numbers under a letter are real and different:
 *   مستعمَل — أبيات you have actually played in a duel (`duelStore` writes it
 *             at every summary, off the accepted exchanges)
 *   محفوظ  — drill cards on that letter that reached a 21-day interval
 */
import { useEffect, useRef, useState } from "react"

import { formatBaits, formatCount, formatScore } from "../../shared/format.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import type { MetaResponse } from "../../shared/schema.ts"
import { Rule } from "../components/Ornaments.tsx"
import { Panel } from "../components/Panel.tsx"
import { navigate, routeHash } from "../router.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { useTraining } from "../store/trainingStore.ts"
import { ArsenalHeatmap, FULL_AT } from "../training/ArsenalHeatmap.tsx"
import { SUPPLY_TARGET, coverageOf, letterStats, weakestLetters, type LetterStat } from "../training/arsenal.ts"

/** How many weak letters the bottom list names. */
const WEAK_SHOWN = 5

export function ArsenalView() {
  const cards = useTraining((s) => s.cards)
  const arsenal = useTraining((s) => s.arsenal)
  const reload = useTraining((s) => s.reload)

  const [meta, setMeta] = useState<MetaResponse | null>(null)
  /** `null` = nothing chosen YET; the effect below opens on the weakest letter. */
  const [active, setActive] = useState<HijaiLetter | null>(null)

  useEffect(() => reload(), [reload])

  useEffect(() => {
    const ac = new AbortController()
    loadMeta(ac.signal)
      .then((m) => !ac.signal.aborted && setMeta(m))
      .catch(() => undefined)
    return () => ac.abort()
  }, [])

  const stats = letterStats({ letters: meta?.letters ?? null, arsenal, cards })

  // The page opens on the letter that is going to cost you — an arsenal with
  // an empty detail panel makes the reader hunt for the point of the grid. It
  // happens ONCE, on a ref rather than on `active`, so closing the panel by
  // clicking the lit letter again does not immediately reopen it.
  const opened = useRef(false)
  if (!opened.current && meta) {
    const worst = weakestLetters(stats, 1)[0]
    if (worst) {
      opened.current = true
      if (active === null) setActive(worst.letter)
    }
  }

  const coverage = coverageOf(stats)
  const weak = weakestLetters(stats, WEAK_SHOWN)
  const selected = active ? (stats.find((s) => s.letter === active) ?? null) : null
  const totalHeld = stats.reduce((n, s) => n + s.supply, 0)

  return (
    <div className="view arsenal-view">
      <header className="view__head">
        <h1 className="view__title">الترسانة</h1>
        <p className="view__lede">
          ما تملك أن تُجيب به، حرفًا حرفًا. كلّما امتلأ الحرف قلّ أن يُوقعك، وكلّما كثر الطلبُ عليه عظُم خطره.
        </p>
      </header>

      <div className="arsenal-shell">
        <Panel illuminated className="arsenal-grid-panel">
          <ArsenalHeatmap stats={stats} active={active} onPick={(l) => setActive(l === active ? null : l)} />
          <p className="arsenal-legend">
            <span className="arsenal-legend__swatch" style={{ opacity: 0.25 }} />
            <span className="arsenal-legend__swatch" style={{ opacity: 0.6 }} />
            <span className="arsenal-legend__swatch" style={{ opacity: 1 }} />
            <span className="arsenal-legend__cap">من بيتٍ واحد إلى {formatCount(FULL_AT)}</span>
          </p>
        </Panel>

        <div className="arsenal-side">
          <div className="arsenal-summary">
            <Ring covered={coverage.covered} total={coverage.total} />
            <dl className="arsenal-figures">
              <div>
                <dt>أبيات في ترسانتك</dt>
                <dd className="num">{formatCount(totalHeld)}</dd>
              </div>
              <div>
                <dt>بطاقات المذاكرة</dt>
                <dd className="num">{formatCount(Object.keys(cards).length)}</dd>
              </div>
            </dl>
          </div>

          {selected ? (
            <LetterDetail stat={selected} />
          ) : (
            <p className="arsenal-hint">اختر حرفًا من الشبكة لترى ما تحته — وما يُطلب منك عليه.</p>
          )}
        </div>
      </div>

      <section className="arsenal-weak" aria-labelledby="weak-title">
        <div className="arsenal-weak__head">
          <h2 className="section-title" id="weak-title">
            الحروف الضعيفة
          </h2>
          <Rule />
        </div>
        {weak.length === 0 ? (
          <p className="arsenal-hint">
            {meta ? "لا حرف ضعيفًا — إمّا أنّك مستعدّ، وإمّا أنّك لم تُساجل بعد." : "…تُحسب من الديوان"}
          </p>
        ) : (
          <ul className="weakrow-list">
            {weak.map((s) => (
              <li className="weakrow" key={s.letter}>
                <span className="weakrow__ch" aria-hidden="true">
                  {s.letter}
                </span>
                <span className="weakrow__name">{LETTER_NAMES[s.letter]}</span>
                <span className="weakrow__bar" aria-hidden="true">
                  <span className="weakrow__fill" style={{ inlineSize: `${Math.round(s.weakness * 100)}%` }} />
                </span>
                <span className="weakrow__facts">
                  <span className="num" title="عندك">
                    {formatScore(s.supply)}
                  </span>
                  <span className="weakrow__sep">/</span>
                  <span className="num" title="يُطلب في الديوان">
                    {formatScore(s.demand)}
                  </span>
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
      </section>
    </div>
  )
}

function LetterDetail({ stat }: { stat: LetterStat }) {
  return (
    <section className="letter-detail" aria-live="polite">
      <header className="letter-detail__head">
        <span className="letter-detail__ch" aria-hidden="true">
          {stat.letter}
        </span>
        <span className="letter-detail__name">{LETTER_NAMES[stat.letter]}</span>
      </header>
      <dl className="letter-detail__facts">
        <div>
          <dt>مستعمَل</dt>
          <dd className="num" title="أبيات أجبتَ بها في مساجلة">
            {formatScore(stat.used)}
          </dd>
        </div>
        <div>
          <dt>محفوظ</dt>
          <dd className="num" title="بطاقات بلغت واحدًا وعشرين يومًا">
            {formatScore(stat.mastered)}
          </dd>
        </div>
        <div>
          <dt>يُطلب منك</dt>
          <dd className="num" title="أبيات الديوان التي تنتهي بهذا الحرف">
            {formatScore(stat.demand)}
          </dd>
        </div>
      </dl>
      <p className="letter-detail__note">
        {stat.supply >= SUPPLY_TARGET
          ? `هذا الحرف مؤمَّن — في ترسانتك منه ${formatBaits(stat.supply)}.`
          : `ينقصك ${formatCount(SUPPLY_TARGET - stat.supply)} من ${formatCount(SUPPLY_TARGET)} حتى يُؤمَّن هذا الحرف.`}
      </p>
      <div className="letter-detail__acts">
        <a className="btn btn--primary btn--sm" href={routeHash({ view: "train-drill", letter: stat.letter })}>
          تدرّب على {stat.letter}
        </a>
        <a className="btn btn--ghost btn--sm" href={routeHash({ view: "browse", query: { letter: stat.letter } })}>
          تصفّح أبياته
        </a>
      </div>
    </section>
  )
}

function Ring({ covered, total }: { covered: number; total: number }) {
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
        <span className="ring__cap">حرفًا مغطّى</span>
      </span>
    </div>
  )
}
