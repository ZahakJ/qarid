/**
 * `#/duel` — the setup screen (design-ux.md §4 Setup, rewritten for v2.md §1).
 *
 * Five decisions, and v2.md §1 is the owner reporting that he could not read
 * four of them: «القيود» did not say WHOM they constrain, «العدد المتاح» did not
 * say what it counts, «الوصال/المبارزة» and «الروي/الحرف الأخير» were two pairs
 * of words with their meaning hidden inside the selected one. So every control
 * on this page now carries its explanation ON SCREEN, and both sides of every
 * two-way choice are explained at once — a note that only describes the option
 * you already picked cannot help you pick.
 *
 *  1. المستوى — the four رتب as a table of real parameters (client/duel/tiers.ts),
 *     under a line saying what a رتبة actually changes.
 *  2. القيود  — optional عصر/بحر/شاعر, with the asymmetry stated: they narrow
 *     the ديوان THE OPPONENT recites from, never yours. A LIVE eligible-pool
 *     count comes off `/api/game/pool` (amendments.md §2: a point lookup in
 *     `combo_counts`, 0.2 ms on the full corpus — or one memoised grouped scan
 *     when a شاعر is set, which that table has no key for); a thin combination
 *     WARNS, never blocks. The شاعر arrives two ways: typed into `PoetFilter`,
 *     or carried in on `#/duel?poet=<slug>` from «ساجِل من ديوانه» on his page.
 *     Either way the hash is kept honest with a `replace`, so the constraint
 *     survives a reload and can be shared — and `pageKey` calls it the same
 *     page, so setting it does not throw the reader to the top of the screen.
 *  3. الوقت   — on/off; off forces the رتبة down to شاعر, because فحل and سيف
 *     are timers as much as they are pools, and the note says so.
 *  4. النمط   — الوصال (endless) vs المبارزة (best of ten), and the قاعدة:
 *     الروي (classical, lenient) vs الحرف الأخير (literal, amendments.md §1),
 *     with a LIVE example off a real بيت — `chainExample.ts` derives both
 *     letters through the same `rawiyyOf` the server chains on.
 *  5. وضع التدريب (v2.md §2) — the suggestion rail, at half points, said out
 *     loud. On by default for a first-ever duel, off for every one after it.
 *
 * The pool request is debounced: /api/game/* shares one token bucket of 12
 * requests per 10 s, and a filter row that fires on every click would spend a
 * duel's worth of tokens before the player pressed ابدأ.
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
import { getDailyBait, getGamePool, getPoetsBySlugs } from "../api/queries.ts"
import { Chip } from "../components/Chip.tsx"
import { Panel } from "../components/Panel.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { navigate } from "../router.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { loadProfile, startDuel } from "../store/duelStore.ts"
import { useProfile } from "../store/profileStore.ts"
import { FALLBACK_EXAMPLE, exampleFrom, type ChainExample } from "./chainExample.ts"
import { clampTier, configFor, presetOf, tierAllowed, TIER_PRESETS } from "./tiers.ts"
import { FriendMatch } from "./FriendMatch.tsx"
import { PoetFilter, type PoetPick } from "./PoetFilter.tsx"
import { Walkthrough } from "./Walkthrough.tsx"

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

/**
 * Nothing at all: not a thin ديوان, a duel that cannot open.
 *
 * A 0 was practically unreachable while القيود meant عصر×بحر. A شاعر makes it
 * ordinary — 39.8% of قصائد carry no بحر and `game_baits` admits only
 * `kind='bahr'`, so **2,488 of the corpus's 6,941 شعراء have no playable بيت at
 * all** (measured on `build_id d1a38337`), including شعراء with hundreds of
 * قصائد on their page. «قليل؛ قد ينقطع الخصم سريعًا» is the wrong sentence for
 * that: the opponent does not run short, he never recites.
 */
export function poolIsEmpty(pool: Pool): boolean {
  return pool !== null && pool.effective === 0
}

/**
 * The chosen رتبة holds nothing, but the duel is still a duel — `pickBait`
 * relaxes exactly one رتبة before it concedes (server/game.ts `RELAX`).
 *
 * This used to be a corner worth ignoring. A شاعر «قيد» makes it the ordinary
 * case: «فحل» is `fame <= 2`, fame is a property of the شاعر and never of the
 * line, so EVERY famous ديوان counts zero at فحل and thousands at سيف — and the
 * thin warning, which reads `effective`, would stay silent over a bare «0».
 */
export function poolTierIsEmpty(pool: Pool): boolean {
  return pool !== null && pool.total === 0 && pool.effective > 0
}

/** Both halves of a two-way choice, explained at once (v2.md §1). */
function OptionNotes<T extends string>({ value, options }: { value: T; options: readonly { value: T; label: string; note: string }[] }) {
  return (
    <dl className="opt-notes">
      {options.map((o) => (
        <div key={o.value} className="opt-notes__row" data-active={o.value === value ? "1" : undefined}>
          <dt>{o.label}</dt>
          <dd>{o.note}</dd>
        </div>
      ))}
    </dl>
  )
}

const FORMAT_NOTES = [
  { value: "endless" as const, label: "الوصال", note: "تُساجل بلا نهاية، حتى تنفد أرواحك." },
  { value: "match" as const, label: "المبارزة", note: "عشرة أبيات لك، ثم تُحسب الغلبة بالنقاط." },
]

const CHAIN_NOTES = [
  { value: "rhyme" as const, label: "الرويّ", note: "تُقشَر ألفُ الإطلاق وواوُه وياؤه وهاءُ الضمير، ويبقى الرويّ." },
  { value: "literal" as const, label: "الحرف الأخير", note: "آخر حرفٍ في العجز كما كُتب، بلا قشرٍ ولا تأويل." },
]

export function DuelSetupView({ poet: routePoet }: { poet?: string } = {}) {
  const [tier, setTier] = useState<DuelTier>("poet")
  const [timer, setTimer] = useState(true)
  const [format, setFormat] = useState<DuelFormat>("endless")
  const [chainMode, setChainMode] = useState<ChainMode>("rhyme")
  const [era, setEra] = useState<string | undefined>(undefined)
  const [meter, setMeter] = useState<string | undefined>(undefined)
  const [poet, setPoet] = useState<PoetPick>(null)
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [pool, setPool] = useState<Pool>(null)
  const [example, setExample] = useState<ChainExample>(FALLBACK_EXAMPLE)
  const profile = useMemo(() => loadProfile(), [])
  const walkthroughSeenAt = useProfile((s) => s.walkthroughSeenAt)
  const markWalkthroughSeen = useProfile((s) => s.markWalkthroughSeen)
  const [walkthrough, setWalkthrough] = useState(false)

  // v2.md §2: ON for the first duel this browser ever plays, OFF after it.
  // `gamesPlayed` is already persisted (the profile slice), so "first game"
  // needs no flag of its own.
  const [assist, setAssist] = useState(() => profile.gamesPlayed === 0)

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

  // The chain-mode example, off a REAL بيت. بيت اليوم is the cheapest honest
  // source — one cached request (2.8 ms server-side, an hour of Cache-Control)
  // that the home screen has usually already made — and roughly half of all
  // أبيات have no peel to show, so a بيت that cannot teach the difference is
  // dropped and the vetted المتنبي example stands (`exampleFrom` → null).
  useEffect(() => {
    let live = true
    getDailyBait()
      .then((res) => {
        const found = exampleFrom(res.bait)
        if (live && found) setExample(found)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // v2.md §1: offered ONCE, on a first-ever visit to #/duel. The flag is
  // written when it OPENS, not when it closes — a reader who wanted the duel
  // and dismissed the overlay by leaving the page must not meet it again, and
  // «offered once» is a promise about the offer, not about the reading.
  useEffect(() => {
    if (walkthroughSeenAt !== 0) return
    setWalkthrough(true)
    markWalkthroughSeen()
  }, [walkthroughSeenAt, markWalkthroughSeen])

  const closeWalkthrough = () => {
    setWalkthrough(false)
    markWalkthroughSeen()
  }

  // `#/duel?poet=<slug>` — «ساجِل من ديوانه», or a reload of a screen that has
  // one set. The hash carries the SLUG; the chip needs a name and a ديوان size,
  // and `/api/poets?slugs=` is the batch door that already exists for exactly
  // this (the summary's شعراء grid). One request. A slug the corpus does not
  // know is dropped from the hash on the spot; a request that FAILED is not —
  // the قيد is simply not in force this time, and a reload retries it, which is
  // the better failure than a chip that names nobody.
  useEffect(() => {
    if (!routePoet || routePoet === poet?.slug) return
    let live = true
    getPoetsBySlugs([routePoet])
      .then((res) => {
        const found = res.items[0]
        if (!live) return
        if (found) setPoet({ slug: found.slug, name: found.name, poemCount: found.poemCount })
        else navigate({ view: "duel" }, true)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [routePoet, poet?.slug])

  // …and the other direction: the chip is the truth, the hash follows it. A
  // `replace`, because choosing a قيد is not a place you press BACK out of.
  const choosePoet = (next: PoetPick) => {
    setPoet(next)
    navigate(next ? { view: "duel", poet: next.slug } : { view: "duel" }, true)
  }

  const effectiveTier = clampTier(tier, timer)
  const preset = presetOf(effectiveTier)
  const filters: GameFilters = useMemo(
    () => ({ ...(era ? { era } : {}), ...(meter ? { meter } : {}), ...(poet ? { poet: poet.slug } : {}) }),
    [era, meter, poet?.slug],
  )

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
    startDuel(configFor(effectiveTier, { timer, format, chainMode, filters, assist, poetName: poet?.name ?? null }))
    navigate({ view: "duel-play" })
  }

  const thin = poolIsThin(pool)
  const empty = poolIsEmpty(pool)
  const emptyTier = poolTierIsEmpty(pool)

  return (
    <div className="view duel-setup">
      <div className="view__head">
        <h1 className="view__title">المساجلة</h1>
        <p className="view__lede">
          يُنشد الخصم بيتًا، فتُجيبه ببيتٍ يبدأ بحرف رويّه. اضبط الرتبة والقيود، ثم ابدأ.
        </p>
        <p className="setup-teach">
          <button type="button" className="btn btn--ghost setup-teach__btn" onClick={() => setWalkthrough(true)}>
            كيف تتم المساجلة؟
          </button>
          <span className="setup-teach__note">خمس خطوات على بيتٍ حقيقيّ — دقيقة واحدة.</span>
        </p>
      </div>
      <Rule />

      {/* ── 1. المستوى ───────────────────────────────────────────────── */}
      <section className="setup-sect" aria-labelledby="setup-tier">
        <h2 className="setup-sect__title" id="setup-tier">
          المستوى
        </h2>
        <p className="setup-sect__lede">
          الرتبة تضبط الخصم وحده: من أيّ الديوان يُنشد، وكم يمهلك، وكم روحًا تملك، وبكم تشتري الهمس.
        </p>
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
                      <dt>ديوان الخصم</dt>
                      <dd>{t.pool}</dd>
                    </div>
                    <div>
                      <dt>مهلتك للبيت</dt>
                      <dd>{timer ? `${formatNumber(t.seconds)} ثانية` : "بلا وقت"}</dd>
                    </div>
                    <div>
                      <dt>أرواحك</dt>
                      <dd>{formatNumber(t.lives)}</dd>
                    </div>
                    <div>
                      <dt>الهمس (تلميحٌ بثمن)</dt>
                      <dd>{t.hints}</dd>
                    </div>
                    <div>
                      <dt>طبع الخصم</dt>
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
        {/* The asymmetry is the whole of this section, and it was nowhere on
            screen: a filter narrows the ديوان the OPPONENT draws from. The
            player answers out of the whole corpus either way. */}
        <p className="setup-sect__lede">
          تحصر ما يُنشده الخصم، لا ما تُجيب به أنت: أنت تُجيب من الديوان كلّه على كل حال. اترك «كل العصور» و«كل
          البحور» وحقلَ الشاعر فارغًا ليُنشد من كلّ شيء.
        </p>
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
        <div className="setup-row">
          <span className="setup-row__label">الشاعر</span>
          <PoetFilter value={poet} onChange={choosePoet} />
        </div>
        <p className="setup-pool" data-thin={thin ? "1" : undefined} data-stale={pool?.stale ? "1" : undefined}>
          {pool === null ? (
            "…يُحسب العدد المتاح"
          ) : (
            <>
              العدد المتاح: <span className="setup-pool__n">{formatCount(pool.total)}</span>{" "}
              {countedUnit(pool.total, BAYT_FORMS)}
              {empty ? (
                <span className="setup-pool__warn"> — لا شيء يُنشده الخصم بهذه القيود</span>
              ) : thin ? (
                <span className="setup-pool__warn"> — قليل؛ قد ينقطع الخصم سريعًا</span>
              ) : null}
            </>
          )}
        </p>
        {/* A رتبة with nothing in it is not the same thing as a duel with
            nothing in it: `pickBait` relaxes one رتبة before it concedes. That
            corner was rare while القيود meant عصر×بحر and is the NORMAL case
            once a شاعر is named — «فحل» is `fame <= 2` and fame belongs to the
            شاعر, so every famous ديوان is exactly zero there. Printing a bare 0
            over a duel that plays perfectly well would be the screen lying. */}
        {/* «29 قصيدة» on the chip and «0 بيتًا» under it is a flat
            contradiction unless the screen says why: المساجلة recites out of
            `game_baits`, which admits only أبيات whose بحر is known, and 39.8%
            of the corpus's قصائد carry no بحر at all — 2,488 of 6,941 شعراء
            have no playable بيت. The شاعر page is still his whole ديوان. */}
        {empty && poet ? (
          <p className="setup-pool__why">
            لا تُنشد المساجلة إلا من الأبيات المعروفة بحورها، وليس في ديوانه منها شيء. اختر شاعرًا آخر، أو ارفع
            القيد.
          </p>
        ) : null}
        {emptyTier ? (
          <p className="setup-pool__relax">
            لا شيء في هذه الرتبة من هذه القيود — سيُنشد الخصم من رتبةٍ أوسع:{" "}
            <span className="setup-pool__n">{formatCount(pool!.effective)}</span>{" "}
            {countedUnit(pool!.effective, BAYT_FORMS)}.
          </p>
        ) : null}
        <p className="setup-pool__gloss">أي عدد الأبيات التي يستطيع الخصم أن يُنشد منها بهذه الرتبة وهذه القيود.</p>
      </section>

      {/* ── 3+4. الوقت والنمط ────────────────────────────────────────── */}
      <section className="setup-sect setup-sect--switches" aria-labelledby="setup-mode">
        <h2 className="setup-sect__title" id="setup-mode">
          الوقت والنمط
        </h2>

        <div className="setup-opt">
          <div className="setup-opt__control">
            <span className="setup-opt__label">الوقت</span>
            <label className="switch">
              <input type="checkbox" checked={timer} onChange={(e) => setTimer(e.target.checked)} />
              <span className="switch__label">{timer ? `${formatNumber(preset.seconds)} ثانية للبيت` : "مطفأ"}</span>
            </label>
          </div>
          <div className="setup-opt__body">
            <p className="setup-opt__note">
              {timer
                ? "لكلّ بيتٍ مهلة، وما بقي منها يُضاف إلى نقاطك. إن أطفأتَه سقطت رتبتا فحل وسيف، فهما وقتٌ قبل أن يكونا ديوانًا."
                : "بلا مهلة ولا نقاط وقت — وليس لك إلا رتبتا مبتدئ وشاعر."}
            </p>
          </div>
        </div>

        <div className="setup-opt">
          <div className="setup-opt__control">
            <span className="setup-opt__label">النمط</span>
            <Segmented
              label="النمط"
              value={format}
              onChange={setFormat}
              options={FORMAT_NOTES.map((o) => ({ value: o.value, label: o.label }))}
            />
          </div>
          <div className="setup-opt__body">
            <OptionNotes value={format} options={FORMAT_NOTES} />
          </div>
        </div>

        <div className="setup-opt">
          <div className="setup-opt__control">
            <span className="setup-opt__label">قاعدة السلسلة</span>
            <Segmented
              label="قاعدة السلسلة"
              value={chainMode}
              onChange={setChainMode}
              options={CHAIN_NOTES.map((o) => ({ value: o.value, label: o.label }))}
            />
          </div>
          <div className="setup-opt__body">
            <OptionNotes value={chainMode} options={CHAIN_NOTES} />
          </div>
          <ChainExampleBlock example={example} mode={chainMode} />
        </div>

        <div className="setup-opt setup-opt--assist">
          <div className="setup-opt__control">
            <span className="setup-opt__label">وضع التدريب</span>
            <label className="switch">
              <input type="checkbox" checked={assist} onChange={(e) => setAssist(e.target.checked)} />
              <span className="switch__label">{assist ? "مُوقَد" : "مطفأ"}</span>
            </label>
          </div>
          <div className="setup-opt__body">
            <p className="setup-opt__note">
              {assist
                ? "وأنت تكتب، تظهر تحت الحقل أبياتٌ حقيقية من الديوان تبدأ بالحرف المطلوب؛ انقر البيت ليُكتب لك."
                : "لا اقتراحات ولا أبيات تُعرض عليك — إنّما الهمس بثمنه إن احتجت."}
            </p>
            <p className="setup-opt__price" data-on={assist ? "1" : undefined}>
              نقاطك في هذا الوضع نصفُ نقاطك، وما تدفعه في الهمس بثمنه كاملًا.
            </p>
          </div>
        </div>
      </section>

      {/* ── 6. ضدّ صديق (v2.md §5) ────────────────────────────────────── */}
      <FriendMatch />

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

      {walkthrough ? <Walkthrough onClose={closeWalkthrough} /> : null}
    </div>
  )
}

/**
 * The live example under the chain-mode control (v2.md §1).
 *
 * It reads the same بيت twice — once as each mode reads it — so the two words
 * on the segmented control become two letters a player can see the difference
 * between. Both letters are derived by `rawiyyOf`, never written down.
 */
function ChainExampleBlock({ example, mode }: { example: ChainExample; mode: ChainMode }) {
  const demanded = mode === "rhyme" ? example.rawiyy : example.lastLetter
  return (
    <figure className="chain-ex">
      <blockquote className="chain-ex__bayt">
        <span className="chain-ex__half">{example.sadr}</span>
        <span className="chain-ex__half">{example.ajuz}</span>
      </blockquote>
      <figcaption className="chain-ex__read">
        <span className="chain-ex__who">
          <span className="chain-ex__eyebrow">مثال من الديوان</span>
          {example.poet ?? "من الديوان"}
        </span>
        <span className="chain-ex__rule">
          آخر عجزه <bdi className="chain-ex__word">{example.word}</bdi> — الرويّ{" "}
          <em className="chain-ex__letter">{example.rawiyy}</em>، والحرف الأخير{" "}
          <em className="chain-ex__letter">{example.lastLetter}</em>.
        </span>
        <span className="chain-ex__verdict">
          {mode === "rhyme" ? (
            <>
              فبهذه القاعدة يلزمك بيتٌ يبدأ بـ <em className="chain-ex__letter">{demanded}</em>
              {example.peeled ? (
                <>
                  {" "}
                  — وتُقبل <em className="chain-ex__letter">{example.lastLetter}</em> أيضًا.
                </>
              ) : (
                "."
              )}
            </>
          ) : (
            <>
              فبهذه القاعدة يلزمك بيتٌ يبدأ بـ <em className="chain-ex__letter">{demanded}</em> وحدها.
            </>
          )}
        </span>
      </figcaption>
    </figure>
  )
}
