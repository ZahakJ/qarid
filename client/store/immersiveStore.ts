/**
 * IMMERSIVE — «this screen is a game right now».
 *
 * A مساجلة in progress is not a page with a bar stuck on it. While a turn is
 * live the phone gives the whole screen to it: the tab bar goes (there is
 * nowhere to go until the بيت is answered or the match is given up), the app
 * bar's chevron stops being navigation and becomes «انسحب؟», and the answer
 * field docks at the thumb with the exchange log scrolling above it.
 *
 * ONE SIGNAL, the same shape `useNativeChrome` already set: the decision is
 * made once, by the view that owns the game, and mirrored onto
 * `body[data-immersive]` so client/styles/phone.css reads it instead of
 * re-deriving it. `active` is ALREADY gated on the phone chrome by its caller —
 * a desktop reader never sets it, so nothing here can reach them.
 *
 * The exit is deliberately a QUESTION and not a verb. Back is the most-pressed
 * control on a phone and it is pressed by accident; a duel is three lives and a
 * twelve-بيت chain. So the chevron and the hardware button both go through
 * `askExit()`, which returns whether it TOOK the press — that is what lets
 * `client/platform/nativeInit.ts` keep its own rule («back is history.back(),
 * and at the root it minimises») unamended: it asks first, and only navigates
 * when the answer is no.
 */
import { useLayoutEffect, useRef } from "react"
import { create } from "zustand"

type ImmersiveState = {
  /** a مساجلة is being played on this screen, right now */
  active: boolean
  /** the «انسحب؟» sheet is up */
  asking: boolean
}

const useStore = create<ImmersiveState>()(() => ({ active: false, asking: false }))

/** What «انسحب» actually does — held outside the store; it is not rendered. */
let resign: (() => void) | null = null

/**
 * Declare this screen a game for as long as `active` holds.
 *
 * `onResign` is kept in a ref and read at press time: it closes over the view's
 * own state and so is a new function on every tick of the duel clock, and an
 * effect keyed on it would re-register five times a second.
 */
export function useImmersive(active: boolean, onResign: () => void): void {
  const ref = useRef(onResign)
  ref.current = onResign
  // LAYOUT effect, like App.tsx's mirror of it: every rule in phone.css hangs
  // off `body[data-immersive]`, and setting it after paint would show a frame of
  // the scrolling web layout — and would leave the transcript un-followed, since
  // its own effect asks whether it is a scroller yet.
  useLayoutEffect(() => {
    if (!active) return
    resign = () => ref.current()
    useStore.setState({ active: true })
    return () => {
      resign = null
      useStore.setState({ active: false, asking: false })
    }
  }, [active])
}

export function useImmersiveActive(): boolean {
  return useStore((s) => s.active)
}

export function useExitAsked(): boolean {
  return useStore((s) => s.asking)
}

/**
 * Take the back press, if there is a game to be taken out of.
 *
 * Returns true when the question has been asked and the caller must do nothing
 * else; false when there is no game and back means what it always means.
 */
export function askExit(): boolean {
  if (!useStore.getState().active || !resign) return false
  useStore.setState({ asking: true })
  return true
}

export function cancelExit(): void {
  useStore.setState({ asking: false })
}

/** Answer «انسحب» — resign the match, and let the view's own route change run. */
export function confirmExit(): void {
  const go = resign
  useStore.setState({ asking: false })
  go?.()
}
