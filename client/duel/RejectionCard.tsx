/**
 * Why the answer was refused, and what to do about it (design-ux.md §4 Play,
 * amendments.md §7).
 *
 * | tag             | copy                              | cost    |
 * |-----------------|-----------------------------------|---------|
 * | wrong_letter    | «هذا البيت يبدأ بـ «م»، والمطلوب «ن»» | لا شيء |
 * | already_used    | «قيل هذا البيت في هذه المساجلة»     | لا شيء |
 * | not_found       | «لم أجده في الديوان»                | روح     |
 * | near_miss       | «أهذا ما أردت؟» + «اقبل هذا البيت»   | ٢٥ نقطة |
 * | ambiguous       | «وجدتُ أكثر من بيت»                 | لا شيء |
 * | timeout         | «انقضى الوقت» + بيت كان يصلح         | روح     |
 * | too_short       | «البيت شطران، لا كلمة»              | لا شيء |
 * | incomplete_bait | «هذا البيت ناقص العجز في الديوان»    | روح     |
 * | network         | «تعذّر الاتصال بالخادم»              | لا شيء  |
 *
 * Two rules the card must not blur. A refusal that costs nothing NEVER shows a
 * life being spent (a network outage least of all — amendments.md §4.3), and
 * every suggestion is *offered*, never applied: «هل تقصد؟» fills the field so
 * the player still presses أجب, while «اقبل هذا البيت» is the one button that
 * commits, and it says its price out loud.
 */
import { copyableBayt, formatScore } from "../../shared/format.ts"
import type { BaitDto } from "../../shared/schema.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import type { Rejection } from "./machine.ts"
import { pulseExchange } from "./ExchangeLog.tsx"

/** Rejections that spend a life — the card says so, in the same words each time. */
export const COSTS_LIFE = new Set(["not_found", "incomplete_bait", "timeout"])

export function titleOf(r: Rejection): string {
  switch (r.kind) {
    case "wrong_letter":
      return "الحرف غير المطلوب"
    case "already_used":
      return "قيل هذا البيت في هذه المساجلة"
    case "not_found":
      return "لم أجده في الديوان"
    case "near_miss":
      return "أهذا ما أردتَ؟"
    case "ambiguous":
      return "وجدتُ أكثر من بيت"
    case "incomplete_bait":
      return "هذا البيت ناقص العجز"
    case "too_short":
      return "البيت شطران"
    case "timeout":
      return "انقضى الوقت"
    case "network":
      return "تعذّر الوصول إلى الديوان"
    case "no_bait":
      return "لا بيت بهذه القيود"
  }
}

function Suggestion({ bait, onFill }: { bait: BaitDto; onFill: (t: string) => void }) {
  return (
    <li className="reject__sugg">
      <button type="button" className="reject__sugg-btn" onClick={() => onFill(copyableBayt(bait.sadr, bait.ajuz))}>
        <BaytPlate variant="plate" sadr={bait.sadr} ajuz={bait.ajuz} size="sm" />
      </button>
      {bait.poet ? <span className="reject__sugg-poet">{bait.poet.name}</span> : null}
    </li>
  )
}

export type RejectionCardProps = {
  rejection: Rejection
  /** fill the answer field with a suggestion — the player still presses أجب */
  onFill: (text: string) => void
  /** «اقبل هذا البيت» / an ambiguity chip: submit this بيت, at this price */
  onCommit: (bait: BaitDto, penalty: number) => void
  onDismiss: () => void
  /** the network card's «أعد المحاولة» */
  onRetry?: () => void
  livesLeft: number
}

export function RejectionCard({ rejection: r, onFill, onCommit, onDismiss, onRetry, livesLeft }: RejectionCardProps) {
  const costsLife = COSTS_LIFE.has(r.kind)
  return (
    <div className="reject" data-kind={r.kind} data-cost={costsLife ? "life" : "none"} role="alert">
      <header className="reject__head">
        <h3 className="reject__title">{titleOf(r)}</h3>
        {costsLife ? (
          <span className="reject__cost">‎−روح · بقي {livesLeft}</span>
        ) : (
          <span className="reject__cost reject__cost--free">لا تُحتسب</span>
        )}
      </header>

      {r.kind === "wrong_letter" ? (
        <p className="reject__body">
          هذا البيت يبدأ بـ<span className="reject__letter">{r.got ?? "؟"}</span>، والمطلوب{" "}
          <span className="reject__letter reject__letter--want">{r.expected}</span>
          {r.alsoAccepted.length ? <> (ويُقبل «{r.alsoAccepted.join("» و«")}»)</> : null}
        </p>
      ) : null}

      {r.kind === "already_used" ? (
        <div className="reject__body">
          <BaytPlate variant="plate" size="sm" sadr={r.bait.sadr} ajuz={r.bait.ajuz} />
          <button type="button" className="btn btn--ghost" onClick={() => pulseExchange(r.bait.baytKey)}>
            أرِني أين قيل
          </button>
        </div>
      ) : null}

      {r.kind === "not_found" ? (
        <div className="reject__body">
          <p className="reject__norm">
            هذا ما فهمتُه: <bdi className="reject__norm-text">{r.normalized}</bdi>
          </p>
          {r.suggestions.length ? (
            <>
              <p className="reject__label">هل تقصد؟</p>
              <ul className="reject__suggs">
                {r.suggestions.map((b) => (
                  <Suggestion key={b.id} bait={b} onFill={onFill} />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {r.kind === "near_miss" ? (
        <div className="reject__body">
          <p className="reject__norm">
            هذا ما فهمتُه: <bdi className="reject__norm-text">{r.normalized}</bdi>
          </p>
          <BaytPlate variant="plate" size="sm" sadr={r.suggestion.sadr} ajuz={r.suggestion.ajuz} />
          <div className="reject__acts">
            <button type="button" className="btn btn--primary" onClick={() => onCommit(r.suggestion, r.acceptCost)}>
              اقبل هذا البيت ‎−{formatScore(r.acceptCost)}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onDismiss}>
              لا، سأعيد
            </button>
          </div>
        </div>
      ) : null}

      {r.kind === "ambiguous" ? (
        <div className="reject__body">
          <p className="reject__label">أيّها أردت؟</p>
          <ul className="reject__chips">
            {r.candidates.map((b) => (
              <li key={b.id}>
                <button type="button" className="reject__chip" onClick={() => onCommit(b, 0)}>
                  <bdi className="reject__chip-text">{b.sadr}</bdi>
                  {b.poet ? <span className="reject__chip-poet">{b.poet.name}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn--ghost" onClick={onDismiss}>
            لا، أعيد الكتابة
          </button>
        </div>
      ) : null}

      {r.kind === "timeout" ? (
        <div className="reject__body">
          {r.bait ? (
            <>
              <p className="reject__label">كان يصلح هذا:</p>
              <BaytPlate variant="plate" size="sm" sadr={r.bait.sadr} ajuz={r.bait.ajuz} />
            </>
          ) : (
            <p className="reject__norm">لم تُجب في الوقت.</p>
          )}
        </div>
      ) : null}

      {r.kind === "too_short" ? (
        <p className="reject__body">البيت شطران؛ اكتب البيت كاملًا أو صدره على الأقل.</p>
      ) : null}

      {r.kind === "incomplete_bait" ? (
        <div className="reject__body">
          <p className="reject__norm">هذا البيت في الديوان بلا عجز، فلا يصلح للمساجلة.</p>
          <BaytPlate variant="plate" size="sm" sadr={r.bait.sadr} ajuz={r.bait.ajuz} />
        </div>
      ) : null}

      {r.kind === "network" ? (
        <div className="reject__body">
          <p className="reject__norm">{r.message}</p>
          {onRetry ? (
            <button type="button" className="btn" onClick={onRetry}>
              أعد المحاولة
            </button>
          ) : null}
        </div>
      ) : null}

      {r.kind === "no_bait" ? <p className="reject__body">لا بيت في الديوان بهذه القيود على الحرف {r.letter ?? ""}.</p> : null}
    </div>
  )
}
