/**
 * وضع القراءة's logic, which is all of it that is not a stylesheet: the
 * controls' clock, the progress hairline, the heading's stand-down, the entry
 * scroll the قصيدة page is given back, and the back press the reading takes.
 *
 * `useReader` is the React binding over `beginReading`/`endReading`; the tests
 * drive those directly, because the test run is headless (vite.config.ts:
 * `environment: "node"`) and a hook has nowhere to mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CONTROLS_LINGER_MS,
  HEAD_FADE_PX,
  beginReading,
  endReading,
  exitReader,
  hideControls,
  readerState,
  rememberEntry,
  reportScroll,
  resetReader,
  revealControls,
  takeEntry,
  toggleControls,
} from "./readerStore.ts"

const controlsNow = () => readerState().controls
const movedNow = () => readerState().moved
const progressNow = () => readerState().progress

beforeEach(() => {
  vi.useFakeTimers()
  resetReader()
})

afterEach(() => {
  resetReader()
  vi.useRealTimers()
})

describe("the controls' clock", () => {
  it("a reading opens with the way out on screen, and it leaves on its own", () => {
    beginReading(() => {})
    expect(controlsNow()).toBe(true)
    vi.advanceTimersByTime(CONTROLS_LINGER_MS - 1)
    expect(controlsNow()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(controlsNow()).toBe(false)
  })

  it("a tap brings them back, and another tap takes them away at once", () => {
    beginReading(() => {})
    vi.advanceTimersByTime(CONTROLS_LINGER_MS)
    expect(controlsNow()).toBe(false)

    toggleControls()
    expect(controlsNow()).toBe(true)
    toggleControls()
    expect(controlsNow()).toBe(false)
  })

  it("a second reveal RE-ARMS the clock rather than stacking a second one", () => {
    beginReading(() => {})
    vi.advanceTimersByTime(CONTROLS_LINGER_MS - 500)
    revealControls()
    // the first clock would have fired here; the re-arm must have replaced it
    vi.advanceTimersByTime(600)
    expect(controlsNow()).toBe(true)
    vi.advanceTimersByTime(CONTROLS_LINGER_MS)
    expect(controlsNow()).toBe(false)
  })

  it("a hidden cluster stays hidden — the clock cannot fire twice", () => {
    beginReading(() => {})
    hideControls()
    expect(controlsNow()).toBe(false)
    vi.advanceTimersByTime(CONTROLS_LINGER_MS * 2)
    expect(controlsNow()).toBe(false)
  })

  it("ending the reading disarms the clock — it cannot fire onto the next one", () => {
    beginReading(() => {})
    endReading()
    beginReading(() => {})
    // the FIRST reading's timer would land here if it had survived
    vi.advanceTimersByTime(CONTROLS_LINGER_MS - 1)
    expect(controlsNow()).toBe(true)
  })
})

describe("the progress hairline", () => {
  it("is the scroll offset over its own maximum, clamped at both ends", () => {
    beginReading(() => {})
    reportScroll(0, 1000)
    expect(progressNow()).toBe(0)
    reportScroll(250, 1000)
    expect(progressNow()).toBe(0.25)
    reportScroll(1000, 1000)
    expect(progressNow()).toBe(1)
    // an over-scroll bounce (iOS) reports past the end
    reportScroll(1200, 1000)
    expect(progressNow()).toBe(1)
    reportScroll(-40, 1000)
    expect(progressNow()).toBe(0)
  })

  it("reports nothing for a قصيدة that does not fill the screen", () => {
    beginReading(() => {})
    reportScroll(0, 0)
    expect(progressNow()).toBe(0)
    // a container measured before layout hands back a negative maximum
    reportScroll(0, -12)
    expect(progressNow()).toBe(0)
  })

  it("is left behind by the قصيدة it belonged to", () => {
    beginReading(() => {})
    reportScroll(500, 1000)
    endReading()
    expect(progressNow()).toBe(0)
  })
})

describe("the heading stands down once the reader moves", () => {
  it("fades past the threshold and comes back at the top", () => {
    beginReading(() => {})
    expect(movedNow()).toBe(false)
    reportScroll(HEAD_FADE_PX, 2000)
    expect(movedNow()).toBe(false)
    reportScroll(HEAD_FADE_PX + 1, 2000)
    expect(movedNow()).toBe(true)
    reportScroll(0, 2000)
    expect(movedNow()).toBe(false)
  })
})

describe("the entry scroll the قصيدة page gets back", () => {
  it("is handed over exactly once", () => {
    rememberEntry(1_240)
    expect(takeEntry()).toBe(1_240)
    expect(takeEntry()).toBe(0)
  })

  it("refuses a nonsense offset rather than scrolling to it", () => {
    rememberEntry(-1)
    expect(takeEntry()).toBe(0)
  })

  it("survives the reading it was taken before — a child unmounts first", () => {
    rememberEntry(880)
    beginReading(() => {})
    endReading()
    expect(takeEntry()).toBe(880)
  })
})

describe("the back press", () => {
  it("is not taken when nothing is being read", () => {
    expect(exitReader()).toBe(false)
  })

  it("is taken by a live reading, once", () => {
    const left = vi.fn()
    beginReading(left)
    expect(exitReader()).toBe(true)
    expect(left).toHaveBeenCalledTimes(1)
  })

  it("is given back the moment the reading ends", () => {
    const left = vi.fn()
    beginReading(left)
    endReading()
    expect(exitReader()).toBe(false)
    expect(left).not.toHaveBeenCalled()
  })
})
