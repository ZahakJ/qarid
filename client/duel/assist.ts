/**
 * وضع التدريب's brain (v2.md §2): what to ask the server for while the player
 * types, and — mostly — what NOT to ask it for.
 *
 * The rail is a suggestion, and a suggestion may never cost the duel anything.
 * Three rules make that true, and all three are pure functions the hook below
 * only orchestrates:
 *
 *  1. **A needle shorter than `ASSIST.minChars` is not a question.** Two folded
 *     characters is the floor `/api/game/assist` itself enforces.
 *  2. **A prefix that found nothing cannot be found by extending it.** If «كتاب»
 *     matched no بيت on this letter, «كتابه» cannot either — the server's rank-0
 *     match is `startsWith`, so the empty answer is monotone. `assistPlan`
 *     refuses those keystrokes outright, which is what keeps a whole typed بيت
 *     down to one or two requests instead of a dozen.
 *  3. **An answer is remembered per (letter, needle).** Backspacing back over a
 *     word — the commonest thing anyone does in a text field — then costs
 *     nothing at all.
 *
 * What is left after those is roughly one request per pause in typing, which is
 * why `ASSIST_RATE_LIMIT` (30 per 10 s) is generous rather than tight, and why
 * the duel's own bucket is never touched. A 429 or a dead network empties the
 * rail and is otherwise ignored: the field keeps working, the server stays the
 * only authority on an answer, and nothing about the game changes.
 */
import { useEffect, useRef, useState } from "react"
import { bareWords } from "../../shared/arabic.ts"
import { ASSIST } from "../../shared/constants.ts"
import type { BaitDto } from "../../shared/schema.ts"
import { getGameAssist } from "../api/queries.ts"

/** The folded form of what was typed — exactly what the server compares. */
export function assistNeedle(draft: string): string {
  return bareWords(draft)
}

export function needleKey(letter: string, needle: string): string {
  return `${letter} ${needle}`
}

/** What the hook remembers between keystrokes. Plain data, so a test can drive it. */
export interface AssistMemo {
  /** (letter, needle) → the أبيات that answer it */
  hits: Map<string, readonly BaitDto[]>
  /** (letter, needle) pairs that answered with nothing */
  empty: Set<string>
}

export function newAssistMemo(): AssistMemo {
  return { hits: new Map(), empty: new Set() }
}

export type AssistPlan =
  | { kind: "idle" }
  | { kind: "cached"; items: readonly BaitDto[] }
  | { kind: "fetch"; letter: string; needle: string }

/**
 * What this keystroke deserves: nothing, an answer we already have, or one
 * request.
 *
 * `enabled` is وضع التدريب itself — in a normal duel the rail does not exist,
 * so this never returns `fetch` and the component renders no rail at all
 * (v2.md §2: "In normal mode the rail does NOT exist").
 */
export function assistPlan(
  memo: AssistMemo,
  opts: { enabled: boolean; letter: string | null; draft: string },
): AssistPlan {
  if (!opts.enabled || opts.letter === null) return { kind: "idle" }
  const needle = assistNeedle(opts.draft)
  if ([...needle].length < ASSIST.minChars) return { kind: "idle" }

  const key = needleKey(opts.letter, needle)
  const hit = memo.hits.get(key)
  if (hit !== undefined) return { kind: "cached", items: hit }
  if (knownEmpty(memo, opts.letter, needle)) return { kind: "cached", items: [] }
  return { kind: "fetch", letter: opts.letter, needle }
}

/**
 * Is this needle an extension of one that already came back empty?
 *
 * The check walks the prefixes of the needle rather than the (unbounded) set of
 * empty answers, so it costs at most one lookup per typed character and it
 * catches both «كتاب»→«كتابه» and «كتاب»→«كتاب ال…».
 */
export function knownEmpty(memo: AssistMemo, letter: string, needle: string): boolean {
  if (memo.empty.size === 0) return false
  const chars = [...needle]
  for (let n = chars.length; n >= ASSIST.minChars; n--) {
    if (memo.empty.has(needleKey(letter, chars.slice(0, n).join("")))) return true
  }
  return false
}

export function rememberAssist(memo: AssistMemo, letter: string, needle: string, items: readonly BaitDto[]): void {
  if (items.length === 0) memo.empty.add(needleKey(letter, needle))
  else memo.hits.set(needleKey(letter, needle), items)
}

export interface AssistState {
  /** the أبيات to show; empty when there is nothing to show, ever */
  items: readonly BaitDto[]
  /** a request is in flight for a needle we have no answer for yet */
  loading: boolean
}

/**
 * The rail's data, debounced by `ASSIST.debounceMs`.
 *
 * A cached answer skips the debounce entirely — backspacing must not make the
 * rail flicker through a 250 ms empty state — and every in-flight request is
 * tagged with the needle that asked for it, so an answer that arrives after the
 * player has typed on is dropped rather than rendered against the wrong draft.
 */
export function useAssist(opts: { enabled: boolean; letter: string | null; draft: string }): AssistState {
  const memo = useRef<AssistMemo>(newAssistMemo())
  const [state, setState] = useState<AssistState>({ items: [], loading: false })
  const seq = useRef(0)

  const { enabled, letter, draft } = opts
  useEffect(() => {
    const plan = assistPlan(memo.current, { enabled, letter, draft })
    if (plan.kind === "idle") {
      setState({ items: [], loading: false })
      return
    }
    if (plan.kind === "cached") {
      setState({ items: plan.items, loading: false })
      return
    }
    const mine = ++seq.current
    setState((s) => ({ items: s.items, loading: true }))
    const timer = setTimeout(() => {
      getGameAssist({ letter: plan.letter, q: plan.needle, limit: ASSIST.defaultLimit })
        .then((res) => {
          rememberAssist(memo.current, plan.letter, plan.needle, res.items)
          if (mine === seq.current) setState({ items: res.items, loading: false })
        })
        .catch(() => {
          // rate-limited, offline, or a server without the route: the rail is a
          // courtesy and simply goes quiet.
          if (mine === seq.current) setState({ items: [], loading: false })
        })
    }, ASSIST.debounceMs)
    return () => clearTimeout(timer)
  }, [enabled, letter, draft])

  return state
}

/** What clicking a suggestion puts in the field: the whole بيت, صدر and عجز. */
export function assistFillText(bait: BaitDto): string {
  return bait.ajuz === null ? bait.sadr : `${bait.sadr} ${bait.ajuz}`
}
