/**
 * The sticky duel HUD (design-ux.md §4 Play): lives as نِيب SVGs — a spent life
 * drops to 18% opacity rather than disappearing, so the row never reflows —
 * plus the streak, the score and the count of أبيات said.
 *
 * ONE numeral scale in this strip — and, since the owner's 2026-08-24 call,
 * one in the whole app: Western digits everywhere («×7», «320», «5 أبيات»).
 * The strip once carried three scales inside 400px, and the same score the
 * player watched as «320» all duel was shown as «٥٣٤» on the summary. What is
 * left of that rule is only the FONT: the HUD, the clock and the summary's big
 * numbers are the game's instruments, so they are mono and `tabular-nums`.
 *
 * The score shown is `displayScore`: hints are deducted the instant they are
 * bought even though they are only settled against the award later, so the
 * number a player watches always tells the truth about what they have spent.
 *
 * It COUNTS UP to each new total (v2.md §6) over 420ms — never past it, always
 * landing on the exact figure (client/hooks/useCountUp.ts), tabular so the
 * strip cannot twitch while it runs, and switched off entirely when motion is
 * reduced. The count is a decoration on a number that is already decided; no
 * turn, no keystroke and no request ever waits for it.
 */
import { Nib } from "../components/Ornaments.tsx"
import { useCountUp } from "../hooks/useCountUp.ts"
import { motionReduced, useSettings } from "../store/settingsStore.ts"
import { countedNoun, formatScore, ROUH_FORMS } from "../../shared/format.ts"

export function Hud({
  lives,
  maxLives,
  streak,
  score,
  used,
  onAbandon,
  slim = false,
  clock = null,
  clockTone,
}: {
  lives: number
  maxLives: number
  streak: number
  score: number
  used: number
  onAbandon?: () => void
  /**
   * The PHONE's game screen (client/styles/phone.css). One row under the app
   * bar instead of a card: the same instruments, no labels wrapping onto a
   * second line, and the clock moved up into it — down in the docked desk it
   * would be the one number the thumb covers.
   */
  slim?: boolean
  /** `formatClock(ms)`, already formatted; only read when `slim` */
  clock?: string | null
  clockTone?: "warn" | "danger"
}) {
  const settings = useSettings()
  const shownScore = useCountUp(score, { enabled: !motionReduced(settings) })
  return (
    <div className={slim ? "duel-hud duel-hud--slim" : "duel-hud"}>
      {/* The معدود is not hard-coded to the plural: at رتبة سيف (maxLives 1) a
          screen reader used to hear «1 من 1 أرواح». Same shape RoomView's
          strikes use — countedNoun, from shared/format.ts. */}
      <div
        className="duel-hud__lives"
        role="img"
        aria-label={`بقيت لك ${countedNoun(lives, ROUH_FORMS)} من ${formatScore(maxLives)}`}
      >
        {Array.from({ length: maxLives }, (_, i) => (
          <span key={i} className="duel-hud__nib" data-spent={i >= lives ? "1" : undefined}>
            <Nib size={20} />
          </span>
        ))}
      </div>

      <div className="duel-hud__stat" data-hot={streak >= 3 ? "1" : undefined}>
        <span className="duel-hud__label">السلسلة</span>
        {/* «×7» is a NEUTRAL × in front of a number: in this RTL strip the bidi
            algorithm hands it the paragraph direction and it lands on the wrong
            side («7×»). `dir="ltr"` makes the pair its own LTR isolate. */}
        <span className="duel-hud__streak" dir="ltr">
          ×{formatScore(streak)}
        </span>
      </div>

      <div className="duel-hud__stat">
        <span className="duel-hud__label">النقاط</span>
        <span className="duel-hud__score countup">{formatScore(shownScore)}</span>
      </div>

      <div className="duel-hud__stat duel-hud__stat--quiet">
        <span className="duel-hud__label">الأبيات</span>
        <span className="duel-hud__used">{formatScore(used)}</span>
      </div>

      {/* The clock rides in the strip only on the phone's game screen: on the
          web it is under the required letter, where the eye already is. */}
      {slim && clock !== null ? (
        <span className="duel-hud__clock" data-tone={clockTone} role="timer" aria-label="ما بقي من وقت الدور">
          {clock}
        </span>
      ) : null}

      {/* «انسحب» is the app bar's chevron on the phone («انسحب؟»), so the strip
          does not carry it twice — and the width it costs is the width the
          clock needs. */}
      {onAbandon && !slim ? (
        <button type="button" className="btn btn--ghost duel-hud__quit" onClick={onAbandon}>
          انسحب
        </button>
      ) : null}
    </div>
  )
}
