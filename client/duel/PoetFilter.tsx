/**
 * «الشاعر» — the third «قيد» on the duel setup screen (`#/duel`).
 *
 * العصر and البحر are twelve and sixteen chips, so they are laid out whole. A
 * شاعر is 6,941 of them, so this control is a SEARCH, and it rides the exact
 * path the palette's شعراء group already rides — `/api/search?scope=poets`,
 * ranked name-hit → fame → bm25 by `rankedPoetRefs` (CLAUDE.md: bm25 alone put
 * «المشوق الشامي صديق المتنبي» above «المتنبي»). That ranking is the whole
 * usability of this field: a reader types «المتنبي» and the first row is him.
 *
 * Once chosen he is a REMOVABLE CHIP and the field goes away, because the
 * control has stopped being a question. The chip carries his ديوان's size for
 * the same reason the tier table carries its parameters: «364 قصيدة» is what
 * tells you whether a مساجلة in this ديوان is a مساجلة at all, before the pool
 * line under it is even counted.
 *
 * Two things it deliberately does NOT do. It never lists شعراء before you type
 * — an unasked-for list of six famous names is a recommendation, and the ديوان
 * has 6,941 — and it never pages: this is a picker, not `#/poets`. What it
 * cannot find in six ranked rows is found by narrowing the words, which is also
 * the one thing that makes the request cheap.
 */
import { useEffect, useId, useRef, useState } from "react"

import { QASIDA_FORMS, countedUnit, formatCount } from "../../shared/format.ts"
import type { PoetHit } from "../../shared/schema.ts"
import { ApiError } from "../api/client.ts"
import { search } from "../api/queries.ts"
import { PALETTE_DEBOUNCE_MS, PALETTE_MIN_CHARS } from "../components/palette.ts"
import { useDebounced } from "../hooks/useDebounced.ts"

/** The chosen شاعر, denormalized exactly as far as the screen needs him. */
export type PoetPick = { slug: string; name: string; poemCount: number } | null

/** How many ranked rows the field offers. A picker, not a list — see above. */
export const POET_PICK_LIMIT = 6

/**
 * What actually goes on the wire: the typed text with a prefix star on its last
 * word.
 *
 * A picker has to answer WHILE the name is being typed, and FTS5 matches whole
 * tokens — «المتنب» found nothing at all until the ياء landed, which for a
 * field whose entire job is "find me this شاعر" is the difference between a
 * control and a guessing game. The star is the one piece of FTS5 syntax the app
 * already exposes (v2.md §2's wildcard, `stars: true` in server/search.ts).
 *
 * It is affordable HERE and would not be everywhere: `scope=poets` never opens
 * `baits_fts` (3.37M rows — where `PREFIX_MIN_LENGTH` was measured at up to
 * 2,058 ms for a two-letter prefix), and `poets_fts` is 6,941 rows, a whole
 * ranked scan of which is under a millisecond. A star on a too-short word is
 * dropped by the server and the word is searched whole, so nothing here has to
 * know the floor — `PREFIX_MIN_LENGTH` stays the server's business.
 */
export function poetQuery(text: string): string {
  const q = text.trim()
  return q === "" || q.endsWith("*") ? q : `${q}*`
}

export function PoetFilter({ value, onChange }: { value: PoetPick; onChange: (next: PoetPick) => void }) {
  const [text, setText] = useState("")
  const [hits, setHits] = useState<PoetHit[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const listId = useId()
  const fieldRef = useRef<HTMLInputElement | null>(null)

  const q = text.trim()
  const debounced = useDebounced(q, PALETTE_DEBOUNCE_MS)
  const asking = debounced.length >= PALETTE_MIN_CHARS

  useEffect(() => {
    if (!asking) {
      setHits([])
      setBusy(false)
      setFailed(false)
      return
    }
    const ac = new AbortController()
    setBusy(true)
    search({ q: poetQuery(debounced), scope: "poets", limit: POET_PICK_LIMIT }, { signal: ac.signal })
      .then((res) => {
        if (ac.signal.aborted) return
        setHits(res.poets)
        setFailed(false)
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.kind === "aborted") return
        setHits([])
        setFailed(true)
      })
      .finally(() => {
        if (!ac.signal.aborted) setBusy(false)
      })
    return () => ac.abort()
  }, [debounced, asking])

  const choose = (p: PoetHit) => {
    onChange({ slug: p.slug, name: p.name, poemCount: p.poemCount })
    setText("")
    setHits([])
  }

  if (value !== null) {
    return (
      <div className="poetpick poetpick--chosen">
        <span className="poetpick__chip">
          <bdi className="poetpick__name">{value.name}</bdi>
          <span className="poetpick__count">
            {formatCount(value.poemCount)} {countedUnit(value.poemCount, QASIDA_FORMS)}
          </span>
          <button
            type="button"
            className="poetpick__off"
            onClick={() => {
              onChange(null)
              // Back to the question the chip was the answer to, focus and all.
              requestAnimationFrame(() => fieldRef.current?.focus())
            }}
            aria-label={`ارفع قيد الشاعر ${value.name}`}
            title="ارفع هذا القيد"
          >
            ✕
          </button>
        </span>
      </div>
    )
  }

  return (
    <div className="poetpick">
      <input
        ref={fieldRef}
        type="search"
        className="poetpick__field"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="اكتب اسم شاعر"
        dir="rtl"
        lang="ar"
        aria-label="ابحث عن شاعر لتحصر ما يُنشده الخصم في ديوانه"
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        // The palette owns Ctrl+K/Ctrl+F in the capture phase; Escape here is
        // the field's own, and clears what was typed rather than closing a
        // dialog this control is not inside.
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.stopPropagation()
            setText("")
          }
        }}
      />
      <div className="poetpick__answer" id={listId} aria-live="polite">
        {!asking ? (
          <p className="poetpick__note">
            {q.length > 0 ? "حرفان على الأقل." : "اتركه فارغًا ليُنشد الخصم من كل الشعراء."}
          </p>
        ) : failed ? (
          <p className="poetpick__note poetpick__note--warn">تعذّر البحث عن الشعراء.</p>
        ) : hits.length === 0 ? (
          <p className="poetpick__note">{busy ? "…" : "لا شاعر بهذا الاسم."}</p>
        ) : (
          <ul className="poetpick__list">
            {hits.map((p) => (
              <li key={p.slug}>
                <button type="button" className="poetpick__hit" onClick={() => choose(p)}>
                  <bdi className="poetpick__name">{p.name}</bdi>
                  <span className="poetpick__meta">
                    {p.era ? <span className="poetpick__era">{p.era.name}</span> : null}
                    <span className="poetpick__count">
                      {formatCount(p.poemCount)} {countedUnit(p.poemCount, QASIDA_FORMS)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
