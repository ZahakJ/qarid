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
 * THE ANCHOR is what travels. `openAlbumPicker` takes the بيت's text and
 * computes `baitAnchor` itself, so no caller has to know that a ديوان is keyed
 * on content — and a بيت with no عجز (24,378 قصائد end on one) simply produces
 * no anchor and no action, rather than a button that fails on press.
 */
import { useState } from "react"

import { baitAnchor } from "../../shared/arabic.ts"
import { BAYT_FORMS, countedNounAccusative, formatBaits } from "../../shared/format.ts"
import { ALBUM_LIMITS, type AlbumSummary } from "../../shared/schema.ts"
import { useAlbums, type AlbumPick } from "../store/albumsStore.ts"
import { AlbumModal } from "./Modal.tsx"
import { VISIBILITY } from "./visibility.ts"

/** What a caller hands `openAlbumPicker` — one بيت, or a whole قصيدة's worth. */
export type PickableBait = { sadr: string; ajuz: string | null | undefined }

/**
 * Open the picker on one بيت. A no-op when the بيت carries no عجز — see the
 * header; the caller's own `albumAction` never renders a button in that case,
 * so this is the belt to that braces.
 */
export function openAlbumPicker(bait: PickableBait, label = "هذا البيت"): void {
  const anchor = baitAnchor(bait.sadr, bait.ajuz)
  if (!anchor) return
  useAlbums.getState().open({ anchors: [anchor], label })
}

/**
 * Open it on a whole قصيدة. The أبيات with no عجز are dropped here rather than
 * refused by the server, and the count the sheet prints is of what will
 * actually be added — «أضِف 41 بيتًا» over a 42-بيت قصيدة whose last line the
 * scrape cut in half is the honest number.
 */
export function openAlbumPickerForPoem(baits: readonly PickableBait[], label: string): void {
  const anchors: string[] = []
  const seen = new Set<string>()
  for (const b of baits) {
    const anchor = baitAnchor(b.sadr, b.ajuz)
    if (!anchor || seen.has(anchor)) continue
    seen.add(anchor)
    anchors.push(anchor)
    if (anchors.length >= ALBUM_LIMITS.bulk) break
  }
  if (anchors.length === 0) return
  useAlbums.getState().open({ anchors, label })
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
   * The bulk note keeps its VERB in front of a fixed subject.
   *
   * «تُضاف {n}» put the verb ahead of the معدود, whose gender then moves under
   * it — «تُضاف بيتان» wants يُضاف, «تُضاف 12 بيتًا» wants يُضاف, and only 3–10
   * came out right. «يأخذ الديوان…» agrees with الديوان and never with the
   * number, and the معدود that follows is مفعول به, so it goes through
   * `countedNounAccusative` («بيتين», not «بيتان»).
   */
  const note =
    pick.anchors.length === 1
      ? "الديوان مجموعتك أنت — تُسمّيها، وترتّبها، وتختار من يراها."
      : `يأخذ الديوان الذي تختاره ${countedNounAccusative(pick.anchors.length, BAYT_FORMS)}.`

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
                    <span className="dwpick__n">{formatBaits(a.count)}</span>
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
