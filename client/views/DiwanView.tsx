/**
 * `#/diwan/<CODE>` — one ديوان, the shelf a reader compiled himself.
 *
 * The page has two readers and it is the SAME page for both, with one rail
 * added: a visitor sees a title, a curator and أبيات; the owner sees those plus
 * the means to rename, describe, publish, reorder and remove. Two components
 * would have been two layouts to keep in agreement, and the owner is the reader
 * who looks at this page most.
 *
 * THE ENTRIES ARE RESOLVED, NOT STORED. Each row carries the live بيت when
 * today's artefact still holds it — and then the whole `BaytPlate` rail works
 * exactly as it does everywhere else, ♥ and بطاقة and ساجِلني — and its SNAPSHOT
 * when it does not, which renders as a بيت in a quiet state saying «ليس في
 * الديوان اليوم». The alternative was a shelf that empties itself at the next
 * `npm run ingest`, which is not a shelf.
 *
 * Reordering is up/down BUTTONS and not only a drag. A drag on a phone fights
 * the page's own scroll, a drag with a keyboard does not exist, and the شطران
 * of a بيت make a drag target that is 58rem wide and one line tall. The buttons
 * are the honest affordance; the whole order goes back in one PATCH either way
 * (`AlbumPatchRequestSchema.order` — the WHOLE list, never a move).
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react"

import { addAlbumBaits, deleteAlbum, getAlbum, getPoemBaits, patchAlbum, removeAlbumBait } from "../api/queries.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { formatBayt, formatBaytWithPoet, writeClipboard } from "../bayt/copy.ts"
import { Chip } from "../components/Chip.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { Sheet } from "../components/Sheet.tsx"
import { PanelCorners, Rule, Shamsa } from "../components/Ornaments.tsx"
import { useChromeTitle } from "../components/AppBar.tsx"
import { openShareCard } from "../share/ShareDialog.tsx"
import { useAlbums, albumMessage } from "../store/albumsStore.ts"
import { useCollections } from "../store/collectionsStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { navigate, routeHash } from "../router.ts"
import { arabicDate, formatBaits, formatMissingBaits } from "../../shared/format.ts"
import { ALBUM_LIMITS, type AlbumEntry, type AlbumResponse, type AlbumVisibility } from "../../shared/schema.ts"
import { VISIBILITY, VISIBILITY_ORDER } from "../albums/visibility.ts"
import { AlbumModal } from "../albums/Modal.tsx"
import { albumShareText } from "../albums/share.ts"
import { poemAnchors, regroupPoem, sameOrder } from "../albums/regroup.ts"
import { baitAnchor } from "../../shared/arabic.ts"
import { shareOrigin } from "../platform/native.ts"
import { albumAction, VisibilityBadge } from "../albums/AlbumPicker.tsx"
import { AlbumReportAction } from "../components/Moderation.tsx"
import { DiwanPlay } from "../albums/DiwanPlay.tsx"
import { useAuth } from "../store/authStore.ts"
import { nativeShareText } from "../platform/share.ts"

export function DiwanView({ code }: { code: string }) {
  const [data, setData] = useState<AlbumResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** anchor of the row whose قصيدة is being put back, for its busy state */
  const [restoring, setRestoring] = useState<string | null>(null)
  /** the row whose قصيدة sheet is open — قصيدة-level acts need WORDS, and a
   *  phone has no hover to put them in a tooltip. */
  const [poemSheet, setPoemSheet] = useState<AlbumEntry | null>(null)
  const merge = useAlbums((s) => s.merge)
  const forget = useAlbums((s) => s.forget)

  const load = useCallback(
    (signal?: AbortSignal) =>
      getAlbum(code, signal ? { signal } : undefined)
        .then((d) => {
          if (signal?.aborted) return
          setData(d)
          setError(null)
          if (d.album.isOwner) merge(d.album)
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return
          setError(albumMessage(e))
        }),
    [code, merge],
  )

  useEffect(() => {
    const ac = new AbortController()
    setData(null)
    setError(null)
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  /**
   * «أعِدها كاملة» — put back every بيت of one قصيدة.
   *
   * The corpus is opened read-only, so removing a بيت never touched the قصيدة
   * itself: what was lost is this SHELF's copy of it, and that is what comes
   * back. The add endpoint dedupes, so the أبيات still held are counted as
   * duplicates and only the missing ones are written.
   *
   * Then the block is re-seated (albums/regroup.ts), because an append leaves
   * the قصيدة in pieces — two survivors at rows 3 and 4 and nine restored ones
   * at the end of the shelf — which is its parts returned, not the قصيدة
   * restored. Everything the curator arranged keeps its order.
   */
  const restorePoem = useCallback(
    async (entry: AlbumEntry) => {
      const poem = entry.bait?.poem
      if (!poem || !data) return
      setRestoring(entry.hFull)
      try {
        // One page at the bulk cap: a longer قصيدة cannot be added in one
        // request anyway, and the toast says what was left behind.
        const page = await getPoemBaits(poem.id, { offset: 0, limit: ALBUM_LIMITS.bulk })

        // قصيدة order, which is the order the block will be re-seated in.
        const anchors: string[] = []
        const seen = new Set<string>()
        for (const b of [...page.items].sort((x, y) => x.position - y.position)) {
          const anchor = baitAnchor(b.sadr, b.ajuz)
          if (!anchor || seen.has(anchor)) continue
          seen.add(anchor)
          anchors.push(anchor)
        }
        if (anchors.length === 0) {
          toast("لم أجد أبيات هذه القصيدة", "danger")
          return
        }

        const res = await addAlbumBaits(code, anchors)
        merge(res.album)

        // Re-read before re-seating: the order must be built on what the shelf
        // actually holds now, not on what we hoped the add would write.
        const fresh = await getAlbum(code)
        const order = fresh.entries.map((e) => e.hFull)
        const held = new Set(order)
        const block = anchors.filter((a) => held.has(a))
        const seated = regroupPoem(order, block)

        if (!sameOrder(order, seated)) {
          const moved = await patchAlbum(code, { order: seated })
          merge(moved.album)
          const byAnchor = new Map(fresh.entries.map((e) => [e.hFull, e]))
          setData({
            ...fresh,
            album: moved.album,
            entries: seated.map((h, n) => ({ ...byAnchor.get(h)!, position: n })),
          })
        } else {
          setData(fresh)
        }

        const left = page.total - anchors.length
        if (res.added === 0) {
          toast("القصيدة كاملةٌ في ديوانك أصلًا", "info")
        } else if (left > 0) {
          toast(`أُعيد ${formatBaits(res.added)} · بقي ${formatBaits(left)} خارج الحدّ`, "info")
        } else {
          toast(`أُعيدت القصيدة كاملة — ${formatBaits(res.added)}`, "ok")
        }
      } catch (e) {
        toast(albumMessage(e), "danger")
        void load()
      } finally {
        setRestoring(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, data, merge, load],
  )

  // The app bar takes the shelf's name once the head has scrolled off, so a
  // reader deep in a 300-بيت ديوان still knows whose page he is on. The head's
  // own `<h1>` is `.diwan-head__title` and NOT a `.view__title` — the app bar
  // lends nothing until the reader scrolls, and a `.view__title` is `.sr-only`
  // on a phone, so as one the name was on no part of a 390 screen at rest.
  /**
   * «أزِل القصيدة كلها» — every بيت this shelf holds of one قصيدة, in one act.
   *
   * A ديوان is compiled a قصيدة at a time («أضِف القصيدة إلى ديوان»), so it is
   * pruned a قصيدة at a time too; taking back a forty-بيت addition one ✕ at a
   * time is forty confirmations of the same decision. There is no bulk DELETE
   * on the wire, so this is a loop — but it is ONE decision, and the shelf is
   * re-read once at the end rather than after every anchor.
   */
  const removePoem = useCallback(
    async (entry: AlbumEntry) => {
      const poem = entry.bait?.poem
      if (!poem || !data) return
      const anchors = poemAnchors(data.entries, poem.id)
      if (anchors.length === 0) return
      setRestoring(entry.hFull)
      try {
        let gone = 0
        for (const anchor of anchors) {
          await removeAlbumBait(code, anchor)
          gone += 1
        }
        const fresh = await getAlbum(code)
        setData(fresh)
        merge(fresh.album)
        toast(`أُزيلت القصيدة — ${formatBaits(gone)}`, "info")
      } catch (e) {
        toast(albumMessage(e), "danger")
        void load()
      } finally {
        setRestoring(null)
      }
    },
    [code, data, merge, load],
  )

  useChromeTitle(data?.album.title)

  if (error) {
    return (
      <div className="view diwan-view">
        <EmptyState flavor="facets-zero" title="لا ديوان هنا">
          <p className="diwan-error">{error}</p>
          <p className="diwan-error">
            رمز الديوان هو مفتاحه: إن كان الديوان خاصًّا بصاحبه، أو تغيّر حرفٌ من الرمز، فلا باب.
          </p>
        </EmptyState>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="view diwan-view">
        <BaytSkeleton rows={5} />
      </div>
    )
  }

  const { album, entries } = data
  const live = entries.filter((e) => e.bait !== null).length

  return (
    <div className="view diwan-view">
      <DiwanHead
        album={album}
        live={live}
        onChanged={(fresh) => {
          setData({ ...data, album: fresh })
          // …into «دواويني» only when it IS one. The head also reports a
          // visitor's «أضِفه إلى مكتبتك» through this callback, and `merge`
          // INSERTS what it does not find — which would have put another
          // reader's shelf on this reader's own list until the next reload.
          if (fresh.isOwner) merge(fresh)
        }}
        onDeleted={() => {
          forget(album.code)
          toast("حُذف الديوان", "info")
          navigate({ view: "diwans" })
        }}
      />

      {/* The قصيدة sheet: the two acts that operate on a whole قصيدة rather
          than on one بيت, said in words. It counts what is on the shelf so
          neither act is a leap — «5 أبيات من هذه القصيدة في ديوانك». */}
      {poemSheet ? (
        <PoemActsSheet
          entry={poemSheet}
          held={poemSheet.bait ? poemAnchors(entries, poemSheet.bait.poem.id).length : 0}
          busy={restoring === poemSheet.hFull}
          onClose={() => setPoemSheet(null)}
          onRestore={() => {
            const e = poemSheet
            setPoemSheet(null)
            void restorePoem(e)
          }}
          onRemove={() => {
            const e = poemSheet
            setPoemSheet(null)
            void removePoem(e)
          }}
        />
      ) : null}

      {entries.length === 0 ? (
        <EmptyState flavor="no-favorites" title="ديوانٌ لم يُنسخ فيه بيتٌ بعد">
          <p className="diwan-empty">
            {album.isOwner
              ? "افتح قصيدةً، وانقر «أضِف إلى ديوان» تحت البيت الذي أعجبك — أو أضِف القصيدة كلّها من رأسها."
              : "لم يضع صاحب هذا الديوان فيه شيئًا بعد."}
          </p>
          {/* An empty state that names the gesture and then leaves the reader
              on it is a page with no way forward: «افتح قصيدةً» is a door and
              it should BE one. «دواويني»'s own empty state carries «ديوانٌ
              جديد» for the same reason. */}
          {album.isOwner ? (
            <a className="btn btn--primary" href={routeHash({ view: "browse", query: {} })}>
              إلى التصفح
            </a>
          ) : null}
        </EmptyState>
      ) : (
        <ol className="diwan-rows" data-bayt-list>
          {entries.map((entry, i) => (
            <DiwanRow
              key={entry.hFull}
              entry={entry}
              index={i}
              total={entries.length}
              owner={album.isOwner}
              onMove={async (to) => {
                const order = entries.map((e) => e.hFull)
                const [moved] = order.splice(i, 1)
                order.splice(to, 0, moved!)
                // Optimistic: the rows re-seat under the thumb, and the request
                // that follows is the WHOLE order, so a failure re-loads into
                // the truth rather than leaving a half-applied move.
                setData({
                  ...data,
                  entries: order.map((h, n) => ({ ...entries.find((e) => e.hFull === h)!, position: n })),
                })
                try {
                  const res = await patchAlbum(album.code, { order })
                  merge(res.album)
                } catch (e) {
                  toast(albumMessage(e), "danger")
                  void load()
                }
              }}
              onPoemActs={entry.bait ? () => setPoemSheet(entry) : undefined}
              busy={restoring === entry.hFull}
              onRemove={async () => {
                try {
                  const res = await removeAlbumBait(album.code, entry.hFull)
                  merge(res.album)
                  setData({
                    ...data,
                    album: res.album,
                    entries: entries.filter((e) => e.hFull !== entry.hFull).map((e, n) => ({ ...e, position: n })),
                  })
                  toast("أُزيل البيت من الديوان", "info")
                } catch (e) {
                  toast(albumMessage(e), "danger")
                }
              }}
            />
          ))}
        </ol>
      )}

      {/* The three doors sit UNDER the أبيات, not over them: a ديوان is read
          first and played second, and a panel of buttons above the شعر would
          make the shelf look like a game menu. */}
      {entries.length > 0 ? <DiwanPlay album={album} entries={entries} /> : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The head
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The شمسة-framed head: the title in Aref Ruqaa, the curator, the count, and —
 * for the owner — the three controls that change what this shelf IS.
 *
 * «انسخ الرابط» is offered for an unlisted or public ديوان and NOT for a
 * private one, because for a private one the link does not work: a non-owner
 * gets the same 404 a wrong code gets. A copy button that hands out a dead link
 * is worse than no button.
 */
function DiwanHead({
  album,
  live,
  onChanged,
  onDeleted,
}: {
  album: AlbumResponse["album"]
  live: number
  onChanged: (album: AlbumResponse["album"]) => void
  onDeleted: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const me = useAuth((s) => s.user)
  const keep = useAlbums((s) => s.keep)
  const busy = useAlbums((s) => s.busy)

  /* `shareOrigin()`, not `location.origin`: inside the APK the WebView serves
     from `https://localhost`, so a link built on it left the phone dead. */
  const shareUrl = `${shareOrigin()}${routeHash({ view: "diwan", code: album.code })}`

  /**
   * «شارِكه» — the ديوان as a BLOCK of text, not a bare URL.
   *
   * A link alone says nothing in a chat window; «ديوان «X» — جَمَعه فلان، كذا
   * بيتًا» says what is behind it. The delivery is بيت اليوم's: the native shell
   * opens the OS sheet, the web copies (`client/platform/share.ts`).
   */
  const shareBlock = () => {
    const text = albumShareText({
      title: album.title,
      curator: album.curator.displayName,
      count: album.count,
      url: shareUrl,
    })
    void nativeShareText(text).then((shared) => {
      if (shared) return
      void writeClipboard(text).then((ok) => toast(ok ? "نُسخ نصّ الديوان" : "تعذّر النسخ", ok ? "ok" : "danger"))
    })
  }

  return (
    <header className="view__head diwan-head">
      <PanelCorners size={16} />
      <div className="diwan-head__mark" aria-hidden="true">
        <Shamsa size={16} />
      </div>

      <h1 className="diwan-head__title">
        <bdi>{album.title}</bdi>
      </h1>

      <p className="diwan-head__by">
        جَمَعه{" "}
        <a className="diwan-head__curator" href={routeHash({ view: "profile", username: album.curator.username })}>
          <bdi>{album.curator.displayName}</bdi>
        </a>
      </p>

      {album.description ? <p className="view__lede diwan-head__desc">{album.description}</p> : null}

      <Rule className="diwan-head__rule" />

      <p className="diwan-head__meta">
        <span className="diwan-head__n">{formatBaits(album.count)}</span>
        {/* The number of أبيات the artefact can still show is only worth saying
            when it differs — otherwise it is a statistic about nothing.
            The نعت agrees through `shared/format.ts` and is not welded on: at
            one and at two the badge read «بيت واحد ليست» and «بيتان ليست», the
            exact disagreement العدد والمعدود live in that module to prevent. */}
        {live < album.count ? (
          <span className="diwan-missing">{formatMissingBaits(album.count - live)} من الديوان اليوم</span>
        ) : null}
        {album.isOwner ? <VisibilityBadge album={album} /> : null}
        <span className="diwan-head__when">آخر تغيير: {arabicDate(album.updatedAt)}</span>
      </p>

      <div className="diwan-head__acts">
        {/* A VISITOR's first act leads, because it is the reason he is here: the
            «أضِفه إلى مكتبتك» is the one filled button and it sits at the
            inline start of the row, before the two that only move the link
            around. On the owner's own shelf the leading act is the link, and
            «حرّر» / «احذفه» close the row — the destructive one last. */}
        {!album.isOwner ? (
          <>
            {/* Offered to a signed-out reader too: pressing it opens the دخول
                dialog with its reason on it, which is the app's one auth door
                (albumsStore's `keep`). */}
            <button
              type="button"
              className={album.saved ? "btn btn--ghost" : "btn btn--primary"}
              onClick={() => void keep(album.code, !album.saved).then((now) => onChanged({ ...album, saved: now }))}
              disabled={busy}
            >
              {album.saved ? "أخرِجه من مكتبتك" : "أضِفه إلى مكتبتك"}
            </button>
          </>
        ) : null}
        {album.visibility !== "private" ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              void writeClipboard(shareUrl).then((ok) =>
                toast(ok ? "نُسخ رابط الديوان" : "تعذّر النسخ", ok ? "ok" : "danger"),
              )
            }}
          >
            انسخ الرابط
          </button>
        ) : null}
        {album.visibility !== "private" ? (
          <button type="button" className="btn btn--ghost" onClick={shareBlock}>
            شارِكه
          </button>
        ) : null}
        {album.isOwner ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setEditing(true)}>
              حرّر الديوان
            </button>
            <button type="button" className="btn btn--ghost diwan-head__danger" onClick={() => setConfirming(true)}>
              احذفه
            </button>
          </>
        ) : me ? (
          <AlbumReportAction code={album.code} title={album.title} curator={album.curator.displayName} />
        ) : null}
      </div>

      {editing ? (
        <DiwanEditSheet
          album={album}
          onClose={() => setEditing(false)}
          onSaved={(fresh) => {
            onChanged(fresh)
            setEditing(false)
          }}
        />
      ) : null}

      {confirming ? (
        <DiwanDeleteSheet
          title={album.title}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            try {
              await deleteAlbum(album.code)
              onDeleted()
            } catch (e) {
              toast(albumMessage(e), "danger")
              setConfirming(false)
            }
          }}
        />
      ) : null}
    </header>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// One row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two acts that belong to a قصيدة and not to a بيت.
 *
 * They are a sheet and not two more icons on the row's rail for one reason:
 * on a phone there is no hover, so an unlabelled glyph is a control nobody can
 * read. «أزِل القصيدة كلها» in particular removes as many أبيات as the shelf
 * holds of it, and a reader is owed that number BEFORE he presses, not in the
 * toast afterwards.
 */
function PoemActsSheet({
  entry,
  held,
  busy,
  onClose,
  onRestore,
  onRemove,
}: {
  entry: AlbumEntry
  held: number
  busy: boolean
  onClose: () => void
  onRestore: () => void
  onRemove: () => void
}) {
  const poem = entry.bait?.poem
  const title = poem?.title?.trim()
  const name = title && title !== "بلا عنوان" ? title : entry.snapshot.sadr

  return (
    <Sheet
      title="القصيدة"
      note={`«${name}» — ${formatBaits(held)} منها في ديوانك`}
      onClose={onClose}
      className="sheet--poem-acts"
    >
      <div className="sheet__acts sheet__acts--stack">
        <button type="button" className="btn" onClick={onRestore} disabled={busy}>
          أعِد القصيدة كاملة
        </button>
        <button type="button" className="btn diwan-head__danger" onClick={onRemove} disabled={busy}>
          أزِل القصيدة كلها من الديوان
        </button>
        {poem ? (
          <a className="btn btn--ghost" href={routeHash({ view: "poem", id: poem.id })}>
            افتح القصيدة
          </a>
        ) : null}
      </div>
    </Sheet>
  )
}

function DiwanRow({
  entry,
  index,
  total,
  owner,
  onMove,
  onRemove,
  onPoemActs,
  busy = false,
}: {
  entry: AlbumEntry
  index: number
  total: number
  owner: boolean
  onMove: (to: number) => void | Promise<void>
  onRemove: () => void | Promise<void>
  /** undefined when the artefact no longer holds this بيت's قصيدة */
  onPoemActs?: (() => void) | undefined
  busy?: boolean
}) {
  const settings = useSettings()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)
  const bait = entry.bait

  const rail = owner ? (
    <span className="diwan-row__rail">
      <button
        type="button"
        className="diwan-move"
        onClick={() => void onMove(index - 1)}
        disabled={index === 0}
        aria-label={`ارفع البيت ${index + 1}`}
        title="ارفعه"
      >
        ↑
      </button>
      <button
        type="button"
        className="diwan-move"
        onClick={() => void onMove(index + 1)}
        disabled={index === total - 1}
        aria-label={`أنزِل البيت ${index + 1}`}
        title="أنزِله"
      >
        ↓
      </button>
      <button
        type="button"
        className="diwan-move diwan-move--drop"
        onClick={() => void onRemove()}
        aria-label={`أزِل البيت ${index + 1} من الديوان`}
        title="أزِله"
      >
        ✕
      </button>
      {/* The قصيدة-level acts — restoring it whole, removing it whole — open a
          SHEET rather than adding two more glyphs to this rail. A ديوان is
          compiled a قصيدة at a time, so it is pruned one at a time, and both
          acts are far too consequential to hide behind an unlabelled icon on a
          phone, where there is no hover to put a tooltip in. */}
      {onPoemActs ? (
        <button
          type="button"
          className="diwan-move diwan-move--more"
          onClick={onPoemActs}
          disabled={busy}
          aria-label={`أفعال قصيدة البيت ${index + 1}`}
          title="أفعال القصيدة"
        >
          {busy ? "…" : "⋯"}
        </button>
      ) : null}
    </span>
  ) : null

  // The بيت the artefact no longer holds. It is still a بيت — set in the verse
  // face, in its curator's order — and only its rail and its links are gone,
  // because there is nothing behind them to reach.
  /**
   * The rows RISE in sequence, `.anth-ode`'s stagger and its exact ceiling.
   *
   * المختارات المنظومة is the other shelf of أبيات in this app and its rows
   * come in one after another; a ديوان the reader compiled himself appeared all
   * at once, which read as a list rendering rather than as a shelf being
   * opened. Eight steps is motion.css's cap, and the key is `entry.hFull`, so a
   * reorder re-seats the rows without re-running any of it.
   */
  const enter = { "--enter-i": Math.min(index, 7) } as CSSProperties

  if (!bait) {
    return (
      <li className="diwan-row diwan-row--absent" data-enter style={enter}>
        <div className="diwan-row__body">
          <BaytPlate
            variant="row"
            size="md"
            number={index + 1}
            sadr={entry.snapshot.sadr}
            ajuz={entry.snapshot.ajuz}
            tashkeel={settings.tashkeel}
          />
          <p className="diwan-row__meta">
            <bdi>{entry.snapshot.poet}</bdi>
            <span className="diwan-missing">ليس في الديوان اليوم</span>
            {rail}
          </p>
        </div>
      </li>
    )
  }

  const saved = favorites.some((f) => f.baytKey === bait.baytKey)

  return (
    <li className="diwan-row" data-enter style={enter}>
      <div className="diwan-row__body">
        <BaytPlate
          variant="row"
          size="md"
          /* The curator's order, in the margin `BaytPlate` already reserves for
             a number. It is the position in THIS ديوان, not in the قصيدة —
             which is the number a shelf is read by. */
          number={index + 1}
          sadr={bait.sadr}
          ajuz={bait.ajuz}
          rawiyy={bait.rawiyy}
          showRawiyy={settings.showRawiyy}
          tashkeel={settings.tashkeel}
          label={`بيت ${bait.poet.name}`}
          favorite={saved}
          onAlbum={albumAction(bait)}
          onFavorite={() => {
            const now = toggleFavorite({
              baytKey: bait.baytKey,
              baitId: bait.id,
              sadr: bait.sadr,
              ajuz: bait.ajuz,
              poemId: bait.poem.id,
              poemTitle: bait.poem.title,
              poet: bait.poet,
              meter: bait.meter,
            })
            toast(now ? "أُضيف إلى المختارات" : "أُزيل من المختارات", now ? "ok" : "info")
          }}
          onCard={() => openShareCard({ sadr: bait.sadr, ajuz: bait.ajuz, poet: bait.poet.name })}
          onCopy={() => {
            void writeClipboard(formatBaytWithPoet(bait.sadr, bait.ajuz, bait.poet.name, null)).then((ok) =>
              toast(ok ? "نُسخ البيت" : "تعذّر النسخ", ok ? "ok" : "danger"),
            )
          }}
          copyText={formatBayt(bait.sadr, bait.ajuz)}
          duelHref={routeHash({ view: "duel" })}
        />
        <p className="diwan-row__meta">
          <a className="diwan-row__poet" href={routeHash({ view: "poet", slug: bait.poet.slug })}>
            <bdi>{bait.poet.name}</bdi>
          </a>
          {bait.meter ? <Chip variant="bahr" slug={bait.meter.slug} label={bait.meter.name} /> : null}
          <a className="diwan-row__go" href={routeHash({ view: "poem", id: bait.poem.id, bayt: bait.position })}>
            القصيدة ←
          </a>
          {rail}
        </p>
      </div>
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The owner's two sheets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rename · describe · publish, in one surface, because they are one decision
 * about what this shelf is. `AlbumModal` picks the shell — a bottom sheet on a
 * phone, a dialog on the desktop — so this component holds the form and nothing
 * about where it is standing.
 */
function DiwanEditSheet({
  album,
  onClose,
  onSaved,
}: {
  album: AlbumResponse["album"]
  onClose: () => void
  onSaved: (album: AlbumResponse["album"]) => void
}) {
  const [title, setTitle] = useState(album.title)
  const [description, setDescription] = useState(album.description ?? "")
  const [visibility, setVisibility] = useState<AlbumVisibility>(album.visibility)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Publishing is a SECOND press, and it is the one edit that says something to
   * other people.
   *
   * «مفتوح» does not merely open the link — it puts the ديوان on `#/u/<name>`
   * under the reader's own name, which is a thing he should do on purpose and
   * not by grazing a radio button on the way to renaming a shelf. So the save
   * turns into a confirmation that says exactly that, in this same surface: a
   * second modal stacked on a bottom sheet is a phone with two scrims.
   */
  const publishing = visibility === "public" && album.visibility !== "public"
  const [confirming, setConfirming] = useState(false)

  const save = async () => {
    if (busy) return
    if (publishing && !confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await patchAlbum(album.code, { title: title.trim(), description, visibility })
      onSaved(res.album)
    } catch (e) {
      setError(albumMessage(e))
      setBusy(false)
      setConfirming(false)
    }
  }

  if (confirming) {
    return (
      <AlbumModal
        title={`انشر «${title.trim() || album.title}»؟`}
        note="النشر فعلٌ يُرى."
        onClose={() => setConfirming(false)}
        className="dwmodal--confirm"
        footer={
          <>
            <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
              انشره
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)} disabled={busy}>
              رجوع
            </button>
          </>
        }
      >
        <div className="diwan-edit">
          <p className="diwan-publish">
            سيُعرض هذا الديوان في صفحتك لكلّ من يزورها، ويفتحه كذلك كلُّ من وصله رابطه. الأبيات التي جمعتَها
            تصير عندئذٍ شيئًا يُقرأ باسمك.
          </p>
          <p className="diwan-publish diwan-publish--quiet">
            ولك أن تُعيده إلى نفسك متى شئت من هذا الباب نفسه؛ فإن أعدتَه، خرج من صفحتك ومن مكتبة من حفظه.
          </p>
          {error ? (
            <p className="diwan-edit__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </AlbumModal>
    )
  }

  return (
    <AlbumModal
      title="حرّر الديوان"
      note="الاسم يُقرأ في رأس الصفحة، والوصف تحته، ومن يراه يُقرّره السطر الأخير."
      onClose={onClose}
      className="dwmodal--edit"
      footer={
        <>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy || !title.trim()}>
            {publishing ? "احفظ وانشره" : "احفظ"}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            دعْه كما هو
          </button>
        </>
      }
    >
      <div className="diwan-edit">
        <label className="diwan-edit__label" htmlFor="diwan-title">
          الاسم
        </label>
        <input
          id="diwan-title"
          className="dwfield"
          type="text"
          value={title}
          maxLength={60}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label className="diwan-edit__label" htmlFor="diwan-desc">
          الوصف
        </label>
        <textarea
          id="diwan-desc"
          className="dwfield diwan-edit__area"
          value={description}
          maxLength={280}
          rows={3}
          placeholder="سطرٌ يقول لِمَ جمعتَ هذه الأبيات"
          onChange={(e) => setDescription(e.target.value)}
        />

        <fieldset className="diwan-edit__vis">
          <legend className="diwan-edit__label">من يراه</legend>
          {VISIBILITY_ORDER.map((v) => (
            <label className="diwan-edit__opt" key={v}>
              <input
                type="radio"
                name="diwan-visibility"
                value={v}
                checked={visibility === v}
                onChange={() => setVisibility(v)}
              />
              <span className="diwan-edit__optname">{VISIBILITY[v].label}</span>
              <span className="diwan-edit__optnote">{VISIBILITY[v].note}</span>
            </label>
          ))}
        </fieldset>

        <p className="diwan-edit__cap">
          يسع الديوان {formatBaits(ALBUM_LIMITS.baits)}؛ فيه الآن {formatBaits(album.count)}.
        </p>

        {error ? (
          <p className="diwan-edit__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </AlbumModal>
  )
}

/** Deleting a ديوان takes its أبيات with it, and the sheet says exactly that. */
function DiwanDeleteSheet({
  title,
  onClose,
  onConfirm,
}: {
  title: string
  onClose: () => void
  onConfirm: () => void | Promise<void>
}) {
  return (
    <AlbumModal
      title={`احذف «${title}»؟`}
      note="يذهب الديوان وما فيه من ترتيب. الأبيات نفسها باقية في الديوان الأكبر، ولا تُمسّ."
      onClose={onClose}
      className="dwmodal--confirm"
      footer={
        <>
          <button type="button" className="btn btn--danger" onClick={() => void onConfirm()}>
            احذفه
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            أبقِه
          </button>
        </>
      }
    />
  )
}
