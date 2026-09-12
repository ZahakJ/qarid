/**
 * وضع القراءة — «this screen is a قصيدة being READ right now».
 *
 * The duel's `immersiveStore` said the same thing about a game, and this is the
 * second surface that needs it: while the reading lasts, the masthead, the app
 * bar, the tab bar and the footer all stand down, and `body[data-immersive]`
 * carries WHICH of the two it is — `game` for a مساجلة, `read` for a قصيدة —
 * so client/styles/phone.css's docked game layout cannot land on a reader and
 * client/styles/reader.css's cannot land on a duel. One attribute, two values,
 * written in one place (App.tsx) from the one store that owns each fact.
 *
 * What lives here rather than in the view:
 *  • the CONTROLS' clock. A tap brings the exit and the type-size control back
 *    and they leave again after `CONTROLS_LINGER_MS`. That is a timer, a toggle
 *    and a re-arm — three things that are wrong in three different ways when
 *    they are written inline in a component, and all three are tested here.
 *  • the قصيدة's PROGRESS, clamped, so the gold hairline is a pure function of
 *    a scroll offset and cannot be handed a NaN by a container that has not
 *    been laid out yet.
 *  • the heading's stand-down («fades once you move»), which is the same scroll
 *    offset read a second way.
 *  • the ENTRY scroll. The reading replaces the قصيدة page rather than floating
 *    over it, so the document under it is empty and the browser has nothing to
 *    restore; without this, leaving the reading dropped the reader at بيت ١ of
 *    a قصيدة they had opened at بيت ٦٠.
 *
 * The EXIT is registered the way `immersiveStore`'s resign is — a module-level
 * callback the mounted reader owns — so `client/platform/nativeInit.ts` can ask
 * «did the reading take this back press?» without importing a view. It is a
 * plain exit and not a question: leaving a قصيدة costs nothing, so there is
 * nothing to confirm.
 */
import { useLayoutEffect, useRef } from "react"
import { create } from "zustand"

/** How long the exit + type-size cluster stays up after a tap. */
export const CONTROLS_LINGER_MS = 2500

/** Past this many pixels the title/poet heading has been «moved» away from. */
export const HEAD_FADE_PX = 40

type ReaderState = {
  /** a قصيدة is being read on this screen, right now */
  active: boolean
  /** the exit affordance and the type-size control are up */
  controls: boolean
  /** the reader has scrolled away from the قصيدة's head */
  moved: boolean
  /** 0..1 — the gold hairline */
  progress: number
}

const INITIAL: ReaderState = {
  active: false,
  controls: false,
  moved: false,
  progress: 0,
}

const useStore = create<ReaderState>()(() => INITIAL)

/** What «رجوع» does — held outside the store; it is not rendered. */
let exit: (() => void) | null = null

/**
 * Where the قصيدة page stood when the reading was entered.
 *
 * Module state and not store state, because nothing RENDERS from it and
 * because it must outlive the reader by exactly one commit: React runs a
 * child's unmount cleanup before the parent's effects, so a value the store
 * reset on unmount would already be gone when the قصيدة page asks for it.
 * It is read once and cleared — a stale offset applied to a later navigation
 * would yank a reader down a page they had just opened.
 */
let entry = 0

export function rememberEntry(y: number): void {
  entry = y > 0 ? y : 0
}

export function takeEntry(): number {
  const y = entry
  entry = 0
  return y
}

/** The controls' own clock. One timer, re-armed rather than stacked. */
let linger: ReturnType<typeof setTimeout> | null = null

function disarm(): void {
  if (linger !== null) clearTimeout(linger)
  linger = null
}

/**
 * Show the controls and start their ~2.5s clock. Called on entry (so the way
 * out is on screen before it is needed) and on every tap that reveals them.
 */
export function revealControls(): void {
  disarm()
  useStore.setState({ controls: true })
  linger = setTimeout(() => {
    linger = null
    useStore.setState({ controls: false })
  }, CONTROLS_LINGER_MS)
}

export function hideControls(): void {
  disarm()
  useStore.setState({ controls: false })
}

/** A tap on the page: up if they are down, down if they are up. */
export function toggleControls(): void {
  if (useStore.getState().controls) hideControls()
  else revealControls()
}

/**
 * The reading's scroll, reported by the reader's own container.
 *
 * `max` is `scrollHeight - clientHeight`. A قصيدة shorter than the screen has
 * no `max` and therefore no progress to report — a hairline at full width on a
 * قصيدة that was never scrolled would be measuring nothing.
 */
export function reportScroll(top: number, max: number): void {
  const progress = max > 0 ? Math.min(1, Math.max(0, top / max)) : 0
  useStore.setState({ progress, moved: top > HEAD_FADE_PX })
}

/**
 * Declare this screen a reading for as long as it is mounted.
 *
 * `onExit` is kept in a ref and read at press time, exactly as the duel's
 * `onResign` is: it closes over the view's own state and an effect keyed on it
 * would re-register on every render.
 *
 * A LAYOUT effect, for the same reason `body[data-immersive]` is written in
 * one: every rule in reader.css hangs off the attribute App.tsx writes from
 * this store, and setting it after paint shows one frame of the قصيدة page
 * with its chrome still standing.
 */
export function useReader(onExit: () => void): void {
  const ref = useRef(onExit)
  ref.current = onExit
  useLayoutEffect(() => {
    beginReading(() => ref.current())
    return endReading
  }, [])
}

/**
 * The two halves of that hook, as plain functions: the reading starts revealed
 * (the way out is on screen before it is wanted) and ends with nothing of it
 * left behind — not the timer, not the exit, not the progress of the قصيدة
 * that has just been closed.
 */
export function beginReading(onExit: () => void): void {
  exit = onExit
  useStore.setState({ ...INITIAL, active: true })
  revealControls()
}

export function endReading(): void {
  exit = null
  disarm()
  useStore.setState(INITIAL)
}

export function useReaderActive(): boolean {
  return useStore((s) => s.active)
}

export function useReaderControls(): boolean {
  return useStore((s) => s.controls)
}

export function useReaderMoved(): boolean {
  return useStore((s) => s.moved)
}

export function useReaderProgress(): number {
  return useStore((s) => s.progress)
}

/** The whole slice for a caller that is not a component — the tests read this. */
export function readerState(): ReaderState {
  return useStore.getState()
}

/**
 * Take the back press, if there is a reading to be taken out of.
 *
 * Returns true when the reading has been left and the caller must do nothing
 * else; false when there is no reading and back means what it always means.
 */
export function exitReader(): boolean {
  const go = exit
  if (!useStore.getState().active || !go) return false
  go()
  return true
}

/** Test seam — module state (the timer, the exit, the entry) may not leak. */
export function resetReader(): void {
  endReading()
  entry = 0
}
