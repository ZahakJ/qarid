/**
 * The global palette (v2.md §3) — قريض's index page, summoned over whatever
 * the reader was looking at.
 *
 * `Ctrl+K` **and** `Ctrl+F` (and their Cmd twins) open it on EVERY route; the
 * second one is a deliberate hijack of the browser's own find, asked for by the
 * owner: a reader looking for a word inside a 3.4M-بيت ديوان means the ديوان,
 * not the 40 lines the viewport happens to hold. `Escape` closes it, `/` still
 * prefers a real omnibox if one is on screen (App.tsx), and `#/search` stays
 * exactly where it was for deep links and the full result list.
 *
 * Three contracts worth stating here, because each is easy to break:
 *
 *  • THE HOTKEY LISTENER IS GLOBAL AND CAPTURING, and it does NOT skip fields.
 *    `useKeyboard` refuses every key that arrives from an `<input>` — right for
 *    `/` and `?`, wrong for a chord: the reader is typing a بيت into the duel
 *    when they reach for Ctrl+K, and Chromium's find bar opens on Ctrl+F unless
 *    the keystroke is `preventDefault`ed before it reaches the page at all.
 *
 *  • WHILE OPEN, THE INPUT TRAPS THE KEYMAP. Tab moves the highlight instead of
 *    walking out onto the masthead behind the scrim, the rows are addressed by
 *    `aria-activedescendant` rather than focus, and every other key is the
 *    query's. That is why nothing here re-registers `g`-chords or `j`/`k`.
 *
 *  • THE REQUEST IS ONE. `searchPalette` is `/api/search?scope=all`, whose
 *    شعراء half is already ranked name-hit → fame → bm25 (`rankedPoetRefs`),
 *    which is the fame-first order §3 asks for; the per-group caps (5/4/4) are
 *    applied to the answer, not asked for three times.
 *
 * The look is the manuscript index it is named after: an ink panel with corner
 * pieces and a dissolving gold rule under the field, أبيات set in Amiri, the
 * rows arriving in a 30 ms stagger that `prefers-reduced-motion` erases.
 *
 * ON A PHONE THE SAME DOOR OPENS A FULL SCREEN. A floating panel over a dimmed
 * page is a desktop shape: it exists so the reader can see what they were
 * looking at behind it, which is worth nothing on a 390px screen — and it
 * spends a third of that screen on a scrim, a border and a keyboard-hint
 * footer. `PhoneSearch` is the same query, the same request, the same rows and
 * the same `Entry`, presented as a screen that slides up with its field already
 * focused and «إلغاء» to dismiss. ONE data path (`usePaletteSearch`), two
 * shells; the desktop's Ctrl+K panel is untouched.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { create } from "zustand"
import { ApiError } from "../api/client.ts"
import { searchPalette } from "../api/queries.ts"
import { markedText, markedTerms } from "../bayt/highlight.tsx"
import { useDebounced } from "../hooks/useDebounced.ts"
import { useNarrow } from "../hooks/useMediaQuery.ts"
import { useNativeChrome } from "../hooks/useNativeChrome.ts"
import { navigate, routeHash } from "../router.ts"
import type { SearchResponse } from "../../shared/schema.ts"
import { PanelCorners, Shamsa } from "./Ornaments.tsx"
import { flatten, suggestionNote, suggestionTitle } from "./omnibox.ts"
import {
  PALETTE_ALL_KEYS,
  PALETTE_ALL_LABEL,
  PALETTE_DEBOUNCE_MS,
  PALETTE_EMPTY,
  PALETTE_FETCH_LIMIT,
  PALETTE_IDLE,
  PALETTE_KEY_HINTS,
  PALETTE_LABEL,
  PALETTE_MIN_CHARS,
  PALETTE_PLACEHOLDER,
  PALETTE_PLACEHOLDER_NARROW,
  PALETTE_WILDCARD_HINT,
  jumpGroup,
  movePaletteCursor,
  opensPalette,
  paletteAction,
  paletteGroups,
  pick,
  type Suggestion,
} from "./palette.ts"

// ── the one open/closed bit ────────────────────────────────────────────────
//
// A store rather than state in App.tsx, so the masthead's ⌕ button, the `/`
// key and a future «ابحث» anywhere else all reach it without prop-drilling the
// shell — the same shape `ShareCardHost` uses for the بطاقة dialog.

type PaletteStore = { open: boolean; nonce: number }

const usePaletteStore = create<PaletteStore>()(() => ({ open: false, nonce: 0 }))

/** The open palette's field, so a second chord can reach it (see below). */
let mountedInput: HTMLInputElement | null = null

/**
 * Open the palette — and, if it is already open, do what a browser does when
 * Ctrl+F is pressed over its own find bar: put the caret back in the field and
 * SELECT what is there, ready to be typed over. Re-opening it (and silently
 * discarding a half-typed query) would be the one behaviour a reader who
 * pressed the key twice cannot have meant.
 */
export function openPalette(): void {
  if (usePaletteStore.getState().open) {
    mountedInput?.focus()
    mountedInput?.select()
    return
  }
  usePaletteStore.setState((s) => ({ open: true, nonce: s.nonce + 1 }))
}

export function closePalette(): void {
  usePaletteStore.setState({ open: false })
}

/**
 * Mounted once, in App.tsx. Owns the global chord and renders the overlay when
 * it is open — nothing else in the app knows the palette exists.
 */
export function PaletteHost() {
  const open = usePaletteStore((s) => s.open)
  const nonce = usePaletteStore((s) => s.nonce)
  const native = useNativeChrome()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!opensPalette(e)) return
      // Before the browser's find bar, and before any field's own handler.
      e.preventDefault()
      e.stopPropagation()
      openPalette()
    }
    window.addEventListener("keydown", onKey, { capture: true })
    return () => window.removeEventListener("keydown", onKey, { capture: true })
  }, [])

  if (!open) return null
  return native ? <PhoneSearch key={nonce} onClose={closePalette} /> : <Palette key={nonce} onClose={closePalette} />
}

// ── the one data path ──────────────────────────────────────────────────────

/**
 * The query, the debounce, the one request and what came back — everything the
 * search door is, minus how it looks. Both shells drive this and neither owns a
 * line of it, so the phone's screen and the desktop's panel cannot drift into
 * being two different searches.
 */
function usePaletteSearch() {
  const [text, setText] = useState("")
  const [res, setRes] = useState<SearchResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const q = text.trim()
  const debounced = useDebounced(q, PALETTE_DEBOUNCE_MS)

  useEffect(() => {
    if (debounced.length < PALETTE_MIN_CHARS) {
      setRes(null)
      setBusy(false)
      setFailed(false)
      return
    }
    const ac = new AbortController()
    setBusy(true)
    searchPalette(debounced, PALETTE_FETCH_LIMIT, { signal: ac.signal })
      .then((r) => {
        if (ac.signal.aborted) return
        setRes(r)
        setFailed(false)
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.kind === "aborted") return
        setRes(null)
        setFailed(true)
      })
      .finally(() => {
        if (!ac.signal.aborted) setBusy(false)
      })
    return () => ac.abort()
  }, [debounced])

  const groups = useMemo(() => paletteGroups(res), [res])
  const flat = useMemo(() => flatten(groups), [groups])
  const searching = debounced.length >= PALETTE_MIN_CHARS
  const empty = searching && !busy && !failed && flat.length === 0

  return { text, setText, q, groups, flat, busy, failed, searching, empty }
}

// ── the overlay ────────────────────────────────────────────────────────────

function Palette({ onClose }: { onClose: () => void }) {
  const narrow = useNarrow()
  const { text, setText, q, groups, flat, busy, failed, searching, empty } = usePaletteSearch()
  const [cursor, setCursor] = useState(0)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const allRef = useRef<HTMLButtonElement | null>(null)
  const listId = useId()

  // Focus is the whole point of opening it; restore it on the way out so a
  // reader who summoned the palette from the duel's answer box lands back in it.
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null
    mountedInput = inputRef.current
    inputRef.current?.focus()
    return () => {
      if (mountedInput === inputRef.current) mountedInput = null
      restore?.focus?.()
    }
  }, [])

  // A new answer starts the highlight at its first row again.
  useEffect(() => setCursor(0), [groups])

  const go = useCallback(
    (s: Suggestion) => {
      onClose()
      navigate(s.route)
    },
    [onClose],
  )

  const runSearch = useCallback(() => {
    if (!q) return
    onClose()
    navigate({ view: "search", q, page: 1 })
  }, [onClose, q])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const action = paletteAction(e, cursor >= 0 && flat.length > 0)
    if (action === null) return
    switch (action) {
      case "close":
        e.preventDefault()
        onClose()
        return
      case "all":
        e.preventDefault()
        runSearch()
        return
      case "open": {
        e.preventDefault()
        const picked = pick(flat, cursor)
        if (picked) go(picked)
        else runSearch()
        return
      }
      case "next":
      case "prev":
        // Tab with nothing to walk still must not step out onto the masthead
        // behind the scrim: the dialog is `aria-modal`, so the two focusable
        // things inside it (the field and «كل النتائج») cycle between them.
        if (flat.length === 0) {
          if (e.key !== "Tab") return
          e.preventDefault()
          const onField = document.activeElement === inputRef.current
          if (onField && allRef.current && !allRef.current.disabled) allRef.current.focus()
          else inputRef.current?.focus()
          return
        }
        e.preventDefault()
        setCursor((c) => movePaletteCursor(c, action === "next" ? 1 : -1, flat.length))
        return
      case "next-group":
      case "prev-group":
        if (groups.length < 2) return
        e.preventDefault()
        setCursor((c) => jumpGroup(groups, c, action === "next-group" ? 1 : -1))
        return
    }
  }

  // Keep the highlighted row in view — the list scrolls at nine rows on a phone.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-cursor="1"]')
    el?.scrollIntoView({ block: "nearest" })
  }, [cursor, groups])

  const activeId = pick(flat, cursor) ? `${listId}-${cursor}` : undefined

  return (
    <div
      className="palette-scrim"
      role="presentation"
      // mousedown, not click: a drag that started inside the panel and ended on
      // the scrim is a text selection, not a dismissal.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={PALETTE_LABEL}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <PanelCorners size={16} />

        <div className="palette__field">
          <SearchMark />
          <input
            ref={inputRef}
            type="text"
            className="palette__input"
            dir="rtl"
            lang="ar"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={PALETTE_PLACEHOLDER}
            placeholder={narrow ? PALETTE_PLACEHOLDER_NARROW : PALETTE_PLACEHOLDER}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setCursor(0)
            }}
          />
          <span className="palette__state" aria-hidden="true">{busy ? <span className="palette__spinner" /> : null}</span>
        </div>

        <div className="palette__rule" aria-hidden="true" />

        <div className="palette__body" ref={listRef}>
          {!searching ? (
            <p className="palette__idle">{PALETTE_IDLE}</p>
          ) : failed ? (
            <p className="palette__idle">تعذّر البحث الآن — جرّب مرة أخرى.</p>
          ) : empty ? (
            <p className="palette__idle">{PALETTE_EMPTY}</p>
          ) : (
            <div className="palette__groups" id={listId} role="listbox" aria-label={PALETTE_LABEL}>
              {groups.map((g) => (
                <section className="palette__group" key={g.kind} role="group" aria-labelledby={`${listId}-${g.kind}`}>
                  <h2 className="palette__label" id={`${listId}-${g.kind}`}>
                    <span>{g.label}</span>
                    <span className="palette__label-rule" aria-hidden="true" />
                  </h2>
                  {g.items.map((s) => {
                    const i = flat.indexOf(s)
                    return (
                      <a
                        key={s.id}
                        id={`${listId}-${i}`}
                        role="option"
                        aria-selected={i === cursor}
                        className="palette__row"
                        data-kind={s.kind}
                        data-cursor={i === cursor ? "1" : undefined}
                        style={{ "--i": i } as React.CSSProperties}
                        href={routeHash(s.route)}
                        onMouseEnter={() => setCursor(i)}
                        onClick={(e) => {
                          e.preventDefault()
                          go(s)
                        }}
                      >
                        <Entry s={s} />
                      </a>
                    )
                  })}
                </section>
              ))}
            </div>
          )}
        </div>

        <footer className="palette__foot">
          <button type="button" ref={allRef} className="palette__all" onClick={runSearch} disabled={!q}>
            {PALETTE_ALL_LABEL}
            <span className="palette__all-keys keys-only" aria-hidden="true">
              {PALETTE_ALL_KEYS.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
          </button>
          <p className="palette__wild">
            <bdi>{PALETTE_WILDCARD_HINT}</bdi>
          </p>
          <ul className="palette__hints keys-only">
            {PALETTE_KEY_HINTS.map((h) => (
              <li key={h.label}>
                {h.keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
                <span>{h.label}</span>
              </li>
            ))}
          </ul>
        </footer>
      </div>
    </div>
  )
}

// ── the phone's screen ─────────────────────────────────────────────────────

/**
 * البحث, full-screen, on a phone.
 *
 * The same query and the same rows as the panel above; what changes is that it
 * is a SCREEN. It slides up over whatever was there, its field takes focus (so
 * the keyboard is already up when it arrives — a search you have to tap twice
 * to start typing into is a search you do not use), and «إلغاء» beside the field
 * is the way out, the way it is on every phone.
 *
 * There is no highlighted row and no key-hint footer: nothing here is driven by
 * a keyboard, and a row IS the target. What is kept is «كل النتائج», because
 * `#/search` is the full list and this is deliberately the first few.
 *
 * A portal onto `document.body`, for the reason `Sheet` is one: `.route-swap`'s
 * filled transform is a containing block, and a `position: fixed` screen laid
 * out inside a view is laid out against the view.
 */
function PhoneSearch({ onClose }: { onClose: () => void }) {
  const { text, setText, q, groups, flat, busy, failed, searching, empty } = usePaletteSearch()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null
    mountedInput = inputRef.current
    inputRef.current?.focus()
    // The page underneath does not scroll while a full screen is over it —
    // the same freeze the sheet uses, and the same reason.
    document.body.dataset.sheet = "1"
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      if (mountedInput === inputRef.current) mountedInput = null
      delete document.body.dataset.sheet
      restore?.focus?.()
    }
  }, [onClose])

  const go = (s: Suggestion) => {
    onClose()
    navigate(s.route)
  }

  const runSearch = () => {
    if (!q) return
    onClose()
    navigate({ view: "search", q, page: 1 })
  }

  return createPortal(
    <div className="fsearch" role="dialog" aria-modal="true" aria-label={PALETTE_LABEL}>
      <div className="fsearch__bar">
        <div className="fsearch__field">
          <SearchMark />
          <input
            ref={inputRef}
            type="search"
            className="fsearch__input"
            dir="rtl"
            lang="ar"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            aria-label={PALETTE_PLACEHOLDER}
            aria-controls={listId}
            placeholder={PALETTE_PLACEHOLDER_NARROW}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                runSearch()
              }
            }}
          />
          {busy ? <span className="fsearch__spinner" aria-hidden="true" /> : null}
        </div>
        <button type="button" className="fsearch__cancel" onClick={onClose}>
          إلغاء
        </button>
      </div>

      <div className="fsearch__body" id={listId}>
        {!searching ? (
          <div className="fsearch__idle">
            <p>{PALETTE_IDLE}</p>
            <p className="fsearch__wild">
              <bdi>{PALETTE_WILDCARD_HINT}</bdi>
            </p>
          </div>
        ) : failed ? (
          <p className="fsearch__idle">تعذّر البحث الآن — جرّب مرة أخرى.</p>
        ) : empty ? (
          <p className="fsearch__idle">{PALETTE_EMPTY}</p>
        ) : (
          groups.map((g) => (
            <section className="fsearch__group" key={g.kind} aria-labelledby={`${listId}-${g.kind}`}>
              <h2 className="palette__label fsearch__label" id={`${listId}-${g.kind}`}>
                <span>{g.label}</span>
                <span className="palette__label-rule" aria-hidden="true" />
              </h2>
              {g.items.map((s) => (
                <a
                  key={s.id}
                  /* `palette__row` on purpose: the بيت inside an index entry is
                     set by palette.css and there is no second way to set it.
                     `fsearch__row` only adds the touch measure. */
                  className="palette__row fsearch__row"
                  data-kind={s.kind}
                  href={routeHash(s.route)}
                  onClick={(e) => {
                    e.preventDefault()
                    go(s)
                  }}
                >
                  <Entry s={s} />
                </a>
              ))}
            </section>
          ))
        )}
      </div>

      {q ? (
        <div className="fsearch__foot">
          <button type="button" className="btn btn--primary fsearch__all" onClick={runSearch}>
            {PALETTE_ALL_LABEL}
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}

/**
 * One index entry.
 *
 * A بيت is set AS a بيت — صدر and عجز in their own equal tracks with the
 * quiet centre channel between them, the way bayt.css sets the ديوان — and
 * carries a third, quieter line naming its شاعر and بحر, which is what tells a
 * reader which of five near-identical مطالع is the one they meant. A قصيدة and
 * a شاعر are single-line entries: the thing on the inline-start (right), what
 * distinguishes it on the inline-end, an index line in a printed فهرس.
 *
 * The hit words come off the NORMALIZED snippet and are mapped back onto the
 * vocalized text by `markedText`; the snippet itself is never rendered, because
 * it has no تشكيل (amendment 14).
 */
function Entry({ s }: { s: Suggestion }) {
  if (s.kind !== "bait") {
    return (
      <>
        <span className="palette__row-main">
          <bdi>{suggestionTitle(s)}</bdi>
        </span>
        <span className="palette__row-note">
          <bdi>{suggestionNote(s)}</bdi>
        </span>
      </>
    )
  }

  const hit = s.hit
  const terms = markedTerms(hit.highlight)
  return (
    <>
      <span className="palette__sadr">
        <bdi>{markedText(hit.sadr, terms)}</bdi>
      </span>
      <span className="palette__gutter" aria-hidden="true">
        <Shamsa size={10} />
      </span>
      {hit.ajuz ? (
        <span className="palette__ajuz">
          <bdi>{markedText(hit.ajuz, terms)}</bdi>
        </span>
      ) : null}
      <span className="palette__meta">
        <bdi>{hit.poet.name}</bdi>
        {hit.meter ? (
          <>
            <span className="palette__sep" aria-hidden="true">
              ·
            </span>
            <bdi>{hit.meter.name}</bdi>
          </>
        ) : null}
      </span>
    </>
  )
}

/** The same nib-quiet search mark the omnibox wears; ornaments are SVG. */
function SearchMark() {
  return (
    <svg className="palette__mark" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M15.4 15.4 20 20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
