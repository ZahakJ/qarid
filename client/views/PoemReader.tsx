/**
 * وضع القراءة — the قصيدة, and nothing else on the screen.
 *
 * #/poem is a ديوان ENTRY: crumbs, badges, a شبيهات rail, a rail of four
 * actions beside every بيت. All of it earns its place while the reader is
 * looking things up, and all of it is in the way the moment they simply want to
 * read the قصيدة through. `?read=1` is that second mode: every bar stands down
 * (client/store/readerStore.ts writes the same `body[data-immersive]` the duel's
 * game screen introduced, with `read` as its value), the ink deepens to the
 * page, and the أبيات run down a single comfortable measure in Amiri with a
 * شمسة between each — the rosette a manuscript sets between verses.
 *
 * Four things this component owns:
 *  • IT IS A PORTAL onto `document.body`, and that is load-bearing. motion.css
 *    gives `.route-swap` a FILLED animation, whose `to` keyframe Chromium
 *    resolves to the identity matrix — so the wrapper around every view is a
 *    containing block for the life of the page and a `position: fixed` reader
 *    opened from inside one would be laid out against the VIEW's box (the trap
 *    documented at length in client/components/Sheet.tsx).
 *  • IT IS THE ONLY THING RENDERED while it is up: the قصيدة page's own DOM is
 *    not left underneath it. Two copies of a 905-بيت قصيدة is two copies of
 *    every `id="bayt-N"` anchor, and `?bayt=` would have found whichever came
 *    first. The قصيدة page's scroll offset is given back on the way out
 *    (`takeEntry`), which is what the second copy would have been keeping.
 *  • THE CHROME IS A TAP AWAY, never a permanent bar: the exit and the type
 *    size fade in on a tap and fade back out on their own clock (the store).
 *  • KEEP-AWAKE. A قصيدة is read slowly and without touching the screen, which
 *    is exactly when a phone dims — the same plugin the duel's live turn uses,
 *    released on the way out.
 *
 * The type size is `settings.verseSize`, the same persisted choice the قصيدة
 * page's «حجم الخط» writes: it is one reader's one preference, and a reading
 * mode with a private second size would have the ديوان disagree with itself.
 */
import { useCallback, useEffect, useRef } from "react"
import { createPortal } from "react-dom"

import type { BaitDto } from "../../shared/schema.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { Shamsa } from "../components/Ornaments.tsx"
import { BackChevron } from "../components/ChromeIcons.tsx"
import { Segmented } from "../components/Segmented.tsx"
import { formatBaits } from "../../shared/format.ts"
import { allowSleep, keepAwake } from "../platform/keepAwake.ts"
import type { SettingsSlice } from "../../shared/schema.ts"

/** The three persisted verse sizes — the قصيدة page's «حجم الخط», shared. */
type VerseSize = SettingsSlice["verseSize"]
import {
  reportScroll,
  revealControls,
  toggleControls,
  useReader,
  useReaderControls,
  useReaderMoved,
  useReaderProgress,
} from "../store/readerStore.ts"

export type PoemReaderProps = {
  /** عنوان or مطلع — whichever the قصيدة page's own heading settled on */
  title: string
  /** true when `title` is the مطلع standing in for a missing عنوان */
  isMatla: boolean
  poet: string
  era: string | null
  baits: BaitDto[]
  total: number
  hasMore: boolean
  loadingMore: boolean
  onMore: () => void
  size: VerseSize
  onSize: (v: VerseSize) => void
  tashkeel: boolean
  showRawiyy: boolean
  /** the three sizes, named once by the قصيدة page and shared with the sheet */
  sizes: readonly { value: VerseSize; label: string }[]
  onExit: () => void
}

export function PoemReader({
  title,
  isMatla,
  poet,
  era,
  baits,
  total,
  hasMore,
  loadingMore,
  onMore,
  size,
  onSize,
  tashkeel,
  showRawiyy,
  sizes,
  onExit,
}: PoemReaderProps) {
  const controls = useReaderControls()
  const moved = useReaderMoved()
  const progress = useReaderProgress()

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // «a قصيدة is being read here» — the same shape `useImmersive` gave the duel,
  // and what lets the hardware back button leave the reading rather than the
  // app (client/platform/nativeInit.ts asks the store first).
  useReader(onExit)

  // The screen may not sleep on a قصيدة being read: nothing is touched for
  // minutes at a time, which is precisely the input a phone dims for.
  useEffect(() => {
    void keepAwake()
    return () => void allowSleep()
  }, [])

  // Escape leaves; anything else a keyboard reader presses brings the controls
  // back, so the way out is never more than one keystroke away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onExit()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      revealControls()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onExit])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    reportScroll(el.scrollTop, el.scrollHeight - el.clientHeight)
  }, [])

  // The next page of أبيات, as the reading approaches the end of this one. The
  // observer's root is the reader's OWN scroller — the document does not move
  // here, so a viewport-rooted observer would never fire.
  useEffect(() => {
    const el = sentinelRef.current
    const root = scrollRef.current
    if (!el || !root || !hasMore || typeof IntersectionObserver !== "function") return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMore()
      },
      { root, rootMargin: "1200px 0px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, onMore])

  const loading = baits.length === 0

  return createPortal(
    <div className="reader" role="region" aria-label={`وضع القراءة — ${title}`}>
      {/* The reading's own hairline: how much of the قصيدة is behind you. */}
      <div className="reader__progress" aria-hidden="true">
        <span className="reader__progress-fill" style={{ inlineSize: `${progress * 100}%` }} />
      </div>

      <div
        className="reader__scroll"
        ref={scrollRef}
        onScroll={onScroll}
        /* A tap on the page is the only chrome gesture there is. A drag that
           scrolls fires no click, so reading never summons the controls. */
        onClick={() => toggleControls()}
      >
        <div className="reader__page">
          <header className="reader__head" data-faded={moved ? "1" : "0"}>
            <h2 className={isMatla ? "reader__title reader__title--matla" : "reader__title"}>
              <bdi>{title}</bdi>
            </h2>
            <p className="reader__byline">
              <bdi>{poet}</bdi>
              {era ? <span className="reader__sep"> · </span> : null}
              {era ? <span>{era}</span> : null}
            </p>
          </header>

          {loading ? (
            <BaytSkeleton rows={6} size={size} />
          ) : (
            <div className="reader__abyat" data-bayt-list="">
              {baits.map((b, i) => (
                <div className="reader__bayt" key={b.baytKey}>
                  <BaytPlate
                    sadr={b.sadr}
                    ajuz={b.ajuz}
                    rawiyy={b.rawiyy}
                    number={b.position}
                    size={size}
                    tashkeel={tashkeel}
                    showRawiyy={showRawiyy}
                  />
                  {/* The rosette a manuscript sets BETWEEN verses — never after
                      the last one, which is what the ختام below is for. */}
                  {i < baits.length - 1 ? (
                    <span className="reader__sun" aria-hidden="true">
                      <Shamsa size={11} />
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {hasMore ? (
            <div className="reader__more" ref={sentinelRef}>
              {loadingMore ? (
                <BaytSkeleton rows={2} size={size} />
              ) : (
                <button type="button" className="btn" onClick={onMore}>
                  المزيد — بقي {formatBaits(total - baits.length)}
                </button>
              )}
            </div>
          ) : loading ? null : (
            <footer className="reader__end">
              <span className="reader__end-sun" aria-hidden="true">
                <Shamsa size={16} />
              </span>
              <span className="reader__end-word">تمّت القصيدة</span>
            </footer>
          )}
        </div>
      </div>

      {/* The chrome, such as it is: one cluster, both affordances, gone again
          in two and a half seconds. `inert` and not merely faded — a hidden
          control that still answers Tab is a trap for a keyboard reader. */}
      <div
        className="reader__controls"
        data-on={controls ? "1" : "0"}
        inert={!controls}
        /* a press on the cluster is not a press on the page: without this the
           tap that reaches «رجوع» also toggles the cluster it just left */
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="reader__exit" onClick={onExit}>
          <BackChevron />
          <span>رجوع</span>
        </button>
        <Segmented label="حجم الخط" value={size} onChange={onSize} options={sizes} />
      </div>
    </div>,
    document.body,
  )
}
