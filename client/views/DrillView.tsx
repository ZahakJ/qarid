/**
 * #/train/drill — the card (design-ux.md §5).
 *
 * One بيت at a time, and the discipline of the whole screen is that the عجز is
 * NOT on it. `BaytPlate` renders the صدر in its usual geometry with the عجز
 * replaced by a ruled blank of that عجز's own width — the length is a real cue
 * a reciter uses, so it is given honestly, while the words themselves never
 * reach the DOM.
 *
 * Then either you write it or you ask to see it. Writing it is marked by
 * `grade.ts` — a normalized edit distance over the shared normalizer, so
 * تشكيل, أ/ا, ة/ه and spacing are all free — and the word diff shows exactly
 * which word went missing. The verdict it computes is PRE-SELECTED, never
 * imposed: only you know whether you knew it, and the four buttons stay live.
 *
 * New material comes from `/api/train/candidates` (famous أبيات, مطلع or near
 * it) biased toward the letters your ترسانة is thin on — `buildQueue` decides
 * which of them are admitted, this view only fetches them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { BITAQA_FORMS, KALIMA_FORMS, countedUnit, formatCards, formatCount } from "../../shared/format.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import type { BaitDto, CardGrade, MetaResponse, TrainingCard } from "../../shared/schema.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { Chip } from "../components/Chip.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { getTrainCandidates } from "../api/queries.ts"
import { navigate, routeHash } from "../router.ts"
import { openShareCard } from "../share/ShareDialog.tsx"
import { useCollections } from "../store/collectionsStore.ts"
import { loadMeta } from "../store/libraryStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { trainingSlice, useTraining } from "../store/trainingStore.ts"
import { WordDiff } from "../training/WordDiff.tsx"
import { letterStats, weakestLetters } from "../training/arsenal.ts"
import { GRADE_LABEL, MAX_NEW_PER_DAY, buildQueue, type CardSeed } from "../training/schedule.ts"
import { diffScore, gradeFor, similarity, wordDiff } from "../training/grade.ts"

/** A session under this many cards is topped up with new material. */
const SESSION_TARGET = 12

/** Asked for by index — the four grades, worst first, as the row reads. */
const GRADES: CardGrade[] = ["again", "hard", "good", "easy"]

type Phase = "question" | "graded"

export function DrillView({ letter }: { letter?: string }) {
  const settings = useSettings()
  const cards = useTraining((s) => s.cards)
  const arsenal = useTraining((s) => s.arsenal)
  const reload = useTraining((s) => s.reload)
  const introduce = useTraining((s) => s.introduce)
  const gradeCard = useTraining((s) => s.grade)
  const claimLetter = useTraining((s) => s.claimLetter)
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)

  const [queue, setQueue] = useState<string[] | null>(null)
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>("question")
  const [typed, setTyped] = useState("")
  const [suggested, setSuggested] = useState<CardGrade>("good")
  const [claimed, setClaimed] = useState<Set<string>>(new Set())
  const [seen, setSeen] = useState(0)
  const [right, setRight] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const startedAt = useRef(Date.now())
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // ── the session ─────────────────────────────────────────────────────────
  //
  // Built once per entry (and once per «تدرّب» on a letter). Rebuilding it as
  // the deck changes would reshuffle the queue under the reader's hands after
  // every grade — the plan is made at the start and then simply walked.
  useEffect(() => {
    let live = true
    const ac = new AbortController()

    async function plan() {
      reload()
      const slice = trainingSlice()
      const now = Date.now()
      const base = buildQueue({
        cards: slice.cards,
        now,
        arsenal: slice.arsenal,
        newIntroducedToday: slice.newIntroducedToday,
      })

      const room = Math.max(0, SESSION_TARGET - base.queue.length)
      const budget = Math.max(0, MAX_NEW_PER_DAY - slice.newIntroducedToday)
      if (room === 0 || budget === 0) {
        if (live) setQueue(base.queue)
        return
      }

      // Which letter to lean on: the one the reader asked for, else the one
      // amendment 10 says will cost them the next مساجلة.
      let target = letter ?? null
      if (!target) {
        const meta = await loadMeta(ac.signal).catch(() => null as MetaResponse | null)
        const weak = weakestLetters(letterStats({ letters: meta?.letters ?? null, arsenal: slice.arsenal, cards: slice.cards }), 1)
        target = weak[0]?.letter ?? null
      }

      const asks: Promise<BaitDto[]>[] = []
      if (target) {
        asks.push(
          getTrainCandidates({ famous: 1, letter: target, limit: Math.min(20, room + 4) }, { signal: ac.signal })
            .then((r) => r.items)
            .catch(() => []),
        )
      }
      if (!letter) {
        asks.push(
          getTrainCandidates({ famous: 1, limit: Math.min(20, room + 4) }, { signal: ac.signal })
            .then((r) => r.items)
            .catch(() => []),
        )
      }
      const pools = await Promise.all(asks)
      if (!live) return

      const seeds: CardSeed[] = []
      const taken = new Set<string>()
      for (const pool of pools) {
        for (const bait of pool) {
          if (taken.has(bait.baytKey)) continue
          taken.add(bait.baytKey)
          seeds.push(seedOf(bait))
        }
      }

      const withNew = buildQueue({
        cards: slice.cards,
        now,
        arsenal: slice.arsenal,
        newIntroducedToday: slice.newIntroducedToday,
        candidates: seeds,
        maxNew: room,
      })
      introduce(withNew.fresh)
      if (!live) return
      if (withNew.queue.length === 0 && seeds.length === 0) setError("تعذّر جلب أبياتٍ جديدة — جرّب بعد قليل")
      setQueue(withNew.queue)
    }

    void plan()
    return () => {
      live = false
      ac.abort()
    }
  }, [letter, reload, introduce])

  const currentId = queue?.[index] ?? null
  const card: TrainingCard | null = currentId ? (cards[currentId] ?? null) : null

  // A fresh question: clear the field, restart the clock, take the focus.
  useEffect(() => {
    if (phase !== "question") return
    startedAt.current = Date.now()
    setTyped("")
    inputRef.current?.focus()
  }, [currentId, phase])

  const diff = useMemo(() => (card && phase === "graded" ? wordDiff(typed, card.ajuz ?? "") : []), [card, phase, typed])

  const settle = useCallback(
    (answered: boolean) => {
      if (!card) return
      const elapsed = Date.now() - startedAt.current
      const sim = answered ? similarity(typed, card.ajuz ?? "") : 0
      const verdict = answered ? gradeFor(sim, elapsed) : "again"
      setSuggested(verdict)
      setPhase("graded")
      setSeen((n) => n + 1)
      if (verdict === "good" || verdict === "easy") setRight((n) => n + 1)
    },
    [card, typed],
  )

  const commit = useCallback(
    (grade: CardGrade) => {
      if (!card) return
      gradeCard(card.id, grade)
      setPhase("question")
      setIndex((i) => i + 1)
    },
    [card, gradeCard],
  )

  // Digits grade the card once it is face up. They are page-level keys no بيت
  // row owns, and they are refused while the reader is still typing an عجز.
  useEffect(() => {
    if (phase !== "graded") return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
      const i = Number(e.key)
      if (Number.isInteger(i) && i >= 1 && i <= 4) {
        e.preventDefault()
        commit(GRADES[i - 1] ?? "good")
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        commit(suggested)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [phase, commit, suggested])

  // ── shells ──────────────────────────────────────────────────────────────

  const head = (
    <header className="view__head">
      <h1 className="view__title">المذاكرة</h1>
      <p className="view__lede">
        {letter ? (
          <>
            تدريبٌ على حرف <span className="drill-letter">{letter}</span> — {LETTER_NAMES[letter as HijaiLetter]}.
          </>
        ) : (
          "يُعرض الصدر، ويُطلب العجز. اكتبه من حفظك، أو اطلب أن يُظهَر."
        )}
      </p>
    </header>
  )

  if (queue === null) {
    return (
      <div className="view drill-view">
        {head}
        <div className="drill-card">
          <span className="skeleton" style={{ blockSize: "9rem" }} />
        </div>
      </div>
    )
  }

  if (!card) {
    const done = seen > 0
    return (
      <div className="view drill-view">
        {head}
        {done ? (
          <section className="drill-done">
            <h2 className="drill-done__title">انتهت الجلسة</h2>
            <Rule style={{ inlineSize: "min(18rem, 60%)" }} />
            <p className="drill-done__line">
              راجعتَ {formatCards(seen)}، أصبتَ منها {formatCount(right)}.
            </p>
            <div className="drill-done__acts">
              <a className="btn btn--primary" href={routeHash({ view: "train" })}>
                إلى التحفيظ
              </a>
              <a className="btn" href={routeHash({ view: "train-arsenal" })}>
                الترسانة
              </a>
            </div>
          </section>
        ) : (
          <EmptyState flavor="no-due" title={error ?? "لا بطاقة مستحقّة اليوم"}>
            <div className="drill-done__acts">
              <a className="btn" href={routeHash({ view: "train" })}>
                إلى التحفيظ
              </a>
              <a className="btn btn--ghost" href={routeHash({ view: "duel" })}>
                ساجِلني
              </a>
            </div>
          </EmptyState>
        )}
      </div>
    )
  }

  const answered = typed.trim().length > 0
  const score = diffScore(diff)
  const isNew = card.reps === 0 && card.lapses === 0
  const saved = favorites.some((f) => f.baytKey === card.id)
  const inArsenal = claimed.has(card.id)

  return (
    <div className="view drill-view">
      {head}

      <div className="drill-progress" aria-label="تقدّم الجلسة">
        <span className="drill-progress__bar">
          <span className="drill-progress__fill" style={{ inlineSize: `${((index + 1) / queue.length) * 100}%` }} />
        </span>
        <span className="drill-progress__n num">
          {index + 1}/{queue.length}
        </span>
      </div>

      <section className="drill-card" aria-live="polite">
        {phase === "question" ? (
          <>
            <BaytPlate
              variant="plate"
              size="lg"
              sadr={card.sadr}
              ajuz={card.ajuz}
              blankAjuz
              tashkeel={settings.tashkeel}
              label="بطاقة المذاكرة"
              meta={
                <span className="drill-tag">
                  {isNew ? <Chip variant="gharad" label="بيت جديد" /> : <Chip variant="asr" label="مراجعة" />}
                </span>
              }
            />
            <label className="drill-input">
              <span className="drill-input__label">اكتب العجز</span>
              <textarea
                ref={inputRef}
                dir="rtl"
                lang="ar"
                rows={2}
                enterKeyHint="done"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={typed}
                placeholder="…وتمام البيت"
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    settle(typed.trim().length > 0)
                  }
                }}
              />
            </label>
            <div className="drill-acts">
              <button type="button" className="btn btn--primary" onClick={() => settle(true)} disabled={!answered}>
                تحقّق
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => settle(false)}>
                أظهِر
              </button>
            </div>
          </>
        ) : (
          <>
            <BaytPlate
              variant="plate"
              size="lg"
              sadr={card.sadr}
              ajuz={card.ajuz}
              rawiyy={card.rawiyy}
              tashkeel={settings.tashkeel}
              showRawiyy={settings.showRawiyy}
              label="البيت كاملًا"
              favorite={saved}
              onFavorite={() => {
                const on = toggleFavorite({
                  baytKey: card.id,
                  baitId: card.baitId,
                  sadr: card.sadr,
                  ajuz: card.ajuz,
                  poemId: card.poemId,
                  poet: card.poet,
                })
                toast(on ? "أُضيف إلى المختارات" : "أُزيل من المختارات", on ? "ok" : "info")
              }}
              onCard={() =>
                openShareCard({ sadr: card.sadr, ajuz: card.ajuz, poet: card.poet?.name ?? null })
              }
              meta={
                <span className="drill-reveal">
                  {card.poet ? (
                    <a className="drill-reveal__poet" href={routeHash({ view: "poet", slug: card.poet.slug })}>
                      <bdi>{card.poet.name}</bdi>
                    </a>
                  ) : null}
                  {card.poemId ? (
                    <a className="drill-reveal__poem" href={routeHash({ view: "poem", id: card.poemId })}>
                      القصيدة ←
                    </a>
                  ) : null}
                  {card.firstLetter ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={inArsenal}
                      onClick={() => {
                        claimLetter(card.firstLetter as string)
                        setClaimed((s) => new Set(s).add(card.id))
                        toast(`أُضيف إلى ترسانتك تحت حرف ${card.firstLetter}`, "ok")
                      }}
                    >
                      {inArsenal ? "في ترسانتك ✓" : "هذا في ترسانتي"}
                    </button>
                  ) : null}
                </span>
              }
            />

            {answered ? (
              <div className="drill-diff">
                <p className="drill-diff__head">
                  أصبتَ {formatCount(score.ok)} من {formatCount(score.total)} {countedUnit(score.total, KALIMA_FORMS)}
                </p>
                <WordDiff tokens={diff} />
              </div>
            ) : (
              <p className="drill-diff__head drill-diff__head--shown">عُرض البيت — احكم على نفسك بصدق.</p>
            )}

            <div className="drill-grades" role="group" aria-label="التقدير">
              {GRADES.map((g, i) => (
                <button
                  key={g}
                  type="button"
                  className="btn drill-grade"
                  data-grade={g}
                  data-suggested={g === suggested ? "1" : undefined}
                  onClick={() => commit(g)}
                >
                  <span className="drill-grade__key num" aria-hidden="true">
                    {i + 1}
                  </span>
                  {GRADE_LABEL[g]}
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <p className="drill-foot">
        {formatCount(Object.keys(cards).length)} {countedUnit(Object.keys(cards).length, BITAQA_FORMS)} في ترسانتك ·{" "}
        <button type="button" className="linkish" onClick={() => navigate({ view: "train" })}>
          إنهاء الجلسة
        </button>
      </p>
    </div>
  )
}

/** A بيت off the wire, as the deck holds it. */
function seedOf(bait: BaitDto): CardSeed {
  return {
    id: bait.baytKey,
    baitId: bait.id,
    sadr: bait.sadr,
    ajuz: bait.ajuz,
    poet: bait.poet,
    poemId: bait.poem.id,
    firstLetter: bait.firstLetter,
    rawiyy: bait.rawiyy,
  }
}
