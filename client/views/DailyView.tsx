/**
 * `#/daily` — تحدّي اليوم (design-ux.md §5 Daily, amendments.md §6).
 *
 * The same opening بيت for everyone, one life, no clock, one attempt a day,
 * and a share block at the end. The mechanics are the duel's: this view starts
 * a session whose `dailyDate` is set, which is what makes `duelStore` seed
 * every request with `daily:<day>[:turn]` — so the whole chain, opponent
 * included, is identical for every player of that day.
 *
 * The one-attempt rule is enforced against `qarid:v1:profile` and is stated on
 * screen as what it is: a rail, not a lock (client/duel/daily.ts).
 */
import { useMemo, useState } from "react"
import { NUQTA_FORMS, countedUnit, formatBaits, formatCount } from "../../shared/format.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { writeClipboard } from "../bayt/copy.ts"
import { nativeShareText } from "../platform/share.ts"
import { FLAVOR } from "../data/flavor.ts"
import { Rule } from "../components/Ornaments.tsx"
import { Panel } from "../components/Panel.tsx"
import { DuelPlayView } from "../duel/DuelPlayView.tsx"
import { dailyConfig, playedToday, riyadhDay } from "../duel/daily.ts"
import { arabicDay, letterRibbon, shareText } from "../duel/share.ts"
import { loadProfile, startDuel, useDuel } from "../store/duelStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { routeHash } from "../router.ts"

export function DailyView() {
  const session = useDuel((s) => s.session)
  const settings = useSettings()
  const [tick, setTick] = useState(0)
  const day = useMemo(() => riyadhDay(), [])
  const profile = useMemo(() => loadProfile(), [tick, session?.phase])
  const result = profile.dailyResults[day] ?? null
  const live = session && session.dailyDate === day && session.phase !== "summary" && session.phase !== "idle"

  // A مساجلة already in flight owns the screen — the duel's own view renders it.
  if (live) return <DuelPlayView />

  const begin = () => {
    startDuel(dailyConfig(), day)
    setTick((n) => n + 1)
  }

  const share = () => {
    if (!result) return
    const text = shareText({
      dayKey: day,
      letters: result.letters,
      chainLength: result.chainLength,
      score: result.score,
    })
    // The native shell opens the OS share sheet; the web copies to the clipboard.
    void nativeShareText(text).then((shared) => {
      if (shared) return
      void writeClipboard(text).then((ok) => toast(ok ? "نُسخ التحدّي" : "تعذّر النسخ", ok ? "ok" : "warn"))
    })
  }

  return (
    <div className="view daily">
      <div className="view__head">
        <h1 className="view__title">تحدّي {arabicDay(day)}</h1>
        <p className="view__lede">مطلعٌ واحد للناس جميعًا، وروحٌ واحدة، بلا وقت. محاولة واحدة في اليوم.</p>
      </div>
      <Rule />

      {result ? (
        <Panel illuminated title="ما بلغتَه اليوم">
          <div className="daily-result">
            <p className="daily-result__line">
              <span className="daily-result__n">{formatCount(result.score)}</span>{" "}
              {countedUnit(result.score, NUQTA_FORMS)} ·{" "}
              {formatBaits(result.chainLength)}
            </p>
            {result.letters.length ? (
              <p className="daily-result__ribbon">
                <bdi>{letterRibbon(result.letters)}</bdi>
              </p>
            ) : null}
            <pre className="daily-share" aria-label="نص المشاركة">
              {shareText({
                dayKey: day,
                letters: result.letters,
                chainLength: result.chainLength,
                score: result.score,
              })}
            </pre>
            <div className="daily-acts">
              <button type="button" className="btn btn--primary" onClick={share}>
                انسخ للمشاركة
              </button>
              <a className="btn" href={routeHash({ view: "duel" })}>
                مساجلة بلا قيد
              </a>
            </div>
          </div>
        </Panel>
      ) : (
        /* A hero card, not a 1,730px frame with 300px of content huddled in
           one corner and the illumination stranded at corners nothing reaches.
           One call to action, not two: the panel used to head itself «ابدأ
           التحدّي» and then repeat it on the button 100px below. */
        <Panel illuminated className="daily-open">
          <div className="daily-open__inner">
            <p className="daily-open__terms">
              <span>روحٌ واحدة</span>
              <span aria-hidden="true">·</span>
              <span>بلا وقت</span>
              <span aria-hidden="true">·</span>
              <span>مطلعٌ واحد للجميع</span>
            </p>
            <BaytPlate
              variant="plate"
              size="sm"
              sadr={FLAVOR["search-none"].sadr}
              ajuz={FLAVOR["search-none"].ajuz}
              tashkeel={settings.tashkeel}
              label="بيت التحدّي"
            />
            <p className="daily-open__attrib">{FLAVOR["search-none"].poet}</p>
            <button type="button" className="btn btn--primary btn--lg" onClick={begin}>
              ابدأ تحدّي اليوم
            </button>
            <p className="panel__note">
              {playedToday(profile, day)
                ? "لعبتَ اليوم."
                : "المحاولة واحدة، والحساب على شرفك — التحدّي محفوظ في متصفحك وحده."}
            </p>
          </div>
        </Panel>
      )}
    </div>
  )
}
