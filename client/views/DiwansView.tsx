/**
 * `#/diwans` — «دواويني», the index of the shelves you have compiled.
 *
 * It exists for the reader who has named four of them: one is a bookmark, four
 * is a library, and a library needs a page. Card per ديوان — name in the display
 * face, how many أبيات, who may see it, when it last moved — and one door to
 * make another.
 *
 * It lists YOUR shelves and nobody else's, because that is the only listing the
 * server has: `/api/albums/mine` reads the session's own id and there is no
 * route that enumerates another account's دواوين at all
 * (server/routes/albums.ts). A shelf reaches other people the way its design
 * intends — by its link.
 *
 * Under them sits «من مكتبتك»: the دواوين other readers compiled and this one
 * KEPT. They are not copies — the row points at the curator's shelf, so what he
 * adds tomorrow is on it — which is also why one of them can go quiet: he may
 * take it back to `private`, and then the card says so and offers to let it go.
 */
import { useEffect, useState } from "react"

import { EmptyState } from "../components/EmptyState.tsx"
import { Rule, Shamsa } from "../components/Ornaments.tsx"
import { useAlbums } from "../store/albumsStore.ts"
import { useAuth } from "../store/authStore.ts"
import { navigate } from "../router.ts"
import { ALBUM_LIMITS } from "../../shared/schema.ts"
import { AlbumModal } from "../albums/Modal.tsx"
import { DiwanCard, SavedDiwanCard } from "../albums/DiwanCard.tsx"

export function DiwansView() {
  const user = useAuth((s) => s.user)
  const authStatus = useAuth((s) => s.status)
  const openAuth = useAuth((s) => s.openDialog)
  const albums = useAlbums((s) => s.albums)
  const status = useAlbums((s) => s.status)
  const error = useAlbums((s) => s.error)
  const reload = useAlbums((s) => s.reload)
  const [creating, setCreating] = useState(false)

  // Re-read on every mount: another tab, the picker's inline «ديوانٌ جديد» and
  // a shelf page's own edits all write to the same list, and this page is where
  // a reader comes to see the result.
  useEffect(() => {
    if (user) void reload()
  }, [user, reload])

  if (authStatus !== "unknown" && !user) {
    return (
      <div className="view diwans-view">
        <DiwansHead count={null} onNew={null} />
        <EmptyState flavor="no-favorites" title="الدواوين تحمل اسمك">
          <p className="diwans-empty">
            الديوان مجموعةٌ لها رمزٌ ورابط، فهي محفوظة في الحساب لا في هذا المتصفّح. ادخل بحسابك لتبدأ أوّلَها.
          </p>
          <button type="button" className="btn btn--primary" onClick={() => openAuth("login")}>
            دخول
          </button>
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="view diwans-view">
      <DiwansHead count={albums.length} onNew={albums.length >= ALBUM_LIMITS.perUser ? null : () => setCreating(true)} />

      {error && status === "error" ? (
        <EmptyState flavor="facets-zero" title="تعذّر فتح دواوينك">
          <p className="diwans-empty">{error}</p>
        </EmptyState>
      ) : albums.length === 0 && status !== "ready" ? (
        <div className="diwans-grid" aria-hidden="true">
          <div className="dwcard dwcard--ghost" />
          <div className="dwcard dwcard--ghost" />
        </div>
      ) : albums.length === 0 ? (
        <EmptyState flavor="no-favorites" title="لا ديوان لك بعد">
          <p className="diwans-empty">
            كان لكلّ شاعرٍ ديوانٌ جمعه له راوٍ أو جمعه لنفسه. هذا دورك: افتح قصيدةً وانقر «أضِف إلى ديوان» تحت
            بيتٍ أعجبك، أو سَمِّ ديوانك أوّلًا وامْلأه بعدُ.
          </p>
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
            ديوانٌ جديد
          </button>
        </EmptyState>
      ) : (
        <div className="diwans-grid">
          {albums.map((a, i) => (
            <DiwanCard key={a.code} album={a} index={i} />
          ))}
        </div>
      )}

      {/* The مكتبة sits UNDER your own shelves, and only when it has something
          in it — a reader who has kept nothing should not be told so. */}
      <LibrarySection />

      {creating ? (
        <NewDiwanModal
          onClose={() => setCreating(false)}
          onCreated={(code) => {
            setCreating(false)
            navigate({ view: "diwan", code })
          }}
        />
      ) : null}
    </div>
  )
}

function DiwansHead({ count, onNew }: { count: number | null; onNew: (() => void) | null }) {
  return (
    <header className="view__head diwans-head">
      <h1 className="view__title">دواويني</h1>
      <p className="view__lede">
        لكلّ شاعرٍ ديوان، ولك أنت أيضًا: تختار الأبيات من ثلاثة ملايين، وتُرتّبها، وتُسمّيها، وتُعطي رابطها من
        تشاء.
      </p>
      <div className="diwans-head__row">
        {count !== null ? (
          <span className="diwans-head__count">
            <Shamsa size={11} />
            <span>
              {count === 0 ? "لا ديوان بعد" : `${count} من ${ALBUM_LIMITS.perUser}`}
            </span>
          </span>
        ) : null}
        {onNew ? (
          <button type="button" className="btn btn--primary" onClick={onNew}>
            ديوانٌ جديد
          </button>
        ) : null}
      </div>
      <Rule className="diwans-head__rule" />
    </header>
  )
}

/**
 * «من مكتبتك» — the دواوين OTHER readers compiled and this one kept.
 *
 * It is a SECTION of this page and not a page of its own: a reader who saved
 * two shelves has one library, and «دواويني» is the word for the whole of it.
 * The section simply does not exist while the مكتبة is empty — an empty state
 * for a feature nobody has used yet is a page telling you what you have not
 * done.
 */
function LibrarySection() {
  const saved = useAlbums((s) => s.saved)
  const keep = useAlbums((s) => s.keep)
  if (saved.length === 0) return null
  return (
    <section className="diwans-shelf" aria-labelledby="diwans-library">
      <header className="diwans-shelf__head">
        <h2 className="diwans-shelf__title" id="diwans-library">
          من مكتبتك
        </h2>
        <p className="diwans-shelf__note">دواوينُ جمعها غيرُك وحفظتَها. تبقى في يد صاحبها، فما زاده فيها رأيتَه.</p>
      </header>
      <Rule className="diwans-shelf__rule" />
      <div className="diwans-grid">
        {saved.map((row, i) => (
          <SavedDiwanCard key={row.code} row={row} index={i} onDrop={() => void keep(row.code, false)} />
        ))}
      </div>
    </section>
  )
}

/** «ديوانٌ جديد» from the index — name it, then land on it. */
function NewDiwanModal({ onClose, onCreated }: { onClose: () => void; onCreated: (code: string) => void }) {
  const create = useAlbums((s) => s.create)
  const busy = useAlbums((s) => s.busy)
  const error = useAlbums((s) => s.error)
  const [name, setName] = useState("")

  const submit = async () => {
    const title = name.trim()
    if (!title || busy) return
    const code = await create(title)
    if (code) onCreated(code)
  }

  return (
    <AlbumModal
      title="ديوانٌ جديد"
      note="سَمِّه الآن؛ الوصف ومن يراه يُضبطان في صفحته."
      onClose={onClose}
      className="dwmodal--new"
      footer={
        <>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            أنشئه
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            تراجع
          </button>
        </>
      }
    >
      <div className="diwan-edit">
        <label className="diwan-edit__label" htmlFor="dwnew-name">
          الاسم
        </label>
        <input
          id="dwnew-name"
          className="dwfield"
          type="text"
          value={name}
          maxLength={60}
          placeholder="«ما أحفظه»، «قوافي الميم»، «أبيات الحكمة»…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {error ? (
          <p className="diwan-edit__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </AlbumModal>
  )
}
