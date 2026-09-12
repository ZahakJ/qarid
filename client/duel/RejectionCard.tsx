/**
 * Why the answer was refused, and what to do about it (design-ux.md §4 Play,
 * amendments.md §7).
 *
 * | tag             | copy                              | cost    |
 * |-----------------|-----------------------------------|---------|
 * | wrong_letter    | «هذا البيت يبدأ بـ «م»، والمطلوب «ن»» | لا شيء |
 * | already_used    | «قيل هذا البيت في هذه المساجلة»     | لا شيء |
 * | not_found       | «لم أجده في الديوان»                | روح     |
 * | near_miss       | «أهذا ما أردت؟» + «اقبل هذا البيت»   | 25 نقطة |
 * | ambiguous       | «وجدتُ أكثر من بيت»                 | لا شيء |
 * | timeout         | «انقضى الوقت» + بيت كان يصلح         | روح     |
 * | too_short       | «البيت شطران، لا كلمة»              | لا شيء |
 * | incomplete_bait | «هذا البيت ناقص العجز في الديوان»    | لا شيء  |
 * | not_in_album    | «ليس من هذا الديوان» (غرفة في ديوان)   | لا شيء  |
 * | network         | «تعذّر الاتصال بالخادم»              | لا شيء  |
 *
 * Two rules the card must not blur. A refusal that costs nothing NEVER shows a
 * life being spent (a network outage least of all — amendments.md §4.3), and
 * every suggestion is *offered*, never applied: «هل تقصد؟» fills the field so
 * the player still presses أجب, while «اقبل هذا البيت» is the one button that
 * commits, and it says its price out loud.
 */
import { copyableBayt, countedNoun, formatScore, ROUH_FORMS } from "../../shared/format.ts"
import type { BaitDto } from "../../shared/schema.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import type { Rejection } from "./machine.ts"
import { pulseExchange } from "./ExchangeLog.tsx"

/**
 * Rejections that spend a life — the card says so, in the same words each time.
 *
 * `incomplete_bait` is deliberately NOT one of them. The بيت is real and the
 * player remembered it; the ديوان simply holds it with no عجز (an odd
 * hemistich count, 24,378 قصائد), and the server already prefers a complete
 * copy where one exists. Charging for the scrape's damage was the bug — it is
 * a soft refusal, like a wrong letter.
 */
export const COSTS_LIFE = new Set(["not_found", "timeout"])

export function titleOf(r: Rejection): string {
  switch (r.kind) {
    case "wrong_letter":
      // A VERDICT about the بيت the player typed, not a nominal description of
      // a letter («الحرف غير المطلوب» reads as "the not-required letter"). It
      // is also the name #/rules teaches this refusal by — one verdict, one
      // name, in both places.
      return "ليس هذا الحرف المطلوب"
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
    case "not_in_album":
      // The verdict is about the SHELF, not about the بيت: it is a real بيت,
      // on the required letter, and the room's rule is narrower than the
      // ديوان الأكبر. «ليس من هذا الديوان» says exactly that and no more.
      return "ليس من هذا الديوان"
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
  /**
   * v2.md §5 — a مساجلة room spends STRIKES, not أرواح, and the two do not
   * agree on which refusals cost: a wrong letter is free against the machine
   * and is a strike against a person. So a room passes its own verdict in, and
   * its own wording with it. Absent, the solo duel's `COSTS_LIFE` decides.
   */
  strike?: boolean
  costLabel?: string
}

export function RejectionCard({ rejection: r, onFill, onCommit, onDismiss, onRetry, livesLeft, strike, costLabel }: RejectionCardProps) {
  const costsLife = strike ?? COSTS_LIFE.has(r.kind)
  return (
    <div className="reject" data-kind={r.kind} data-cost={costsLife ? "life" : "none"} role="alert">
      <header className="reject__head">
        <h3 className="reject__title">{titleOf(r)}</h3>
        {/* «بقيت روح واحدة», never «بقي 2» — العدد والمعدود live in
            shared/format.ts, and روح is feminine. The room passes its own
            `costLabel` built the same way from DARBA_FORMS; this is the solo
            duel's, and the two now read identically. */}
        {costsLife ? (
          <span className="reject__cost">
            {costLabel ?? `‎−روح · ${livesLeft === 0 ? "ولا روح بعدها" : `بقيت ${countedNoun(livesLeft, ROUH_FORMS)}`}`}
          </span>
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
          {/* Every suggestion the server sends now starts on the chain letter
              (server/game.ts) — they used to be three doors that were all
              walls. When nothing survives that filter the card SAYS so rather
              than showing an empty label. */}
          {r.suggestions.length ? (
            <>
              <p className="reject__label">هل تقصد؟</p>
              <ul className="reject__suggs">
                {r.suggestions.map((b) => (
                  <Suggestion key={b.id} bait={b} onFill={onFill} />
                ))}
              </ul>
            </>
          ) : (
            <p className="reject__label">لم أجد شيئًا قريبًا على هذا الحرف.</p>
          )}
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

      {r.kind === "not_in_album" ? (
        <div className="reject__body">
          <p className="reject__norm">
            بيتٌ صحيح، وعلى الحرف المطلوب — غير أنّه ليس في «{r.albumTitle}». أجِب ببيتٍ من الديوان.
          </p>
          <BaytPlate variant="plate" size="sm" sadr={r.bait.sadr} ajuz={r.bait.ajuz} />
        </div>
      ) : null}

      {r.kind === "incomplete_bait" ? (
        <div className="reject__body">
          <p className="reject__norm">هذا البيت في الديوان بلا عجز، فلا يصلح للمساجلة. أجب ببيت غيره.</p>
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
