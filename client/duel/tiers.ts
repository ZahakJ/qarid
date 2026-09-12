/**
 * The four رتب of the مساجلة, with their parameters SHOWN rather than hidden
 * (design-ux.md §4 Setup: "المستوى tiers (params shown, not hidden)").
 *
 * | Tier   | Pool            | Timer | Lives | Hints        | Adversarial |
 * |--------|-----------------|-------|-------|--------------|-------------|
 * | مبتدئ  | top fame decile | 60s   | 3     | full, ½ price| no (avoids ظ ذ غ ز ث) |
 * | شاعر   | top half        | 40s   | 3     | full         | neutral |
 * | فحل    | full            | 25s   | 2     | double price | prefers rare terminals |
 * | سيف    | full            | 15s   | 1     | none         | yes |
 *
 * Everything here is DATA — the prices live in `HINT_COSTS`, the tier→server
 * difficulty map in `TIER_DIFFICULTY`, and the multipliers in `scoring.ts`.
 * This file only says what each رتبة means and how it reads in Arabic, so the
 * setup screen renders a table instead of hard-coding four cards.
 */
import {
  TIER_DIFFICULTY,
  type Difficulty,
  type DuelConfig,
  type DuelTier,
  type TailBias,
} from "../../shared/schema.ts"

export type TierPreset = {
  tier: DuelTier
  /** what the رتبة is called on screen */
  name: string
  /** one line: who this رتبة serves */
  lede: string
  difficulty: Difficulty
  /** amendments.md §5 — the real difficulty lever on /api/game/reply */
  tailBias: TailBias
  /** seconds per turn when the timer is on */
  seconds: number
  lives: number
  /** how the pool reads in Arabic, for the params row */
  pool: string
  hints: string
  adversarial: string
}

export const TIER_PRESETS: readonly TierPreset[] = [
  {
    tier: "beginner",
    name: "مبتدئ",
    lede: "أبيات مشهورة لشعراء يعرفهم كل قارئ",
    difficulty: TIER_DIFFICULTY.beginner,
    tailBias: "easy",
    seconds: 60,
    lives: 3,
    pool: "أشهر الشعراء، ومطالع القصائد",
    hints: "الهمس كاملًا بنصف الثمن",
    adversarial: "يتجنّب الحروف العسرة: ظ ذ غ ز ث",
  },
  {
    tier: "poet",
    name: "شاعر",
    lede: "نصف الديوان الأعلى شهرةً",
    difficulty: TIER_DIFFICULTY.poet,
    tailBias: "none",
    seconds: 40,
    lives: 3,
    pool: "الشعراء المعروفون",
    hints: "الهمس كاملًا",
    adversarial: "لا يقصد إعناتك ولا يرفق بك",
  },
  {
    tier: "champion",
    name: "فحل",
    lede: "الديوان كله، ومن لم تسمع به",
    difficulty: TIER_DIFFICULTY.champion,
    tailBias: "hard",
    seconds: 25,
    lives: 2,
    pool: "الديوان كله",
    hints: "الهمس بضعف الثمن",
    adversarial: "يؤثر القوافي النادرة",
  },
  {
    tier: "sword",
    name: "سيف",
    lede: "روحٌ واحدة، وخمس عشرة ثانية",
    difficulty: TIER_DIFFICULTY.sword,
    tailBias: "hard",
    seconds: 15,
    lives: 1,
    pool: "الديوان كله",
    hints: "لا همس",
    adversarial: "يقصد إعناتك",
  },
]

export function presetOf(tier: DuelTier): TierPreset {
  const found = TIER_PRESETS.find((t) => t.tier === tier)
  // the enum is closed, so this is unreachable — but never crash the setup
  return found ?? TIER_PRESETS[1]!
}

/**
 * design-ux.md §4: «الوقت on/off (off forces tier ≤ شاعر)». Playing فحل or
 * سيف with the clock off would hand away their whole difficulty, so the
 * two upper رتب are simply not offered once the timer is turned off.
 */
export const UNTIMED_TIERS: readonly DuelTier[] = ["beginner", "poet"]

export function tierAllowed(tier: DuelTier, timer: boolean): boolean {
  return timer || UNTIMED_TIERS.includes(tier)
}

/** The رتبة a player lands on when they turn the clock off under فحل/سيف. */
export function clampTier(tier: DuelTier, timer: boolean): DuelTier {
  return tierAllowed(tier, timer) ? tier : "poet"
}

/**
 * A whole config from a رتبة plus the switches the setup screen owns.
 *
 * `assist` is optional here and not on the رتبة: وضع التدريب (v2.md §2) is a
 * property of the SESSION, not of the tier, and every caller that predates it
 * (تحدّي اليوم, the tests) means «off».
 */
export function configFor(
  tier: DuelTier,
  opts: Pick<DuelConfig, "timer" | "format" | "chainMode" | "filters"> & {
    assist?: boolean
    /** display name of `filters.poet` — see `poetName` on DuelConfigSchema */
    poetName?: string | null
    /** the ديوان the opponent recites from — see `album` on DuelConfigSchema */
    album?: DuelConfig["album"]
  },
): DuelConfig {
  const preset = presetOf(clampTier(tier, opts.timer))
  return {
    tier: preset.tier,
    difficulty: preset.difficulty,
    chainMode: opts.chainMode,
    tailBias: preset.tailBias,
    format: opts.format,
    timer: opts.timer,
    turnSeconds: preset.seconds,
    lives: preset.lives,
    // A مساجلة في ديوان is opened from the shelf's own door, which builds the
    // config and then puts the ديوان on it; every other entrance has none.
    album: opts.album ?? null,
    filters: opts.filters,
    // The name is only ever kept for the شاعر the filters actually name: a
    // stale «في ديوان المتنبي» over a duel whose قيد was lifted would be worse
    // than no line at all.
    poetName: opts.filters.poet ? (opts.poetName ?? null) : null,
    assist: opts.assist === true,
  }
}
