/**
 * «أضِف إلى ديوان» — the picker, and the ONE way a بيت gets onto a shelf.
 *
 * It is opened imperatively (`openAlbumPicker(...)`), exactly the way البطاقة is
 * (`openShareCard` in client/share/ShareDialog.tsx): a بيت's action rail lives
 * in fourteen views, and every one of them owning a piece of dialog state would
 * be fourteen copies of the same bug. `<AlbumPickerHost/>` mounts once, in
 * App.tsx.
 *
 * Two doors and one surface: a bottom sheet on a phone, a centred dialog on the
 * desktop — `AlbumModal` makes that choice for every album surface, once. What
 * is inside is identical: your دواوين as rows, «ديوانٌ جديد» inline at the bottom, and nothing else. There is no
 * visibility control here on purpose — the reader is in the middle of reading a
 * قصيدة, and «who may see this» is a decision for the shelf's own page.
 *
 * THE ANCHOR is what travels for a بيت. `openAlbumPicker` takes the بيت's text
 * and computes `baitAnchor` itself, so no caller has to know that a ديوان is
 * keyed on content — and a بيت with no عجز (24,378 قصائد end on one) simply
 * produces no anchor and no action, rather than a button that fails on press.
 * A قصيدة travels as its public id — the one thing the poem page honestly
 * knows — and the SERVER derives its durable anchor from the dedup key.
 */
import { useState } from "react"

import { baitAnchor } from "../../shared/arabic.ts"
import { formatAlbumContents } from "../../shared/format.ts"
import { ALBUM_LIMITS, type AlbumSummary, type PoemSummary } from "../../shared/schema.ts"
import { useAlbums, type AlbumPick } from "../store/albumsStore.ts"
import { AlbumModal } from "./Modal.tsx"
import { VISIBILITY } from "./visibility.ts"

/** What a caller hands `openAlbumPicker` — one بيت. */
export type PickableBait = { sadr: string; ajuz: string | null | undefined }

/**
 * Open the picker on one بيت. A no-op when the بيت carries no عجز — see the
 * header; the caller's own `albumAction` never renders a button in that case,
 * so this is the belt to that braces.
 */
export function openAlbumPicker(bait: PickableBait, label = "هذا البيت"): void {
  const anchor = baitAnchor(bait.sadr, bait.ajuz)
  if (!anchor) return
  useAlbums.getState().open({ items: [{ kind: "bait", hFull: anchor }], label })
}

/**
 * Open it on a whole قصيدة — ONE entry, the playlist's unit. The picker sends
 * the id; the server anchors the قصيدة by content and takes its own snapshot,
 * so the caller hands over nothing it would have to be trusted about.
 */
export function openAlbumPickerForPoem(poem: Pick<PoemSummary, "id">, label = "هذه القصيدة"): void {
  useAlbums.getState().open({ items: [{ kind: "poem", id: poem.id }], label })
}

/**
 * The handler a `BaytPlate` gets, or undefined when this بيت cannot be
 * anchored. Returning `undefined` is what keeps the rail honest: `BaytActions`
 * renders no button for an action with no handler, so a partial بيت has four
 * affordances and not a fifth that apologises.
 */
export function albumAction(bait: PickableBait, label?: string): (() => void) | undefined {
  if (!baitAnchor(bait.sadr, bait.ajuz)) return undefined
  return () => openAlbumPicker(bait, label)
}

export function AlbumPickerHost() {
  const pick = useAlbums((s) => s.pick)
  if (!pick) return null
  return <AlbumPicker pick={pick} />
}

const TITLE = "أضِف إلى ديوان"

function AlbumPicker({ pick }: { pick: AlbumPick }) {
  const albums = useAlbums((s) => s.albums)
  const status = useAlbums((s) => s.status)
  const busy = useAlbums((s) => s.busy)
  const error = useAlbums((s) => s.error)
  const close = useAlbums((s) => s.close)
  const addTo = useAlbums((s) => s.addTo)
  const create = useAlbums((s) => s.create)

  const [name, setName] = useState("")

  /** «ديوانٌ جديد» — create, then put the pick straight on it. One gesture. */
  const createAndAdd = async () => {
    const title = name.trim()
    if (!title || busy) return
    const code = await create(title)
    if (!code) return
    setName("")
    await addTo(code)
  }

  /**
   * The note says what KIND of thing is being added, because the two are
   * different objects on the shelf: a قصيدة goes in whole, as one entry that
   * opens on its first بيت, and the reader is owed that sentence before he
   * presses — «forty rows appeared» is exactly the surprise this shape exists
   * to remove.
   */
  const note = pick.items.some((i) => i.kind === "poem")
    ? "تدخل القصيدة الديوان كاملةً، مدخلًا واحدًا يُفتح من مطلعها — لا أبياتًا مفرّقة."
    : "الديوان مجموعتك أنت — تُسمّيها، وترتّبها، وتختار من يراها."

  return (
    <AlbumModal title={TITLE} note={note} onClose={close} className="dwmodal--pick">
      <div className="dwpick">
        {status === "loading" && albums.length === 0 ? (
          <p className="dwpick__quiet">…تُجلب دواوينك</p>
        ) : albums.length === 0 ? (
          <p className="dwpick__quiet">
            لا ديوان لك بعد. سَمِّ أوّلَ دواوينك في السطر أدناه، ويُضاف إليه ما اخترتَه في الحال.
          </p>
        ) : (
          <ul className="dwpick__list">
            {albums.map((a) => (
              <li key={a.code}>
                <button type="button" className="dwpick__row" onClick={() => void addTo(a.code)} disabled={busy}>
                  <span className="dwpick__name">
                    <bdi>{a.title}</bdi>
                  </span>
                  <span className="dwpick__meta">
                    <span className="dwpick__n">{formatAlbumContents(a.poems, a.baits)}</span>
                    <VisibilityBadge album={a} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="dwpick__new">
          <label className="dwpick__label" htmlFor="dwpick-name">
            ديوانٌ جديد
          </label>
          <div className="dwpick__newrow">
            <input
              id="dwpick-name"
              className="dwfield dwpick__field"
              type="text"
              value={name}
              maxLength={60}
              placeholder="سَمِّه: «ما أحفظه»، «قوافي الميم»…"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void createAndAdd()
                }
              }}
              disabled={busy || albums.length >= ALBUM_LIMITS.perUser}
            />
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void createAndAdd()}
              disabled={busy || !name.trim() || albums.length >= ALBUM_LIMITS.perUser}
            >
              أنشئه وأضِف
            </button>
          </div>
          {albums.length >= ALBUM_LIMITS.perUser ? (
            <p className="dwpick__quiet">بلغتَ أقصى عدد من الدواوين — احذف واحدًا لتُنشئ غيره.</p>
          ) : null}
        </div>

        {error ? (
          <p className="dwpick__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </AlbumModal>
  )
}

/** The three states of «من يراه», as one small mark. */
export function VisibilityBadge({ album }: { album: Pick<AlbumSummary, "visibility"> }) {
  const v = VISIBILITY[album.visibility]
  return (
    <span className="dwbadge" data-v={album.visibility} title={v.note}>
      {v.label}
    </span>
  )
}
