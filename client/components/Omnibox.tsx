/**
 * The omnibox (design-ux.md §3 Home): one field over the whole ديوان, with a
 * 200 ms-debounced dropdown of three groups — شعراء · أبيات · قصائد, at most
 * four rows each.
 *
 * Behaviours worth stating because they are easy to get wrong here:
 *  • `/` focuses it from anywhere. The key is registered globally in App.tsx and
 *    routed here through `focusOmnibox()`, so the shortcut works on every page
 *    the box is mounted on and does nothing (rather than stealing a slash) on
 *    the pages it is not.
 *  • ↓ / ↑ walk the three groups as ONE list. They are NOT mirrored — a
 *    dropdown is vertical in both directions. The mirrored pair (← next,
 *    → previous, amendments §15) belongs to browse pagination, not to this.
 *  • Enter on a highlighted row goes to it; Enter with nothing highlighted runs
 *    the full search — the field is a search box first and a picker second.
 *  • Escape closes the dropdown, and closes it BEFORE it clears the text, so
 *    the reader can always see what they typed.
 *  • the request carries an AbortSignal, which also opts it out of the API
 *    client's in-flight dedupe — a keystroke's answer must never be handed to a
 *    later keystroke's caller.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { search } from "../api/queries.ts"
import { useDebounced } from "../hooks/useDebounced.ts"
import { useNarrow } from "../hooks/useMediaQuery.ts"
import { navigate, routeHash } from "../router.ts"
import type { SearchResponse } from "../../shared/schema.ts"
import {
  flatten,
  groupSuggestions,
  moveCursor,
  suggestionNote,
  suggestionTitle,
  OMNIBOX_GROUP_LIMIT,
  type Suggestion,
} from "./omnibox.ts"

// The palette's own placeholder, which PARSES («بيتٍ» is a بدل of الديوان)
// and needs no number. The old one hung «بيتٍ، أو شاعرٍ» off an ellipsis with
// nothing governing the جرّ, and carried a hard-coded count that went stale at
// the next re-ingest.
export const OMNIBOX_PLACEHOLDER = "ابحث في الديوان: بيتٍ، أو قصيدةٍ، أو شاعرٍ، أو قافيةٍ"

/**
 * The same invitation, short enough to survive a phone.
 *
 * A placeholder is the one string CSS cannot shorten — it clips, and it clips
 * mid-word: at 390px the long one reads «… أو قافـ», which looks like a bug in
 * the corpus rather than a narrow screen. So the swap is in JS, on the
 * product's own NARROW breakpoint, and it drops what the reader can already see
 * elsewhere: «الديوان» (the hero line above names it) and «قصيدةٍ» (the field
 * is the only search on the page).
 */
export const OMNIBOX_PLACEHOLDER_NARROW = "ابحث: بيتٍ، أو شاعرٍ، أو قافيةٍ"

/** The mounted omnibox's input, so `/` can reach it from the shell. */
let mounted: HTMLInputElement | null = null

/**
 * Focus + select the omnibox if one is on screen. Returns whether it was.
 *
 * `isConnected` is the load-bearing half: the shell's `/` key asks this first
 * and opens the global palette when the answer is no, so a pointer left over
 * from an unmounted view would silently swallow the key — focusing a detached
 * input does nothing at all, quietly, and reports success.
 */
export function focusOmnibox(): boolean {
  if (!mounted || !mounted.isConnected) return false
  mounted.focus()
  mounted.select()
  return true
}

export function Omnibox({
  autoFocus = false,
  placeholder,
  initial = "",
}: {
  autoFocus?: boolean
  /** Overrides both defaults; leave it out to get the width-appropriate one. */
  placeholder?: string
  initial?: string
}) {
  const narrow = useNarrow()
  const hint = placeholder ?? (narrow ? OMNIBOX_PLACEHOLDER_NARROW : OMNIBOX_PLACEHOLDER)
  const [text, setText] = useState(initial)
  const [res, setRes] = useState<SearchResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const [busy, setBusy] = useState(false)
  // #/search mounts this box already carrying the query. Fetching suggestions
  // for it is right (the reader may refine); DROPPING A DROPDOWN OVER THE
  // RESULTS THEY CAME TO READ is not. The dropdown is armed by typing.
  const [typed, setTyped] = useState(false)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()

  const debounced = useDebounced(text.trim(), 200)

  // The NODE is captured, not re-read from the ref on the way out: React
  // detaches a ref before it runs the cleanup that follows it, so
  // `mounted === inputRef.current` was comparing against null and the pointer
  // outlived the component. It matters on every route: the router's first
  // render is always HOME (the hash is parsed in an effect), so an omnibox is
  // mounted and unmounted before #/poets ever paints.
  useEffect(() => {
    const el = inputRef.current
    mounted = el
    return () => {
      if (mounted === el) mounted = null
    }
  }, [])

  // ── the typeahead request ────────────────────────────────────────────────
  useEffect(() => {
    if (debounced.length < 2) {
      setRes(null)
      setBusy(false)
      return
    }
    const ac = new AbortController()
    setBusy(true)
    search({ q: debounced, scope: "all", limit: OMNIBOX_GROUP_LIMIT }, { signal: ac.signal })
      .then((r) => {
        if (ac.signal.aborted) return
        setRes(r)
        setCursor(-1)
        if (typed) setOpen(true)
      })
      .catch((e: unknown) => {
        // A dropdown is not worth an error state; the full search page will say
        // so properly if the reader presses Enter.
        if (!(e instanceof ApiError) || e.kind !== "aborted") setRes(null)
      })
      .finally(() => {
        if (!ac.signal.aborted) setBusy(false)
      })
    return () => ac.abort()
  }, [debounced, typed])

  // ── dismissal ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("pointerdown", onDown)
    return () => window.removeEventListener("pointerdown", onDown)
  }, [open])

  const groups = groupSuggestions(res)
  const flat = flatten(groups)
  const showing = open && (flat.length > 0 || (debounced.length >= 2 && !busy))

  const go = useCallback((s: Suggestion) => {
    setOpen(false)
    navigate(s.route)
  }, [])

  const runSearch = useCallback(() => {
    const q = text.trim()
    if (!q) return
    setOpen(false)
    navigate({ view: "search", q, page: 1 })
  }, [text])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        if (flat.length === 0) return
        e.preventDefault()
        setTyped(true)
        setOpen(true)
        setCursor((c) => moveCursor(c, 1, flat.length))
        break
      case "ArrowUp":
        if (flat.length === 0) return
        e.preventDefault()
        setCursor((c) => moveCursor(c, -1, flat.length))
        break
      case "Enter": {
        e.preventDefault()
        const picked = cursor >= 0 ? flat[cursor] : undefined
        if (picked) go(picked)
        else runSearch()
        break
      }
      case "Escape":
        if (showing) {
          e.preventDefault()
          setOpen(false)
          setCursor(-1)
        } else {
          inputRef.current?.blur()
        }
        break
      default:
    }
  }

  const activeId = cursor >= 0 && flat[cursor] ? `${listId}-${cursor}` : undefined

  return (
    <div className="omnibox" ref={boxRef}>
      <div className="omnibox__field">
        <SearchMark />
        <input
          ref={inputRef}
          type="search"
          className="omnibox__input"
          dir="rtl"
          lang="ar"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label="البحث في الديوان"
          placeholder={hint}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setTyped(true)
            setOpen(true)
            setCursor(-1)
          }}
          onFocus={() => {
            if (flat.length > 0) setOpen(true)
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="omnibox__key" aria-hidden="true">
          /
        </kbd>
      </div>

      {showing ? (
        <div className="omnibox__drop" id={listId} role="listbox" aria-label="نتائج مقترحة">
          {groups.length === 0 ? (
            <p className="omnibox__none">لا شيء بهذا اللفظ — جرّب «{text.trim()}» في البحث الكامل.</p>
          ) : (
            groups.map((g) => (
              <div className="omnibox__group" key={g.kind}>
                <h3 className="omnibox__label">{g.label}</h3>
                {g.items.map((s) => {
                  const i = flat.indexOf(s)
                  return (
                    <a
                      key={s.id}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === cursor}
                      className="omnibox__row"
                      data-kind={s.kind}
                      data-cursor={i === cursor ? "1" : undefined}
                      href={routeHash(s.route)}
                      onMouseEnter={() => setCursor(i)}
                      onClick={(e) => {
                        e.preventDefault()
                        go(s)
                      }}
                    >
                      <span className="omnibox__title">
                        <bdi>{suggestionTitle(s)}</bdi>
                      </span>
                      <span className="omnibox__note">
                        <bdi>{suggestionNote(s)}</bdi>
                      </span>
                    </a>
                  )
                })}
              </div>
            ))
          )}
          <button type="button" className="omnibox__all" onClick={runSearch}>
            كل النتائج ←
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** A quiet nib-shaped search mark; ornaments are SVG, never font glyphs. */
function SearchMark() {
  return (
    <svg className="omnibox__mark" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M15.4 15.4 20 20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
