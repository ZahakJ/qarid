/**
 * The own-profile avatar control (owner's request — profile pictures).
 *
 * THE PICTURE IS THE BUTTON (owner's second request): the hero disc itself is
 * the affordance, wearing a small camera badge where the decorative نيب sits on
 * everyone else's page. Tapping it opens the file picker straight away when
 * there is no picture; when there is one, it opens a two-action chooser —
 * «غيّر» / «أزِل» — as a bottom sheet on the phone and a small dialog on the
 * desktop. There is no separate «أضِف صورة» button anywhere.
 *
 * Pick a file, place it inside a circular frame (drag to move, a slider to
 * zoom), and the browser does the rest: it CENTER-CROPS to a square and RESIZES
 * to 256×256 on a `<canvas>`, then exports a WEBP (PNG fallback) that is a few
 * KB — well under the server's 256 KB cap. The server never processes an image;
 * it validates the bytes by magic number and stores them. `accept` names the
 * three raster types so the Android WebView's file picker offers only images.
 *
 * Everything is client-side until «احفظ»: the file never leaves the browser
 * until it is the small, square, sanitised thing the account will actually
 * show. On success the new versioned URL is lifted to the caller, which updates
 * both the profile page and the masthead in one go.
 */
import { useEffect, useRef, useState } from "react"

import { ApiError } from "../api/client.ts"
import { removeAvatar, uploadAvatar } from "../api/queries.ts"
import { MAX_AVATAR_BYTES } from "../../shared/schema.ts"
import { useNativeChrome } from "../hooks/useNativeChrome.ts"
import { toast } from "../store/toastStore.ts"
import { Avatar } from "./Avatar.tsx"
import { Sheet } from "./Sheet.tsx"
import { tookSessionExpiry } from "../store/authStore.ts"

/** The exported square, in device pixels. A 256² webp is a handful of KB. */
const EXPORT_SIZE = 256
/** The on-screen crop frame, in CSS px. */
const STAGE = 232

type Editing = { file: File; bitmap: ImageBitmap; baseScale: number }

export function AvatarControl({
  name,
  avatar,
  onChanged,
}: {
  /** the display name — the fallback initial when there is no picture */
  name: string
  avatar: string | null
  onChanged: (avatar: string | null) => void
}) {
  const native = useNativeChrome()
  const fileRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Crop transform: a zoom multiplier over the cover-fit base, and a drag
  // offset in stage px. Reset whenever a new file is loaded.
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)

  // The one bitmap we hold open is closed when the editor closes or unmounts.
  useEffect(() => {
    return () => editing?.bitmap.close?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const pick = () => {
    setError(null)
    fileRef.current?.click()
  }

  /** The disc itself: no picture → straight to the picker; a picture → the chooser. */
  const onDisc = () => {
    if (busy) return
    if (avatar === null) pick()
    else setChoosing(true)
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Let the same file be chosen again after a cancel.
    e.target.value = ""
    if (!file) return
    setError(null)
    try {
      const bitmap = await createImageBitmap(file)
      const baseScale = STAGE / Math.min(bitmap.width, bitmap.height)
      setZoom(1)
      setOffset({ x: 0, y: 0 })
      setEditing({ file, bitmap, baseScale })
    } catch {
      // A toast, not an inline line: the trigger is the hero disc now, and an
      // error paragraph appearing beside it would shove the whole hero around.
      toast("تعذّر فتح هذه الصورة — جرّب صورة أخرى.", "warn")
    }
  }

  // The displayed image size and the clamp that keeps it covering the frame.
  const metrics = (() => {
    if (!editing) return null
    const s = editing.baseScale * zoom
    const dispW = editing.bitmap.width * s
    const dispH = editing.bitmap.height * s
    const maxX = Math.max(0, (dispW - STAGE) / 2)
    const maxY = Math.max(0, (dispH - STAGE) / 2)
    return { s, dispW, dispH, maxX, maxY }
  })()

  const clampOffset = (x: number, y: number) => {
    if (!metrics) return { x: 0, y: 0 }
    return {
      x: Math.max(-metrics.maxX, Math.min(metrics.maxX, x)),
      y: Math.max(-metrics.maxY, Math.min(metrics.maxY, y)),
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const next = clampOffset(drag.current.ox + (e.clientX - drag.current.px), drag.current.oy + (e.clientY - drag.current.py))
    setOffset(next)
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const onZoom = (z: number) => {
    setZoom(z)
    // Re-clamp with the new size on the next tick's metrics; do it eagerly here.
    if (!editing) return
    const s = editing.baseScale * z
    const maxX = Math.max(0, (editing.bitmap.width * s - STAGE) / 2)
    const maxY = Math.max(0, (editing.bitmap.height * s - STAGE) / 2)
    setOffset((o) => ({ x: Math.max(-maxX, Math.min(maxX, o.x)), y: Math.max(-maxY, Math.min(maxY, o.y)) }))
  }

  const cancel = () => {
    setEditing(null)
    setError(null)
  }

  const save = async () => {
    if (!editing || !metrics) return
    setBusy(true)
    setError(null)
    try {
      const blob = await exportCrop(editing.bitmap, metrics.s, offset)
      if (blob.size > MAX_AVATAR_BYTES) {
        // Practically unreachable at 256² — but honest if it ever fires.
        setError("الصورة كبيرة بعد التصغير — جرّب صورة أبسط.")
        setBusy(false)
        return
      }
      const res = await uploadAvatar(blob)
      onChanged(res.avatar)
      setEditing(null)
      toast("حُفظت صورتك", "ok")
    } catch (err) {
      if (tookSessionExpiry(err)) return
      setError(err instanceof ApiError ? err.message : "تعذّر رفع الصورة")
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await removeAvatar()
      onChanged(null)
      toast("أُزيلت صورتك", "ok")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "تعذّر إزالة الصورة", "warn")
    } finally {
      setBusy(false)
    }
  }

  const chooserBody = (
    <div className="avatar-choose">
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => {
          setChoosing(false)
          pick()
        }}
        disabled={busy}
      >
        غيّر الصورة
      </button>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => {
          setChoosing(false)
          void remove()
        }}
        disabled={busy}
      >
        أزِل الصورة
      </button>
    </div>
  )

  return (
    <>
      <button
        type="button"
        className="profile-hero__disc avatar-disc"
        onClick={onDisc}
        disabled={busy}
        aria-label={avatar ? "صورة حسابك — غيّرها أو أزلها" : "أضِف صورة لحسابك"}
        title={avatar ? "غيّر الصورة" : "أضِف صورة"}
      >
        <Avatar name={name} src={avatar} initialClassName="profile-hero__initial" />
        <span className="avatar-disc__edit" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
            <path d="M4.5 8.6a2 2 0 0 1 2-2h1.5l1.3-1.9h5.4l1.3 1.9h1.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z" />
            <circle cx="12" cy="12.4" r="3.2" />
          </svg>
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="avatar-control__file"
        onChange={onFile}
        hidden
      />

      {choosing ? (
        native ? (
          <Sheet title="صورة الحساب" onClose={() => setChoosing(false)}>
            {chooserBody}
          </Sheet>
        ) : (
          <div
            className="avatar-editor-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="صورة الحساب"
            onClick={() => setChoosing(false)}
          >
            <div className="avatar-editor avatar-choose__card" onClick={(e) => e.stopPropagation()}>
              {chooserBody}
              <button type="button" className="btn btn--ghost avatar-choose__back" onClick={() => setChoosing(false)}>
                رجوع
              </button>
            </div>
          </div>
        )
      ) : null}

      {editing ? (
        <div className="avatar-editor-overlay" role="dialog" aria-modal="true" aria-label="اقتطاع الصورة">
          <div className="avatar-editor" role="group">
          <div
            className="avatar-editor__stage"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ inlineSize: STAGE, blockSize: STAGE }}
          >
            {metrics ? (
              <img
                className="avatar-editor__img"
                src={editing.bitmap.width ? bitmapUrl(editing) : ""}
                alt=""
                draggable={false}
                style={{
                  inlineSize: metrics.dispW,
                  blockSize: metrics.dispH,
                  transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
                }}
              />
            ) : null}
            <span className="avatar-editor__ring" aria-hidden="true" />
          </div>

          <label className="avatar-editor__zoom">
            <span className="avatar-editor__zoom-label">تكبير</span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => onZoom(Number(e.target.value))}
              aria-label="تكبير الصورة"
            />
          </label>

          <p className="avatar-editor__hint">اسحب الصورة لتوسيطها.</p>

          {error ? (
            <p className="avatar-control__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="avatar-editor__acts">
            <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
              {busy ? "يُرفع…" : "احفظ الصورة"}
            </button>
            <button type="button" className="btn btn--ghost" onClick={cancel} disabled={busy}>
              رجوع
            </button>
          </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

/**
 * A short-lived object URL for the bitmap being edited. Recreating it per render
 * is fine — an ImageBitmap cannot be an `<img src>` directly, and the frame is
 * open only while editing.
 */
const bitmapUrls = new WeakMap<ImageBitmap, string>()
function bitmapUrl(editing: Editing): string {
  const cached = bitmapUrls.get(editing.bitmap)
  if (cached) return cached
  // Draw the bitmap once to a canvas → blob URL for display. Cheap; the export
  // path draws the actual crop separately at 256².
  const canvas = document.createElement("canvas")
  canvas.width = editing.bitmap.width
  canvas.height = editing.bitmap.height
  canvas.getContext("2d")!.drawImage(editing.bitmap, 0, 0)
  const url = canvas.toDataURL("image/png")
  bitmapUrls.set(editing.bitmap, url)
  return url
}

/**
 * Render the visible crop to a 256×256 canvas and export it. The on-screen
 * transform is inverted to find the source rectangle the circular frame is
 * showing, then that square is drawn into the export canvas.
 */
async function exportCrop(bitmap: ImageBitmap, scale: number, offset: { x: number; y: number }): Promise<Blob> {
  const dispW = bitmap.width * scale
  const dispH = bitmap.height * scale
  const left = (STAGE - dispW) / 2 + offset.x
  const top = (STAGE - dispH) / 2 + offset.y
  const srcX = -left / scale
  const srcY = -top / scale
  const srcSide = STAGE / scale

  const canvas = document.createElement("canvas")
  canvas.width = EXPORT_SIZE
  canvas.height = EXPORT_SIZE
  const ctx = canvas.getContext("2d")!
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(bitmap, srcX, srcY, srcSide, srcSide, 0, 0, EXPORT_SIZE, EXPORT_SIZE)

  const blob = (await canvasToBlob(canvas, "image/webp", 0.9)) ?? (await canvasToBlob(canvas, "image/png"))
  if (!blob) throw new ApiError("network", "تعذّر تجهيز الصورة", "/api/profile/avatar")
  return blob
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality))
}
