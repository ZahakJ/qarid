/**
 * The sticky duel HUD (design-ux.md §4 Play): lives as نِيب SVGs — a spent life
 * drops to 18% opacity rather than disappearing, so the row never reflows —
 * plus the streak in gold, the score in Plex Mono, and the used-بيت count.
 *
 * The score shown is `displayScore`: hints are deducted the instant they are
 * bought even though they are only settled against the award later, so the
 * number a player watches always tells the truth about what they have spent.
 */
import { Nib } from "../components/Ornaments.tsx"
import { formatBaits, formatScore, toArabicDigits } from "../../shared/format.ts"

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
        <span className="duel-hud__streak">×{toArabicDigits(streak)}</span>
      </div>

      <div className="duel-hud__stat">
        <span className="duel-hud__label">النقاط</span>
        <span className="duel-hud__score">{formatScore(score)}</span>
      </div>

      <div className="duel-hud__stat duel-hud__stat--quiet">
        <span className="duel-hud__label">قيل</span>
        <span className="duel-hud__used">{formatBaits(used)}</span>
      </div>

      {onAbandon ? (
        <button type="button" className="btn btn--ghost duel-hud__quit" onClick={onAbandon}>
          انسحب
        </button>
      ) : null}
    </div>
  )
}
