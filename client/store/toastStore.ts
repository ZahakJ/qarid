/**
 * Transient notices ("نُسخ البيت", verify rejections). In memory only — a toast
 * that survives a reload is a bug.
 */
import { create } from "zustand"

export type ToastTone = "info" | "ok" | "warn" | "danger"

export type Toast = {
  id: number
  text: string
  tone: ToastTone
  /** ms; 0 keeps it until dismissed */
  ttl: number
}

let nextId = 1

type ToastStore = {
  toasts: Toast[]
  push: (text: string, tone?: ToastTone, ttl?: number) => number
  dismiss: (id: number) => void
  clear: () => void
}

export const useToasts = create<ToastStore>()((set, get) => ({
  toasts: [],
  push: (text, tone = "info", ttl = 2400) => {
    const id = nextId++
    set({ toasts: [...get().toasts, { id, text, tone, ttl }] })
    if (ttl > 0) setTimeout(() => get().dismiss(id), ttl)
    return id
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  clear: () => set({ toasts: [] }),
}))

/** Imperative helper for non-React callers (copy handlers, api client). */
export function toast(text: string, tone: ToastTone = "info", ttl = 2400): number {
  return useToasts.getState().push(text, tone, ttl)
}
