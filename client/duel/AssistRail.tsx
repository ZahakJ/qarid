/**
 * وضع التدريب's suggestion rail (v2.md §2) — real أبيات from the ديوان that
 * open on the required letter and carry what the player has typed. Clicking one
 * puts the whole بيت in the field; the player still presses «أجب», and the
 * server still judges it, exactly as it judges anything else typed by hand.
 *
 * It exists ONLY in وضع التدريب. In a normal duel `DuelPlayView` never renders
 * this component at all (not "renders it empty"): the answer field of a real
 * مساجلة has nothing under it but its own helper line.
 *
 * Three deliberate restraints:
 *  • the rail never steals focus and never fills the field on its own — a
 *    suggestion a player did not choose is a wrong answer they did not type;
 *  • it keeps its height while a request is in flight (`.assist--busy` dims the
 *    list rather than emptying it), because a list that collapses and reappears
 *    under a text field moves the field itself while someone is reading;
 *  • it says the price. «نصف النقاط» sits in the header, not in a tooltip, for
 *    the same reason every other price in this product is on screen.
 */
import { useEffect, useRef, type ReactNode } from "react"
import type { BaitDto } from "../../shared/schema.ts"
import { assistFillText } from "./assist.ts"

export type AssistRailProps = {
  items: readonly BaitDto[]
  loading: boolean
  /** the letter every suggestion opens on — the rail says which */
  letter: string | null
  /** what the player has typed, folded length ≥ 2 by the time items exist */
  hasQuery: boolean
  onPick: (text: string) => void
}

export function AssistRail({ items, loading, letter, hasQuery, onPick }: AssistRailProps) {
  // A فقرة that grows and shrinks under a text field is a moving target. The
  // rail remembers the tallest it has been for as long as the player keeps
  // typing, and lets go the moment the field is emptied.
  const box = useRef<HTMLDivElement | null>(null)
  const floor = useRef(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    if (!hasQuery) {
      floor.current = 0
      el.style.minBlockSize = ""
      return
    }
    const h = el.offsetHeight
    if (h > floor.current) {
      floor.current = h
      el.style.minBlockSize = `${h}px`
    }
  }, [items, loading, hasQuery])

  return (
    <div className="assist" data-busy={loading ? "1" : undefined} ref={box}>
      <p className="assist__head">
        <span className="assist__badge">وضع التدريب</span>
        <span className="assist__lede">
          {letter === null ? (
            "أبيات من الديوان تعينك"
          ) : (
            <>
              أبيات من الديوان تبدأ بحرف <span className="assist__letter">{letter}</span> — انقر البيت ليُكتب لك
            </>
          )}
        </span>
        <span className="assist__price">نصف النقاط</span>
      </p>

      {hasQuery ? (
        items.length > 0 ? (
          <ul className="assist__list">
            {items.map((bait) => (
              <li key={bait.id}>
                <button
                  type="button"
                  className="assist__item"
                  onClick={() => onPick(assistFillText(bait))}
                  title={assistFillText(bait)}
                >
                  <span className="assist__sadr">{bait.sadr}</span>
                  <span className="assist__by">
                    <span className="assist__poet">{bait.poet.name}</span>
                    {bait.meter === null ? null : <span className="assist__meter">{bait.meter.name}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Note>{loading ? "…أبحث في الديوان" : "لا بيت مشهور بهذا اللفظ — تابع الكتابة، أو أجب من حفظك"}</Note>
        )
      ) : (
        <Note>
          اكتب حرفين فأكثر من أول البيت، فتظهر لك أبيات حقيقية تبدأ بها. حروفٌ من وسط البيت تنفع أيضًا.
        </Note>
      )}
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="assist__note" role="status">
      {children}
    </p>
  )
}
