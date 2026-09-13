/**
 * `#/diwan/<CODE>` — one ديوان, the playlist a reader compiled himself.
 *
 * The page has two readers and it is the SAME page for both, with one rail
 * added: a visitor sees a title, a curator and the entries; the owner sees
 * those plus the means to rename, describe, publish, reorder and remove. Two
 * components would have been two layouts to keep in agreement, and the owner
 * is the reader who looks at this page most.
 *
 * AN ENTRY IS A قصيدة OR A بيت, and the page draws them as two different
 * things on one numbered list. A قصيدة is a CARD — its عنوان (or its مطلع
 * standing in for one), its مطلع under that, its شاعر, its بحر and its length,
 * and the whole card opens the قصيدة — because a ديوان is a playlist and a
 * playlist row is the track, not the audio. A بيت is a `BaytPlate` row with
 * the whole rail that works everywhere else (♥, بطاقة, ساجِلني), because the
 * one line that stood out IS the content. The first shape of this page had
 * only the second kind, and «أضِف القصيدة» exploded forty rows into a list
 * with nothing to say where one قصيدة ended and the next began.
 *
 * THE ENTRIES ARE RESOLVED, NOT STORED. Each carries the live قصيدة or بيت when
 * today's artefact still holds it, and its SNAPSHOT when it does not — which
 * renders in a quiet state saying «ليس في الديوان اليوم». The alternative was a
 * shelf that empties itself at the next `npm run ingest`, which is not a shelf.
 *
 * Reordering is up/down BUTTONS and not only a drag. A drag on a phone fights
 * the page's own scroll, a drag with a keyboard does not exist, and the شطران
 * of a بيت make a drag target that is 58rem wide and one line tall. The buttons
 * are the honest affordance; the whole order goes back in one PATCH either way
 * (`AlbumPatchRequestSchema.order` — the WHOLE list, never a move).
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react"

import { deleteAlbum, getAlbum, patchAlbum, removeAlbumEntry } from "../api/queries.ts"
import { BaytPlate } from "../bayt/BaytPlate.tsx"
import { BaytSkeleton } from "../bayt/BaytSkeleton.tsx"
import { formatBayt, formatBaytWithPoet, writeClipboard } from "../bayt/copy.ts"
import { displayText, displayTextOrNull } from "../bayt/tashkeel.ts"
import { Chip } from "../components/Chip.tsx"
import { EmptyState } from "../components/EmptyState.tsx"
import { PanelCorners, Rule, Shamsa } from "../components/Ornaments.tsx"
import { useChromeTitle } from "../components/AppBar.tsx"
import { openShareCard } from "../share/ShareDialog.tsx"
import { useAlbums, albumMessage } from "../store/albumsStore.ts"
import { useCollections } from "../store/collectionsStore.ts"
import { useSettings } from "../store/settingsStore.ts"
import { toast } from "../store/toastStore.ts"
import { navigate, routeHash } from "../router.ts"
import {
  arabicDate,
  formatAlbumContents,
  formatBaits,
  formatMissingBaits,
  formatMissingPoems,
  formatPoems,
} from "../../shared/format.ts"
import {
  ALBUM_LIMITS,
  type AlbumBaitEntry,
  type AlbumEntry,
  type AlbumPoemEntry,
  type AlbumResponse,
  type AlbumVisibility,
} from "../../shared/schema.ts"
import { VISIBILITY, VISIBILITY_ORDER } from "../albums/visibility.ts"
import { AlbumModal } from "../albums/Modal.tsx"
import { albumShareText } from "../albums/share.ts"
import { shareOrigin } from "../platform/native.ts"
import { albumAction, VisibilityBadge } from "../albums/AlbumPicker.tsx"
import { AlbumReportAction } from "../components/Moderation.tsx"
import { DiwanPlay } from "../albums/DiwanPlay.tsx"
import { useAuth } from "../store/authStore.ts"
import { nativeShareText } from "../platform/share.ts"
import { headingOf } from "./shared.tsx"

export function DiwanView({ code }: { code: string }) {
  const [data, setData] = useState<AlbumResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
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

  // The app bar takes the shelf's name once the head has scrolled off, so a
  // reader deep in a long ديوان still knows whose page he is on. The head's
  // own `<h1>` is `.diwan-head__title` and NOT a `.view__title` — the app bar
  // lends nothing until the reader scrolls, and a `.view__title` is `.sr-only`
  // on a phone, so as one the name was on no part of a 390 screen at rest.
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
  const missingPoems = entries.filter((e) => e.kind === "poem" && e.poem === null).length
  const missingBaits = entries.filter((e) => e.kind === "bait" && e.bait === null).length

  /** Move the entry at `from` to `to` — optimistic, then the WHOLE order. */
  const move = async (from: number, to: number) => {
    const order = entries.map((e) => e.anchor)
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved!)
    // Optimistic: the rows re-seat under the thumb, and the request that
    // follows is the WHOLE order, so a failure re-loads into the truth rather
    // than leaving a half-applied move.
    const byAnchor = new Map(entries.map((e) => [e.anchor, e]))
    setData({ ...data, entries: order.map((a, n) => ({ ...byAnchor.get(a)!, position: n })) })
    try {
      const res = await patchAlbum(album.code, { order })
      merge(res.album)
    } catch (e) {
      toast(albumMessage(e), "danger")
      void load()
    }
  }

  const remove = async (entry: AlbumEntry) => {
    try {
      const res = await removeAlbumEntry(album.code, entry.anchor)
      merge(res.album)
      setData({
        ...data,
        album: res.album,
        entries: entries.filter((e) => e.anchor !== entry.anchor).map((e, n) => ({ ...e, position: n })),
      })
      toast(entry.kind === "poem" ? "أُزيلت القصيدة من الديوان" : "أُزيل البيت من الديوان", "info")
    } catch (e) {
      toast(albumMessage(e), "danger")
    }
  }

  return (
    <div className="view diwan-view">
      <DiwanHead
        album={album}
        missingPoems={missingPoems}
        missingBaits={missingBaits}
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

      {entries.length === 0 ? (
        <EmptyState flavor="no-favorites" title="ديوانٌ لم يُوضع فيه شيءٌ بعد">
          <p className="diwan-empty">
            {album.isOwner
              ? "افتح قصيدةً وانقر «أضِف القصيدة إلى ديوان» من رأسها، فتدخل كاملةً مدخلًا واحدًا — أو «أضِف إلى ديوان» تحت بيتٍ بعينه."
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
          {entries.map((entry, i) => {
            const rail = album.isOwner ? (
              <EntryRail
                entry={entry}
                index={i}
                total={entries.length}
                onMove={(to) => void move(i, to)}
                onRemove={() => void remove(entry)}
              />
            ) : null
            return entry.kind === "poem" ? (
              <DiwanPoemEntry key={entry.anchor} entry={entry} index={i} rail={rail} />
            ) : (
              <DiwanBaitEntry key={entry.anchor} entry={entry} index={i} rail={rail} />
            )
          })}
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
  missingPoems,
  missingBaits,
  onChanged,
  onDeleted,
}: {
  album: AlbumResponse["album"]
  /** entries today's artefact can no longer answer, by kind */
  missingPoems: number
  missingBaits: number
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
      poems: album.poems,
      baits: album.baits,
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
        <span className="diwan-head__n">{formatAlbumContents(album.poems, album.baits)}</span>
        {/* What the artefact can no longer show is only worth saying when
            there is some — otherwise it is a statistic about nothing — and it
            is said per kind, because the نعت has to agree with its معدود
            (`shared/format.ts`): at one and at two a shared badge read «بيت
            واحد ليست», the exact disagreement that module exists to prevent. */}
        {missingPoems > 0 ? (
          <span className="diwan-missing">{formatMissingPoems(missingPoems)} من الديوان اليوم</span>
        ) : null}
        {missingBaits > 0 ? (
          <span className="diwan-missing">{formatMissingBaits(missingBaits)} من الديوان اليوم</span>
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
// The entries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The owner's rail: up · down · remove, at the far end of an entry's meta band.
 *
 * Three controls and no more. A قصيدة is ONE entry now, so removing it whole
 * is the same ✕ a بيت gets — the sheet that used to carry «أزِل القصيدة كلها»
 * existed only because a قصيدة was forty rows. The labels name the KIND, so a
 * screen reader hears «أزِل القصيدة 3» and not a bare number.
 */
function EntryRail({
  entry,
  index,
  total,
  onMove,
  onRemove,
}: {
  entry: AlbumEntry
  index: number
  total: number
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const what = entry.kind === "poem" ? "القصيدة" : "البيت"
  return (
    <span className="diwan-row__rail">
      <button
        type="button"
        className="diwan-move"
        onClick={() => onMove(index - 1)}
        disabled={index === 0}
        aria-label={`ارفع ${what} ${index + 1}`}
        title="ارفعه"
      >
        ↑
      </button>
      <button
        type="button"
        className="diwan-move"
        onClick={() => onMove(index + 1)}
        disabled={index === total - 1}
        aria-label={`أنزِل ${what} ${index + 1}`}
        title="أنزِله"
      >
        ↓
      </button>
      <button
        type="button"
        className="diwan-move diwan-move--drop"
        onClick={onRemove}
        aria-label={`أزِل ${what} ${index + 1} من الديوان`}
        title="أزِله"
      >
        ✕
      </button>
    </span>
  )
}

/**
 * The rows RISE in sequence, `.anth-ode`'s stagger and its exact ceiling.
 *
 * المختارات المنظومة is the other shelf in this app and its rows come in one
 * after another; a ديوان the reader compiled himself appeared all at once,
 * which read as a list rendering rather than as a shelf being opened. Eight
 * steps is motion.css's cap, and the key is the anchor, so a reorder re-seats
 * the rows without re-running any of it.
 */
function enterStyle(index: number): CSSProperties {
  return { "--enter-i": Math.min(index, 7) } as CSSProperties
}

/**
 * A قصيدة on the shelf — a card, the playlist's row.
 *
 * The heading is `headingOf`'s: the عنوان when the source gave one, else the
 * مطلع standing in for it, set in the verse face and marked with an ellipsis,
 * exactly as the browse list does it. Under a real عنوان the مطلع is printed
 * once more in the verse face, because the first line is how a reader
 * recognises a قصيدة he knows. The whole card is the link; the meta band
 * carries the شاعر, the بحر and the length, and — for the owner — the rail.
 *
 * A قصيدة the artefact no longer holds keeps its card: عنوان, مطلع, شاعر and
 * length from the snapshot, no link, and the quiet badge.
 */
function DiwanPoemEntry({
  entry,
  index,
  rail,
}: {
  entry: AlbumPoemEntry
  index: number
  rail: ReactNode
}) {
  const settings = useSettings()
  const poem = entry.poem
  const heading = poem
    ? headingOf(poem)
    : headingOf({ title: entry.snapshot.title, previewSadr: entry.snapshot.sadr })
  const sadr = poem ? poem.previewSadr : entry.snapshot.sadr
  const ajuz = poem ? poem.previewAjuz : entry.snapshot.ajuz
  const showMatla = !heading.isMatla && sadr
  const count = poem ? poem.baitCount : entry.snapshot.baitCount

  const inner = (
    <>
      <span className="diwan-poem__num" aria-hidden="true">
        {index + 1}
      </span>
      <span className="diwan-poem__text">
        <span className={heading.isMatla ? "diwan-poem__title diwan-poem__title--matla" : "diwan-poem__title"}>
          <bdi>{heading.isMatla ? displayText(heading.text, settings.tashkeel) : heading.text}</bdi>
        </span>
        {showMatla ? (
          <span className="diwan-poem__matla">
            <bdi>{displayText(sadr, settings.tashkeel)}</bdi>
            {ajuz ? (
              <>
                <span className="diwan-poem__sep" aria-hidden="true" />
                <bdi>{displayTextOrNull(ajuz, settings.tashkeel)}</bdi>
              </>
            ) : null}
          </span>
        ) : null}
      </span>
    </>
  )

  if (!poem) {
    return (
      <li className="diwan-row diwan-poem diwan-row--absent" data-enter style={enterStyle(index)}>
        <div className="diwan-poem__body">{inner}</div>
        <p className="diwan-row__meta">
          <bdi>{entry.snapshot.poet}</bdi>
          <span className="diwan-poem__n">{formatBaits(count)}</span>
          <span className="diwan-missing">ليست في الديوان اليوم</span>
          {rail}
        </p>
      </li>
    )
  }

  return (
    <li className="diwan-row diwan-poem" data-enter style={enterStyle(index)}>
      <a
        className="diwan-poem__body"
        href={routeHash({ view: "poem", id: poem.id })}
        aria-label={`القصيدة ${index + 1}: ${heading.text}`}
      >
        {inner}
      </a>
      <p className="diwan-row__meta">
        <a className="diwan-row__poet" href={routeHash({ view: "poet", slug: poem.poet.slug })}>
          <bdi>{poem.poet.name}</bdi>
        </a>
        {poem.meter ? <Chip variant="bahr" slug={poem.meter.slug} label={poem.meter.name} /> : null}
        <span className="diwan-poem__n">{formatBaits(count)}</span>
        <a className="diwan-row__go" href={routeHash({ view: "poem", id: poem.id })}>
          افتح القصيدة ←
        </a>
        {rail}
      </p>
    </li>
  )
}

/**
 * A single بيت on the shelf — `BaytPlate`, with the whole rail the بيت has
 * everywhere else. The curator's ordinal goes in the margin the component
 * already reserves for a number: it is the position in THIS ديوان, not in the
 * قصيدة, which is the number a shelf is read by.
 *
 * A بيت the artefact no longer holds is still a بيت — set in the verse face, in
 * its curator's order — and only its rail and its links are gone, because there
 * is nothing behind them to reach.
 */
function DiwanBaitEntry({
  entry,
  index,
  rail,
}: {
  entry: AlbumBaitEntry
  index: number
  rail: ReactNode
}) {
  const settings = useSettings()
  const favorites = useCollections((s) => s.favorites)
  const toggleFavorite = useCollections((s) => s.toggle)
  const bait = entry.bait

  if (!bait) {
    return (
      <li className="diwan-row diwan-row--absent" data-enter style={enterStyle(index)}>
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
    <li className="diwan-row" data-enter style={enterStyle(index)}>
      <div className="diwan-row__body">
        <BaytPlate
          variant="row"
          size="md"
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

        {/* Each entry is a قصيدة or a بيت, so the cap is said as either kind
            and never as «مدخلًا», a word no reader uses for a poem. */}
        <p className="diwan-edit__cap">
          يسع الديوان {formatPoems(ALBUM_LIMITS.entries)} أو {formatBaits(ALBUM_LIMITS.entries)} أو ما بينهما؛ فيه
          الآن {formatAlbumContents(album.poems, album.baits)}.
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
      note="يذهب الديوان وما فيه من ترتيب. القصائد والأبيات نفسها باقية في الديوان الأكبر، ولا تُمسّ."
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
