/**
 * ONE card for a ديوان, wherever a ديوان is listed.
 *
 * Three surfaces show a shelf without opening it — «دواويني», «من مكتبتك» and
 * «دواوينه» on a profile — and they used to be one component and two copies of
 * it. They are the same object seen from three angles, so what changes between
 * them is a LINE, not a layout: your own card says when you last touched it, a
 * kept one says whose it is, and a published one says the same. The frame, the
 * corner pieces, the sweep and the count are identical, because a reader should
 * recognise a ديوان on sight.
 *
 * `SavedDiwanCard` is the one shape that is genuinely different, and only
 * because it can be EMPTY: a curator may take his shelf back to `private` after
 * you kept it, and the row survives him doing so with nothing on it
 * (`SavedAlbumSchema.gated`). It prints what is true then — «صار خاصًّا» — and
 * offers the one act still available, which is to let it go.
 */
import type React from "react"

import { arabicDate, formatBaits } from "../../shared/format.ts"
import type { AlbumSummary, SavedAlbum } from "../../shared/schema.ts"
import { PanelCorners } from "../components/Ornaments.tsx"
import { routeHash } from "../router.ts"
import { VisibilityBadge } from "./AlbumPicker.tsx"

/** What the meta line under the title says — one line, never two. */
export type DiwanCardFoot = "updated" | "curator"

export function DiwanCard({
  album,
  index = 0,
  foot = "updated",
}: {
  album: AlbumSummary
  index?: number
  foot?: DiwanCardFoot
}) {
  return (
    <a
      className="dwcard"
      href={routeHash({ view: "diwan", code: album.code })}
      data-enter
      style={{ "--enter-i": Math.min(index, 7) } as React.CSSProperties}
    >
      <PanelCorners size={12} />
      <span className="dwcard__sweep" aria-hidden="true" />
      <span className="dwcard__title">
        <bdi>{album.title}</bdi>
      </span>
      {album.description ? <span className="dwcard__desc">{album.description}</span> : null}
      <span className="dwcard__meta">
        <span className="dwcard__n">{formatBaits(album.count)}</span>
        {/* من يراه is the OWNER's business: on somebody else's shelf the badge
            would say «مفتوح» on every card and mean nothing. */}
        {album.isOwner ? <VisibilityBadge album={album} /> : null}
      </span>
      <span className="dwcard__foot">
        <span className="dwcard__when">
          {foot === "curator" ? (
            <>
              جَمَعه <bdi>{album.curator.displayName}</bdi>
            </>
          ) : (
            arabicDate(album.updatedAt)
          )}
        </span>
        <span className="dwcard__go" aria-hidden="true">
          افتحه ←
        </span>
      </span>
    </a>
  )
}

/** «صار خاصًّا» — the row without its shelf, and the one act left on it. */
export function SavedDiwanCard({
  row,
  index = 0,
  onDrop,
}: {
  row: SavedAlbum
  index?: number
  onDrop: () => void
}) {
  if (row.album) return <DiwanCard album={row.album} index={index} foot="curator" />
  return (
    <div className="dwcard dwcard--gone" data-enter style={{ "--enter-i": Math.min(index, 7) } as React.CSSProperties}>
      <PanelCorners size={12} />
      <span className="dwcard__title dwcard__title--gone">
        {row.gated === "blocked" ? "ديوانٌ محجوب" : "ديوانٌ صار خاصًّا"}
      </span>
      <span className="dwcard__desc">
        {/* The gate is `blockExistsBetween` — it fires whichever way round the
            حظر runs — so the card may not say «حجبتَ صاحبه»: to the reader who
            was blocked, «ارفع الحظر» is advice he cannot take, on a row he
            cannot explain. What is true either way is that a حظر stands
            between them, and that this row is his to remove. */}
        {row.gated === "blocked"
          ? "بينك وبين جامعه حَظرٌ، فلا يُعرض لك ما جمع. ارفعه من صفحته إن كان منك، وإلّا فأخرِج الديوان من مكتبتك."
          : "أعاده صاحبه إلى نفسه بعد أن حفظتَه، فلم يبقَ منه إلا موضعُه في مكتبتك."}
      </span>
      <span className="dwcard__foot">
        <span className="dwcard__when">حُفظ في {arabicDate(row.savedAt)}</span>
        <button type="button" className="btn btn--ghost dwcard__drop" onClick={onDrop}>
          أخرِجه
        </button>
      </span>
    </div>
  )
}
