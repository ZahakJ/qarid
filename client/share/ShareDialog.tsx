/**
 * The بطاقة, before it leaves (design-ux.md §6, §8 v1.5).
 *
 * `renderCard.ts` paints the pixels and is still the ONLY thing that does; this
 * dialog is the place a reader sees them first. That matters for three reasons
 * a silent one-click share cannot serve:
 *
 *   • The card has two shapes — 1200×630 for a link preview, 1080×1080 for a
 *     post — and only the reader knows which one they are about to paste into.
 *   • A card is a picture of someone else's verse with your app's mark on it.
 *     Seeing it before it is shared is the difference between publishing and
 *     posting something you have not read.
 *   • The download has to be a real, deliberate click: `canvas.toBlob` → an
 *     object URL → `<a download>`, fired from a user gesture, is the only path
 *     that survives every browser's popup and gesture heuristics.
 *
 * The dialog is opened imperatively (`openShareCard(bayt)`) from wherever a
 * «بطاقة» action lives — a بيت row's rail, the home hero, a duel exchange — so
 * no view has to own dialog state to have a share button. `<ShareCardHost/>`
 * mounts once, in App.tsx.
 */
import { useEffect, useRef, useState } from "react"
import { create } from "zustand"

import { Rule } from "../components/Ornaments.tsx"
import { Sheet } from "../components/Sheet.tsx"
import { useNativeChrome } from "../hooks/useNativeChrome.ts"
import { toast } from "../store/toastStore.ts"
import { CARD_MESSAGE, fileStem, loadCardFonts, renderCard, shareCard, type CardBayt, type CardShape } from "./renderCard.ts"
import { Overlay } from "../components/Overlay.tsx"

type ShareState = { bayt: CardBayt | null }

const useShare = create<ShareState>()(() => ({ bayt: null }))

/** Open the card dialog on one بيت. The only way in. */
export function openShareCard(bayt: CardBayt): void {
  useShare.setState({ bayt })
}

export function closeShareCard(): void {
  useShare.setState({ bayt: null })
}

const SHAPES: { value: CardShape; label: string; note: string }[] = [
  { value: "wide", label: "عريضة", note: "1200 × 630" },
  { value: "square", label: "مربّعة", note: "1080 × 1080" },
]

export function ShareCardHost() {
  const bayt = useShare((s) => s.bayt)
  if (!bayt) return null
  return <ShareDialog bayt={bayt} onClose={closeShareCard} />
}

export function ShareDialog({ bayt, onClose }: { bayt: CardBayt; onClose: () => void }) {
  const native = useNativeChrome()
  const [shape, setShape] = useState<CardShape>("wide")
  const [busy, setBusy] = useState(false)
  const holder = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // `Sheet` owns Escape and the focus restore on a phone.
  useEffect(() => {
    if (native) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    cardRef.current?.focus()
    return () => window.removeEventListener("keydown", onKey)
  }, [native, onClose])

  // Paint into the dialog itself. The preview IS the artefact — the same
  // canvas the download reads — so what the reader approves and what they
  // receive cannot drift apart.
  useEffect(() => {
    let live = true
    const box = holder.current
    if (!box) return
    void loadCardFonts().then(() => {
      if (!live || !holder.current) return
      const canvas = renderCard(bayt, shape)
      canvas.className = "sharecard__canvas"
      canvas.setAttribute("role", "img")
      canvas.setAttribute("aria-label", `بطاقة البيت: ${bayt.sadr}`)
      holder.current.replaceChildren(canvas)
      canvasRef.current = canvas
    })
    return () => {
      live = false
    }
  }, [bayt, shape])

  /** حفظ — the deliberate download, straight off the previewed canvas. */
  const download = () => {
    const canvas = canvasRef.current
    if (!canvas || busy) return
    setBusy(true)
    canvas.toBlob((blob) => {
      setBusy(false)
      if (!blob) {
        toast(CARD_MESSAGE.failed, "danger")
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${fileStem(bayt)}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      toast(CARD_MESSAGE.downloaded, "ok")
      onClose()
    }, "image/png")
  }

  /** مشاركة — the share sheet, then the clipboard, then a download. */
  const send = () => {
    if (busy) return
    setBusy(true)
    void shareCard(bayt, shape)
      .then((how) => {
        toast(CARD_MESSAGE[how], how === "failed" ? "danger" : "ok")
        if (how !== "failed") onClose()
      })
      .catch(() => toast(CARD_MESSAGE.failed, "danger"))
      .finally(() => setBusy(false))
  }

  const shapes = (
    <div className="segmented" role="group" aria-label="قياس البطاقة">
      {SHAPES.map((s) => (
        <button
          key={s.value}
          type="button"
          className="segmented__opt"
          aria-pressed={s.value === shape}
          onClick={() => setShape(s.value)}
        >
          {s.label}{" "}
          {/* «1200 × 630» would reverse under RTL — `.num` isolates it LTR */}
          <span className="sharecard__dim num">{s.note}</span>
        </button>
      ))}
    </div>
  )

  /* A phone shares a picture through the SHEET, so «مشاركة» is the primary
     action there — `shareCard()` hands it to the OS share sheet — and the
     download is the fallback beneath it. On the desktop, where there is no
     share sheet to hand it to, saving the file is still the primary. */
  if (native) {
    return (
      <Sheet
        title="بطاقة البيت"
        note="اختر قياسها، ثم ابعثها أو احفظها."
        onClose={onClose}
        className="sheet--card"
        footer={
          <div className="sheet__acts">
            <button type="button" className="btn btn--primary" onClick={send} disabled={busy}>
              مشاركة
            </button>
            <button type="button" className="btn" onClick={download} disabled={busy}>
              حفظ صورةً
            </button>
          </div>
        }
      >
        <div className="sharecard__stage" data-shape={shape} ref={holder} />
        {shapes}
      </Sheet>
    )
  }

  return (
    <Overlay role="dialog" aria-modal aria-label="بطاقة البيت" onClick={onClose}>
      <div className="overlay__card sharecard" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <header className="sharecard__head">
          <h2 className="sharecard__title">بطاقة البيت</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </header>
        <Rule />

        <div className="sharecard__stage" data-shape={shape} ref={holder} />

        <div className="sharecard__foot">
          {shapes}
          <div className="sharecard__acts">
            <button type="button" className="btn" onClick={send} disabled={busy}>
              مشاركة
            </button>
            <button type="button" className="btn btn--primary" onClick={download} disabled={busy}>
              حفظ صورةً
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}
