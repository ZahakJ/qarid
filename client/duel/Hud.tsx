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
 */
import { Nib } from "../components/Ornaments.tsx"
import { formatScore } from "../../shared/format.ts"

export function Hud({
  lives,
  maxLives,
  streak,
  score,
  used,
  onAbandon,
}: {
  lives: number
  maxLives: number
  streak: number
  score: number
  used: number
  onAbandon?: () => void
}) {
  return (
    <div className="duel-hud">
      <div className="duel-hud__lives" role="img" aria-label={`${formatScore(lives)} من ${formatScore(maxLives)} أرواح`}>
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
        <span className="duel-hud__score">{formatScore(score)}</span>
      </div>

      <div className="duel-hud__stat duel-hud__stat--quiet">
        <span className="duel-hud__label">الأبيات</span>
        <span className="duel-hud__used">{formatScore(used)}</span>
      </div>

      {onAbandon ? (
        <button type="button" className="btn btn--ghost duel-hud__quit" onClick={onAbandon}>
          انسحب
        </button>
      ) : null}
    </div>
  )
}
