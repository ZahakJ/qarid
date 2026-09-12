/**
 * The most important element on the play screen (design-ux.md §4 Play):
 *
 *     [المطلوب: ن]  →  [عندك: ن] ✓
 *
 * The required letter sits 2.4rem in Amiri inside a circular accent-dim well
 * with the turn's timer drawn as a hairline arc around it. The typed letter is
 * derived live through `firstLetterOf` from shared/arabic.ts — the SAME
 * function the server uses to judge the answer, which is the whole point of
 * the one-normalizer invariant (CLAUDE.md). The client's verdict is UI sugar:
 * the server stays the authority (amendments.md §13).
 *
 * `alsoAccepted` (the literal final letter, when the روي was peeled off it)
 * renders as ghost chips, and the one Arabic clause underneath appears ONLY
 * when it is actually relevant to what the player just typed.
 */
import { firstLetterOf } from "../../shared/arabic.ts"
import { LETTER_NAMES, type HijaiLetter } from "../../shared/letters.ts"
import type { ChainMode, RequiredLetterSource } from "../../shared/schema.ts"

export type LetterIndicatorProps = {
  required: string | null
  source: RequiredLetterSource | null
  alsoAccepted: readonly string[]
  mode: ChainMode
  /** what the player has typed so far */
  draft: string
  /** ms left in the turn, null when the timer is off */
  msLeft: number | null
  turnMs: number
}

/** null while the field is empty, else the folded first letter. */
export function typedLetter(draft: string): string | null {
  return firstLetterOf(draft)
}

export type LetterVerdict = "empty" | "match" | "lenient" | "miss"

export function verdictOf(required: string | null, alsoAccepted: readonly string[], typed: string | null): LetterVerdict {
  if (typed === null || required === null) return "empty"
  if (typed === required) return "match"
  if (alsoAccepted.includes(typed)) return "lenient"
  return "miss"
}

/**
 * The clause under the well. Only rendered when it explains something about
 * THIS letter — a permanent legend teaches nobody anything.
 */
export function clauseFor(required: string | null, source: RequiredLetterSource | null, alsoAccepted: readonly string[], mode: ChainMode): string | null {
  if (required === null) return null
  if (mode === "literal") return "المبارزة على الحرف الأخير كما يُلفظ، لا على الرويّ"
  if (source === "peeled" && alsoAccepted.length > 0) {
    const tail = alsoAccepted[0]!
    if (tail === "ه") return "التاء المربوطة تُحسب هاءً، وتُقبل «ه» أيضًا"
    return `الرويّ «${required}»، وقد تُقبل «${tail}» على الوصل`
  }
  if (required === "ا") return "الهمزات كلها ألف"
  return null
}

/**
 * The ring is drawn in a UNITLESS 100×100 viewBox, and the element it sits in
 * is inset a fixed gap on all four sides of a square well — so the arc is
 * concentric with the disc at every size the scale produces, instead of being
 * pinned to one 68px well the way a `0 0 68 68` box was. r 47 leaves the 3-unit
 * stroke inside the box; nothing is ever clipped.
 */
const ARC_R = 47
const CIRC = 2 * Math.PI * ARC_R

function TimerArc({ msLeft, turnMs }: { msLeft: number | null; turnMs: number }) {
  if (msLeft === null || turnMs <= 0) return null
  const ratio = Math.max(0, Math.min(1, msLeft / turnMs))
  const tone = msLeft <= 2000 ? "danger" : msLeft <= 5000 ? "warn" : "calm"
  return (
    <svg className="letter-arc" viewBox="0 0 100 100" data-tone={tone} aria-hidden="true">
      <circle className="letter-arc__track" cx="50" cy="50" r={ARC_R} />
      <circle
        className="letter-arc__run"
        cx="50"
        cy="50"
        r={ARC_R}
        style={{ strokeDasharray: CIRC, strokeDashoffset: CIRC * (1 - ratio) }}
      />
    </svg>
  )
}

/**
 * «→» / «←» is the one glyph in this app whose entire job is to point, and it
 * is a bidi-MIRRORED character: in an RTL run some shapers flip it and some do
 * not, so the arrow between المطلوب and عندك had no reliable direction. SVG
 * geometry is never reordered by the bidi algorithm — this points from the
 * required disc (inline-start) to the typed one, always.
 */
function FlowArrow() {
  return (
    <svg className="letter-ind__arrow" viewBox="0 0 28 12" aria-hidden="true" focusable="false">
      <path
        d="M27 6H2M8 1 2 6l6 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function LetterIndicator({ required, source, alsoAccepted, mode, draft, msLeft, turnMs }: LetterIndicatorProps) {
  const typed = typedLetter(draft)
  const verdict = verdictOf(required, alsoAccepted, typed)
  const clause = clauseFor(required, source, alsoAccepted, mode)
  const name = required && required in LETTER_NAMES ? LETTER_NAMES[required as HijaiLetter] : null

  return (
    <div className="letter-ind" data-verdict={verdict}>
      <div className="letter-ind__row">
        <div className="letter-ind__side">
          <span className="letter-ind__label">المطلوب</span>
          <span className="letter-well" title={name ?? undefined}>
            <TimerArc msLeft={msLeft} turnMs={turnMs} />
            <bdi className="letter-well__glyph">{required ?? "—"}</bdi>
          </span>
          {alsoAccepted.length > 0 ? (
            <span className="letter-ind__ghosts" aria-label="ويُقبل أيضًا">
              {alsoAccepted.map((l) => (
                <span className="letter-ghost" key={l}>
                  <bdi>{l}</bdi>
                </span>
              ))}
            </span>
          ) : null}
        </div>

        <FlowArrow />

        <div className="letter-ind__side">
          <span className="letter-ind__label">عندك</span>
          <span className="letter-well letter-well--typed">
            <bdi className="letter-well__glyph">{typed ?? "؟"}</bdi>
          </span>
          <span className="letter-ind__verdict" aria-live="polite">
            {verdict === "match" ? "✓" : verdict === "lenient" ? "✓ على الوصل" : verdict === "miss" ? "✗" : ""}
          </span>
        </div>
      </div>
      {clause ? <p className="letter-ind__clause">{clause}</p> : null}
    </div>
  )
}
