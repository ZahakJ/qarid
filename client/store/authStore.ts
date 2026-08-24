/**
 * Who you are (v2.md §4).
 *
 * This is the ONE store in قريض that is not persisted to localStorage, and the
 * reason is worth stating: the session lives in an HttpOnly cookie the browser
 * sends on its own, so the server is the only thing that knows whether it is
 * still valid. A copy of «أنا لبيد» in localStorage would survive a logout on
 * another tab, a deleted account and an expired session, and every one of those
 * shows a signed-in masthead over a signed-out API. `refresh()` on boot is
 * cheap (one point read of a tiny database) and always right.
 *
 * Solo play does NOT move here. `profileStore` / `trainingStore` remain the
 * source of truth for the single-player record; an account is identity plus
 * §5's multiplayer, and the only thing that crosses over is the ترسانة
 * snapshot, and only when the reader presses «زامِن».
 */
import { create } from "zustand"
import { ApiError } from "../api/client.ts"
import { getMe, login as loginRequest, logout as logoutRequest, register as registerRequest } from "../api/queries.ts"
import type { AuthUser } from "../../shared/schema.ts"

export type AuthMode = "login" | "register"

/**
 * Arabic for every machine code these three routes can answer with. The server
 * also sends an Arabic `message` and `client.ts` prefers it — this map is the
 * belt to that braces, and the only place the client decides what a code means.
 */
const AUTH_ERROR: Record<string, string> = {
  username_taken: "هذا الاسم مأخوذ، اختر غيره",
  bad_credentials: "الاسم أو كلمة السر غير صحيحة",
  invite_required: "رمز الدعوة مطلوب أو غير صحيح",
  bad_body: "راجع ما كتبته: الاسم ثلاثة أحرف فأكثر، وكلمة السر ثمانية",
  rate_limited: "حاولتَ مرارًا — أمهِل قليلًا ثم أعد الكرّة",
  auth_unavailable: "الحسابات غير متاحة على هذا الخادم",
  unauthenticated: "انتهت الجلسة، سجّل الدخول من جديد",
  payload_too_large: "الطلب أكبر مما ينبغي",
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const byCode = err.code ? AUTH_ERROR[err.code] : undefined
    // A 429 carries no body of its own on some paths; the status is the tell.
    if (err.status === 429) return AUTH_ERROR.rate_limited!
    return byCode ?? err.message
  }
  return "تعذّر تنفيذ الطلب"
}

type AuthStore = {
  user: AuthUser | null
  /** false when this deployment has no writable users database at all */
  available: boolean
  requiresInvite: boolean
  /** "unknown" until the boot `refresh()` answers — the masthead waits on it */
  status: "unknown" | "ready"
  /** which form the dialog shows, or null when it is closed */
  dialog: AuthMode | null
  busy: boolean
  error: string | null

  refresh: () => Promise<void>
  openDialog: (mode?: AuthMode) => void
  closeDialog: () => void
  setMode: (mode: AuthMode) => void
  register: (fields: { username: string; displayName?: string; password: string; invite?: string }) => Promise<boolean>
  login: (fields: { username: string; password: string }) => Promise<boolean>
  signOut: () => Promise<void>
  /** the dialog's own Arabic validation writes here (see AuthDialog) */
  setError: (message: string | null) => void
  /** the profile page renaming its own account keeps the masthead honest */
  setUser: (user: AuthUser | null) => void
}

export const useAuth = create<AuthStore>()((set, get) => ({
  user: null,
  available: true,
  requiresInvite: false,
  status: "unknown",
  dialog: null,
  busy: false,
  error: null,

  refresh: async () => {
    try {
      const me = await getMe()
      set({ user: me.user, requiresInvite: me.requiresInvite, available: me.available, status: "ready" })
    } catch {
      // A failed «من أنا» is not an error a reader should ever see: the ديوان
      // is readable without an account, so the masthead simply shows the door.
      set({ user: null, status: "ready" })
    }
  },

  openDialog: (mode = "login") => set({ dialog: mode, error: null }),
  closeDialog: () => set({ dialog: null, error: null, busy: false }),
  setMode: (mode) => set({ dialog: mode, error: null }),

  register: async (fields) => {
    if (get().busy) return false
    set({ busy: true, error: null })
    try {
      const res = await registerRequest({
        username: fields.username.trim(),
        password: fields.password,
        ...(fields.displayName?.trim() ? { displayName: fields.displayName.trim() } : {}),
        ...(fields.invite?.trim() ? { invite: fields.invite.trim() } : {}),
      })
      set({ user: res.user, busy: false, dialog: null, error: null })
      return true
    } catch (err) {
      set({ busy: false, error: messageOf(err) })
      return false
    }
  },

  login: async (fields) => {
    if (get().busy) return false
    set({ busy: true, error: null })
    try {
      const res = await loginRequest({ username: fields.username.trim(), password: fields.password })
      set({ user: res.user, busy: false, dialog: null, error: null })
      return true
    } catch (err) {
      set({ busy: false, error: messageOf(err) })
      return false
    }
  },

  signOut: async () => {
    // The cookie is what signs you out; clearing the local user first would
    // leave a signed-out masthead over a live session if the request failed.
    try {
      await logoutRequest()
    } catch {
      /* offline: the cookie survives, and `refresh()` will find it */
    }
    set({ user: null, dialog: null, error: null })
  },

  setError: (message) => set({ error: message }),

  setUser: (user) => set({ user }),
}))

/** The initial letter that goes in the gold نِيب disc. */
export function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed ? [...trimmed][0]! : "؟"
}
