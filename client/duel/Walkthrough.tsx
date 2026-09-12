/**
 * «كيف تتم المساجلة؟» — the five-step walkthrough (v2.md §1).
 *
 * It walks ONE real exchange, end to end, with the real components: المتنبي
 * opens, the letter well shows what that leaves you, a field shows a صدر typed
 * from memory with no تشكيل, the ديوان accepts it and completes the عجز, and
 * the points land while the letter passes back to the opponent. Nothing here is
 * a screenshot and nothing here is invented:
 *
 *  • both أبيات are in the artefact under the شاعر named here (checked by hand
 *    against data/qarid.db — the rule client/data/flavor.ts follows);
 *  • every LETTER on the page is derived at render time by `rawiyyOf` through
 *    client/duel/chainExample.ts, so a change to the peel rule changes the
 *    lesson too, the way `RulesView`'s table cannot drift from the code;
 *  • the letter well is the live `LetterIndicator`, and the field is the real
 *    `.answer` chrome — so what a player is shown here is what they will
 *    actually see, down to the ghost chip for the accepted second letter.
 *
 * Reached from the setup screen and from #/rules, and offered ONCE on a first
 * visit to #/duel (`profile.walkthroughSeenAt`, v2.md §1). Closing it any way
 * at all — Escape, the scrim, «فهمتُ» — counts as having been offered.
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { Overlay } from "../components/Overlay.tsx"
import { Rule } from "../components/Ornaments.tsx"
import { Sheet } from "../components/Sheet.tsx"
import { useNativeChrome } from "../hooks/useNativeChrome.ts"
import { FALLBACK_EXAMPLE } from "./chainExample.ts"
import { LetterIndicator } from "./LetterIndicator.tsx"
import { SADR_HELP } from "./AnswerInput.tsx"

/** Everything inside the card that Tab can reach (HelpOverlay's list). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The بيت the walkthrough answers WITH — المتنبي, artefact-checked, مطلع. */
const ANSWER = {
  sadr: "لا خَيلَ عِندَكَ تُهديها وَلا مالُ",
  ajuz: "فَلَيُسعِدِ النُطقُ إِن لَم تُسعِدِ الحالُ",
  poet: "المتنبي",
  /** how a player actually types it: no تشكيل, صدر only */
  typed: "لا خيل عندك تهديها ولا مال",
  /** the روي of the ANSWER — what the opponent is now owed */
  rawiyy: "ل",
}

interface Step {
  title: string
  body: ReactNode
  demo: ReactNode
}

function steps(): Step[] {
  const open = FALLBACK_EXAMPLE
  return [
    {
      title: "يُنشد الخصم بيتًا",
      body: (
        <>
          تبدأ المساجلة ببيتٍ من الديوان يُنشده خصمك. المهمّ فيه آخرُ عجزه، فمنه يُؤخذ الحرفُ الذي يلزمك أن تبدأ به
          جوابك.
        </>
      ),
      demo: (
        <BaytPlate
          variant="plate"
          side="them"
          sadr={open.sadr}
          ajuz={open.ajuz}
          meta={<span className="exchange__who">{open.poet}</span>}
        />
      ),
    },
    {
      title: "انظر الحرف المطلوب",
      body: (
        <>
          آخر العجز <bdi className="wt__word">{open.word}</bdi>. والألف في آخره وصلٌ يُقشَر، فالرويّ{" "}
          <em className="wt__letter">{open.rawiyy}</em>. ولأنّ القشر يُختلف فيه، تَقبل قريض الحرفين معًا: الرويَّ،
          والحرفَ الأخيرَ كما كُتب — <em className="wt__letter">{open.lastLetter}</em>.
        </>
      ),
      demo: (
        <LetterIndicator
          required={open.rawiyy}
          source="peeled"
          alsoAccepted={[open.lastLetter]}
          mode="rhyme"
          draft=""
          msLeft={null}
          turnMs={0}
        />
      ),
    },
    {
      title: "أجب من حفظك",
      body: (
        <>
          اكتب بيتًا يبدأ بذلك الحرف. لا يلزمك تشكيل، ولا رسمٌ بعينه للهمزة، ولا البيتُ كاملًا:{" "}
          <b>الصدر وحده يكفي</b>، وإن أخطأتَ كلمةً أو كلمتين بحثنا لك عن أقرب بيت.
        </>
      ),
      demo: (
        <div className="wt__field" aria-hidden="true">
          <div className="answer">
            <p className="answer__field wt__typed">{ANSWER.typed}</p>
            <span className="btn btn--primary answer__send">أجب</span>
          </div>
          <p className="answer__help">{SADR_HELP}</p>
        </div>
      ),
    },
    {
      title: "الحكمُ للديوان",
      body: (
        <>
          نسأل الديوان: فإن وُجد بيتُك قُبل وأُتمّ لك عجزُه ونُسب إلى قائله. وإن لم يُوجد بهذا اللفظ عُرضت عليك ثلاثة
          اقتراحات، وإن كان جوابك لا يبدأ بالحرف المطلوب رُدَّ عليك بلا ثمن — ولا يُسأل الديوان أصلًا.
        </>
      ),
      demo: (
        <>
          <BaytPlate
            variant="plate"
            side="you"
            sadr={ANSWER.sadr}
            ajuz={ANSWER.ajuz}
            meta={
              <>
                <span className="exchange__who">{ANSWER.poet}</span>
                <span className="wt__verdict">قُبِل — وأُتمّ العجز</span>
              </>
            }
          />
          <p className="wt__caption">كتبتَ الصدر وحده، فجاءك البيت كاملًا.</p>
        </>
      ),
    },
    {
      title: "النقاط، ثمّ دورُه",
      body: (
        <>
          كلّ بيتٍ مئة نقطة، تزيد بطول سلسلتك وبما بقي من وقتك وبغرابة البيت، وينقص منها ما اشتريتَ من الهمس. ثمّ
          يلزم الخصمَ رويُّ بيتك: <em className="wt__letter">{ANSWER.rawiyy}</em>. فإن لم يجد في الديوان بيتًا يبدأ
          به، فقد أفحمتَه.
        </>
      ),
      demo: (
        <ul className="wt__score">
          <li>
            <span className="wt__score-n">‎+100</span>
            <span>للبيت</span>
          </li>
          <li>
            <span className="wt__score-n">‎+10</span>
            <span>لكلّ بيتٍ في سلسلتك</span>
          </li>
          <li>
            <span className="wt__score-n">‎+2</span>
            <span>لكلّ ثانيةٍ بقيت لك</span>
          </li>
          <li>
            <span className="wt__score-n">‎+500</span>
            <span>إن أفحمتَ الخصم</span>
          </li>
        </ul>
      ),
    },
  ]
}

export const WALKTHROUGH_STEPS = 5

export function Walkthrough({ onClose }: { onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [at, setAt] = useState(0)
  const all = useRef<Step[]>(steps())
  const step = all.current[at]!
  const last = at === all.current.length - 1
  // A five-step walkthrough is a SHEET on a phone, like the other five phone
  // dialogs — a centred card put «التالي» and the step dots off the bottom of
  // the screen, on the one tutorial v2.md §1 auto-offers to every new player.
  const native = useNativeChrome()

  // The arrows are MIRRORED with the page, exactly as everywhere else in قريض
  // (amendments §15, HelpOverlay's own note): ← goes forward, → goes back.
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      // On a phone `Sheet` owns Escape, the Tab trap and the focus restore, so
      // this effect keeps only the ← / → step arrows (AuthDialog's shape).
      if (e.key === "Escape") {
        if (!native) onClose()
        return
      }
      if (e.key === "ArrowLeft") {
        setAt((n) => Math.min(n + 1, WALKTHROUGH_STEPS - 1))
        return
      }
      if (e.key === "ArrowRight") {
        setAt((n) => Math.max(n - 1, 0))
        return
      }
      if (e.key !== "Tab" || native) return
      const card = cardRef.current
      if (!card) return
      const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) {
        e.preventDefault()
        card.focus()
        return
      }
      const first = items[0]!
      const end = items[items.length - 1]!
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === card)) {
        e.preventDefault()
        end.focus()
      } else if (!e.shiftKey && active === end) {
        e.preventDefault()
        first.focus()
      } else if (!card.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    if (!native) cardRef.current?.focus()
    return () => {
      window.removeEventListener("keydown", onKey)
      if (!native) restore?.focus?.()
    }
  }, [onClose, native])

  /* The lesson itself, and the step controls — defined ONCE, so the desktop
     card and the phone sheet can never teach two different walkthroughs. */
  const body = (
    <div className="wt__body" key={at}>
      <p className="wt__copy">{step.body}</p>
      <div className="wt__demo">{step.demo}</div>
    </div>
  )

  const foot = (
    <>
      <ol className="wt__dots" aria-label="الخطوات">
        {all.current.map((s, i) => (
          <li key={s.title}>
            <button
              type="button"
              className="wt__dot"
              data-active={i === at ? "1" : undefined}
              data-done={i < at ? "1" : undefined}
              aria-label={s.title}
              aria-current={i === at ? "step" : undefined}
              onClick={() => setAt(i)}
            />
          </li>
        ))}
      </ol>
      <div className="wt__nav">
        <button type="button" className="btn" onClick={() => setAt((n) => Math.max(n - 1, 0))} disabled={at === 0}>
          السابق
        </button>
        {last ? (
          <button type="button" className="btn btn--primary" onClick={onClose}>
            فهمتُ — إلى المساجلة
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={() => setAt((n) => n + 1)}>
            التالي
          </button>
        )}
      </div>
    </>
  )

  if (native) {
    // The step title is the sheet's title, so «التالي» and the dots are the
    // sheet's PINNED footer and the lesson scrolls under them. Measured before
    // this: the nav row sat at y 902–1,006 of an 844px screen and the scrim
    // scrolled away with the page.
    return (
      <Sheet title={step.title} note="كيف تتم المساجلة؟" onClose={onClose} className="sheet--wt" footer={foot}>
        {body}
      </Sheet>
    )
  }

  return (
    <Overlay role="dialog" aria-modal aria-label="كيف تتم المساجلة" onClick={onClose}>
      <div className="overlay__card wt" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <header className="wt__head">
          <div>
            <p className="wt__eyebrow">كيف تتم المساجلة؟</p>
            <h2 className="wt__title">{step.title}</h2>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </header>
        <Rule />

        {body}

        <footer className="wt__foot">{foot}</footer>
      </div>
    </Overlay>
  )
}
