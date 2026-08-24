/**
 * The sticky duel HUD (design-ux.md §4 Play): lives as نِيب SVGs — a spent life
 * drops to 18% opacity rather than disappearing, so the row never reflows —
 * plus the streak, the score and the count of أبيات said.
 *
 * ONE numeral scale in this strip. It used to carry three — «×٢» Arabic-Indic,
 * «320» Latin and «٥ أبيات» a counted noun — inside 400px, and the same score
 * the player watched as «320» all duel was then shown as «٥٣٤» on the summary.
 * design-ux.md §2 draws the line at «stats/timers Latin tabular-nums», and the
 * HUD, the clock and the summary's big numbers are exactly that: the game's
 * instruments, not prose. Everything that is prose — chip counts, verse
 * numbers, corpus statistics — stays Arabic-Indic through `formatCount`.
 *
 * The score shown is `displayScore`: hints are deducted the instant they are
 * bought even though they are only settled against the award later, so the
 * number a player watches always tells the truth about what they have spent.
 */
import { Nib } from "../components/Ornaments.tsx"
import { formatScore, toArabicDigits } from "../../shared/format.ts"

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
      <div className="duel-hud__lives" role="img" aria-label={`${toArabicDigits(lives)} من ${toArabicDigits(maxLives)} أرواح`}>
        {Array.from({ length: maxLives }, (_, i) => (
          <span key={i} className="duel-hud__nib" data-spent={i >= lives ? "1" : undefined}>
            <Nib size={20} />
          </span>
        ))}
      </div>

      <div className="duel-hud__stat" data-hot={streak >= 3 ? "1" : undefined}>
        <span className="duel-hud__label">السلسلة</span>
        <span className="duel-hud__streak">×{formatScore(streak)}</span>
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
