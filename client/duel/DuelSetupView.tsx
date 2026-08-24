/**
 * `#/duel` — the setup screen (design-ux.md §4 Setup).
 *
 * Four decisions, all of them with their consequences ON SCREEN rather than
 * hidden behind a difficulty word:
 *
 *  1. المستوى — the four رتب as a table of real parameters (client/duel/tiers.ts).
 *  2. القيود  — optional عصر/بحر, with a LIVE eligible-pool count straight off
 *     `/api/game/pool` (amendments.md §2: a point lookup in `combo_counts`,
 *     0.2 ms on the full corpus). A thin combination WARNS, never blocks.
 *  3. الوقت   — on/off; off forces the رتبة down to شاعر, because فحل and سيف
 *     are timers as much as they are pools.
 *  4. النمط   — الوصال (endless) vs المبارزة (best of ten), and the قاعدة:
 *     الروي (classical, lenient) vs الحرف الأخير (literal, amendments.md §1).
 *
 * The pool request is debounced: /api/game/* shares one token bucket of 12
 * requests per 10 s per IP, and a filter row that fires on every click would
 * spend a duel's worth of tokens before the player pressed ابدأ.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { THIN_POOL_WARNING } from "../../shared/constants.ts"
import { BAYT_FORMS, NUQTA_FORMS, countedUnit, formatCount, formatNumber } from "../../shared/format.ts"
import {
  type ChainMode,
  type DuelFormat,
  type DuelTier,
  type GameFilters,
  type MetaResponse,
} from "../../shared/schema.ts"
import { getGamePool } from "../api/queries.ts"
import { Chip } from "../components/Chip.tsx"
import { Panel } from "../components/Panel.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { navigate } from "../router.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { loadProfile, startDuel } from "../store/duelStore.ts"
import { clampTier, configFor, presetOf, tierAllowed, TIER_PRESETS } from "./tiers.ts"

/**
 * `null` when the pool is still unknown — a count of 0 is a real answer.
 *
 * Two numbers, not one. `total` is the chosen رتبة's own pool and is what the
 * screen SHOWS, because that is the ديوان the duel will normally draw on.
 * `effective` is what it can actually reach: `pickBait` relaxes one tier when
 * the chosen one is dry (server/game.ts `RELAX`) and every arrow points at a
 * strictly larger pool, so «هل هذه القيود صالحة للعب؟» is a question about
 * `effective`. Warning off `total` cried thin over combinations that play
 * perfectly well at مبتدئ, whose relax target is the whole سيف pool.
 */
export type Pool = { total: number; effective: number; stale: boolean } | null

/**
 * Does this combination deserve the «قليل؛ قد ينقطع الخصم سريعًا» warning?
 *
 * Off `effective`, never off `total` — that is the whole of amendments.md §2's
 * second field. A pool still being counted (`null`) warns about nothing.
 */
export function poolIsThin(pool: Pool): boolean {
  return pool !== null && pool.effective < THIN_POOL_WARNING
}

export function DuelSetupView() {
  const [tier, setTier] = useState<DuelTier>("poet")
  const [timer, setTimer] = useState(true)
  const [format, setFormat] = useState<DuelFormat>("endless")
  const [chainMode, setChainMode] = useState<ChainMode>("rhyme")
  const [era, setEra] = useState<string | undefined>(undefined)
  const [meter, setMeter] = useState<string | undefined>(undefined)
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [pool, setPool] = useState<Pool>(null)
  const profile = useMemo(() => loadProfile(), [])

  useEffect(() => {
    let live = true
    loadMeta()
      .then((m) => {
        if (live) setMeta(m)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const effectiveTier = clampTier(tier, timer)
  const preset = presetOf(effectiveTier)
  const filters: GameFilters = useMemo(() => ({ ...(era ? { era } : {}), ...(meter ? { meter } : {}) }), [era, meter])

  // Live «العدد المتاح». Debounced: the setup screen must not eat the duel's
  // rate-limit budget (12 requests / 10 s across all of /api/game/*).
  const seq = useRef(0)
  // …but NOT the first one. Debouncing the initial request meant the setup
  // screen always painted «…يُحسب العدد المتاح» before the number — including
  // in the smoke shot, which shipped a loading string as the state of the route.
  const firstPool = useRef(true)
  useEffect(() => {
    const mine = ++seq.current
    setPool((p) => (p ? { ...p, stale: true } : null))
    const wait = firstPool.current ? 0 : 260
    firstPool.current = false
    const t = setTimeout(() => {
      getGamePool({ difficulty: preset.difficulty, ...filters })
        .then((res) => {
          // `effectiveTotal` is optional on the wire; an older server that does
          // not send it leaves the old behaviour exactly as it was.
          if (mine === seq.current) setPool({ total: res.total, effective: res.effectiveTotal ?? res.total, stale: false })
        })
        .catch(() => {
          if (mine === seq.current) setPool(null)
        })
    }, wait)
    return () => clearTimeout(t)
  }, [preset.difficulty, filters])

  const eras = meta?.eras ?? []
  const meters = (meta?.meters ?? []).filter((m) => m.kind === "bahr")

  const begin = () => {
    startDuel(configFor(effectiveTier, { timer, format, chainMode, filters }))
    navigate({ view: "duel-play" })
  }

  const thin = poolIsThin(pool)

  return (
    <div className="view duel-setup">
      <div className="view__head">
        <h1 className="view__title">المساجلة</h1>
        <p className="view__lede">يُنشد الخصم بيتًا، فتُجيبه ببيت يبدأ برويّه. اضبط الرتبة والقيود، ثم ابدأ.</p>
      </div>
      <Rule />

      {/* ── 1. المستوى ───────────────────────────────────────────────── */}
      <section className="setup-sect" aria-labelledby="setup-tier">
        <h2 className="setup-sect__title" id="setup-tier">
          المستوى
        </h2>
        <ul className="tier-grid">
          {TIER_PRESETS.map((t) => {
            const allowed = tierAllowed(t.tier, timer)
            const active = t.tier === effectiveTier
            return (
              <li key={t.tier}>
                <button
                  type="button"
                  className="tier"
                  data-active={active ? "1" : undefined}
                  disabled={!allowed}
                  aria-pressed={active}
                  onClick={() => setTier(t.tier)}
                >
                  <span className="tier__name">{t.name}</span>
                  <span className="tier__lede">{t.lede}</span>
                  <dl className="tier__params">
                    <div>
                      <dt>الديوان</dt>
                      <dd>{t.pool}</dd>
                    </div>
                    <div>
                      <dt>الوقت</dt>
                      <dd>{timer ? `${formatNumber(t.seconds)} ثانية للبيت` : "بلا وقت"}</dd>
                    </div>
                    <div>
                      <dt>الأرواح</dt>
                      <dd>{formatNumber(t.lives)}</dd>
                    </div>
                    <div>
                      <dt>الهمس</dt>
                      <dd>{t.hints}</dd>
                    </div>
                    <div>
                      <dt>الخصم</dt>
                      <dd>{t.adversarial}</dd>
                    </div>
                  </dl>
                  {!allowed ? <span className="tier__locked">تحتاج إلى تشغيل الوقت</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      {/* ── 2. القيود ────────────────────────────────────────────────── */}
      <section className="setup-sect" aria-labelledby="setup-filters">
        <h2 className="setup-sect__title" id="setup-filters">
          القيود <span className="setup-sect__opt">اختيارية</span>
        </h2>
        <div className="setup-row">
          <span className="setup-row__label">العصر</span>
          <div className="chip-cloud">
            <Chip variant="asr" label="كل العصور" active={!era} onClick={() => setEra(undefined)} />
            {eras.map((e) => (
              <Chip
                key={e.slug}
                variant="asr"
                label={e.name}
                active={era === e.slug}
                onClick={() => setEra(era === e.slug ? undefined : e.slug)}
              />
            ))}
          </div>
        </div>
        <div className="setup-row">
          <span className="setup-row__label">البحر</span>
          <div className="chip-cloud">
            <Chip variant="bahr" label="كل البحور" active={!meter} onClick={() => setMeter(undefined)} />
            {meters.map((m) => (
              <Chip
                key={m.slug}
                variant="bahr"
                slug={m.slug}
                label={m.name}
                active={meter === m.slug}
                onClick={() => setMeter(meter === m.slug ? undefined : m.slug)}
              />
            ))}
          </div>
        </div>
        <p className="setup-pool" data-thin={thin ? "1" : undefined} data-stale={pool?.stale ? "1" : undefined}>
          {pool === null ? (
            "…يُحسب العدد المتاح"
          ) : (
            <>
              العدد المتاح: <span className="setup-pool__n">{formatCount(pool.total)}</span>{" "}
              {countedUnit(pool.total, BAYT_FORMS)}
              {thin ? <span className="setup-pool__warn"> — قليل؛ قد ينقطع الخصم سريعًا</span> : null}
            </>
          )}
        </p>
      </section>

      {/* ── 3+4. الوقت والنمط ────────────────────────────────────────── */}
      <section className="setup-sect setup-sect--switches" aria-labelledby="setup-mode">
        <h2 className="setup-sect__title" id="setup-mode">
          الوقت والنمط
        </h2>
        <div className="setup-switches">
          <label className="switch">
            <input type="checkbox" checked={timer} onChange={(e) => setTimer(e.target.checked)} />
            <span className="switch__label">
              الوقت {timer ? `— ${formatNumber(preset.seconds)} ثانية للبيت` : "— مطفأ"}
            </span>
          </label>

          <Segmented
            label="النمط"
            value={format}
            onChange={setFormat}
            options={[
              { value: "endless", label: "الوصال" },
              { value: "match", label: "المبارزة" },
            ]}
          />

          <Segmented
            label="قاعدة السلسلة"
            value={chainMode}
            onChange={setChainMode}
            options={[
              { value: "rhyme", label: "الروي" },
              { value: "literal", label: "الحرف الأخير" },
            ]}
          />
        </div>
        <p className="setup-note">
          {format === "endless" ? "الوصال: تُساجل حتى تنفد الأرواح." : "المبارزة: عشرة أبيات، والغلبة بالنقاط."}
          {" · "}
          {chainMode === "rhyme"
            ? "الروي: يُقشَر حرف الوصل، ويُقبل الحرفان معًا."
            : "الحرف الأخير: كما يُلفظ آخر العجز، بلا قشر."}
        </p>
      </section>

      <Panel quiet className="setup-go">
        <div className="setup-go__inner">
          <div className="setup-record">
            <span className="setup-record__label">أفضل ما بلغتَ</span>
            <span className="setup-record__val">
              {formatCount(profile.bestScore)} {countedUnit(profile.bestScore, NUQTA_FORMS)}
            </span>
            <span className="setup-record__sep">·</span>
            <span className="setup-record__val">سلسلة {formatCount(profile.bestStreak)}</span>
          </div>
          <button type="button" className="btn btn--primary btn--lg" onClick={begin}>
            ابدأ المساجلة
          </button>
        </div>
      </Panel>
    </div>
  )
}
