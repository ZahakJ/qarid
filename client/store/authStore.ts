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
import { countedNoun, DAQIQA_FORMS } from "../../shared/format.ts"
import {
  deleteAccount as deleteAccountRequest,
  getMe,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
  resetPassword as resetPasswordRequest,
} from "../api/queries.ts"
import { setToken } from "../platform/native.ts"
import type { AuthUser } from "../../shared/schema.ts"

export type AuthMode = "login" | "register" | "reset"

/**
 * Arabic for every machine code these three routes can answer with. The server
 * also sends an Arabic `message` and `client.ts` prefers it — this map is the
 * belt to that braces, and the only place the client decides what a code means.
 */
const AUTH_ERROR: Record<string, string> = {
  username_taken: "هذا الاسم مأخوذ، اختر غيره",
  bad_credentials: "الاسم أو كلمة السر غير صحيحة",
  bad_recovery: "الاسم أو رمز الاستعادة غير صحيح",
  recovery_locked: "أُغلق باب الاستعادة مؤقتًا بعد محاولات كثيرة — أمهِل قليلًا",
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
    // And it says HOW LONG when the server told us: «أمهِل قليلًا» for three
    // minutes is a guess-and-retry loop, and every retry re-arms the limiter.
    if (err.status === 429) {
      const mins = err.retryAfter === null ? null : Math.ceil(err.retryAfter / 60)
      return mins === null
        ? AUTH_ERROR.rate_limited!
        : `حاولتَ مرارًا — أمهِل ${countedNoun(mins, DAQIQA_FORMS)} ثم أعد الكرّة`
    }
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
  /**
   * The once-shown recovery code, set by a register or a reset and held until
   * the reader dismisses the «save it» panel. It is a secret: it lives here in
   * memory only, is never persisted, and `closeDialog`/`dismissRecovery` clear
   * it. While it is set the dialog shows the save panel instead of any form.
   */
  recoveryCode: string | null

  refresh: () => Promise<void>
  openDialog: (mode?: AuthMode) => void
  closeDialog: () => void
  setMode: (mode: AuthMode) => void
  register: (fields: { username: string; displayName?: string; password: string; invite?: string }) => Promise<boolean>
  login: (fields: { username: string; password: string }) => Promise<boolean>
  /** Reset a forgotten password with the recovery code; shows a NEW code on success. */
  resetPassword: (fields: { username: string; recoveryCode: string; newPassword: string }) => Promise<boolean>
  /** Dismiss the once-shown recovery panel after the reader has saved the code. */
  dismissRecovery: () => void
  signOut: () => Promise<void>
  /**
   * A 401 from an action that was supposed to be signed in.
   *
   * Three things used to go wrong at once, reproduced by clearing the cookie
   * and pressing «افتح الغرفة» in the «غرفة مساجلة» sheet at 390: the sheet
   * showed an inline «ادخل بحسابك أوّلًا» in its SCROLLING body, under the
   * sticky action bar, so on screen the button simply did nothing; the message
   * told the reader to sign in and offered no way to; and the app bar still
   * showed the signed-in avatar, so the app claimed they were logged in and
   * logged out at the same time.
   *
   * So it is one handler and it does all three: drop the stale session (the app
   * bar falls back to «دخول»), and open the دخول dialog with the reason on it.
   * The caller closes its own surface and does not print an error of its own.
   * `/room`, `/profile` and `/auth` all reach it.
   */
  sessionExpired: () => void
  /** IRREVERSIBLY delete the account; the password re-confirms it. Returns
   *  whether the server accepted it, so the caller can leave the dialog open on
   *  a wrong password and navigate home on success. */
  deleteAccount: (password: string) => Promise<{ ok: true } | { ok: false; message: string }>
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
  recoveryCode: null,

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

  openDialog: (mode = "login") => set({ dialog: mode, error: null, recoveryCode: null }),
  closeDialog: () => set({ dialog: null, error: null, busy: false, recoveryCode: null }),
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
      // The native shell gets a bearer back (X-Client asked for it) and keeps
      // it; on the web `res.token` is undefined and `setToken` is a no-op.
      if (res.token) setToken(res.token)
      // The dialog stays OPEN so the recovery code panel can show once — the
      // reader dismisses it (`dismissRecovery`) after saving the code. A server
      // that somehow returned none simply closes, exactly as before.
      set({
        user: res.user,
        busy: false,
        error: null,
        recoveryCode: res.recoveryCode ?? null,
        ...(res.recoveryCode ? {} : { dialog: null }),
      })
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
      if (res.token) setToken(res.token)
      set({ user: res.user, busy: false, dialog: null, error: null })
      return true
    } catch (err) {
      set({ busy: false, error: messageOf(err) })
      return false
    }
  },

  resetPassword: async (fields) => {
    if (get().busy) return false
    set({ busy: true, error: null })
    try {
      const res = await resetPasswordRequest({
        username: fields.username.trim(),
        recoveryCode: fields.recoveryCode.trim(),
        newPassword: fields.newPassword,
      })
      // The reset re-keyed the account, revoked every old session, and issued a
      // fresh code — land signed in and show the new code once, same as register.
      if (res.token) setToken(res.token)
      set({
        user: res.user,
        busy: false,
        error: null,
        recoveryCode: res.recoveryCode ?? null,
        ...(res.recoveryCode ? {} : { dialog: null }),
      })
      return true
    } catch (err) {
      set({ busy: false, error: messageOf(err) })
      return false
    }
  },

  dismissRecovery: () => set({ recoveryCode: null, dialog: null, error: null }),

  sessionExpired: () => {
    setToken(null)
    set({ user: null, dialog: "login", error: "انتهت جلستك — ادخل ثانيةً", recoveryCode: null, busy: false })
  },

  signOut: async () => {
    // The cookie is what signs you out; clearing the local user first would
    // leave a signed-out masthead over a live session if the request failed.
    try {
      await logoutRequest()
    } catch {
      /* offline: the cookie survives, and `refresh()` will find it */
    }
    // Drop the native bearer too — the server revoked this session, and a stale
    // token in Preferences would re-authenticate a signed-out shell on boot.
    setToken(null)
    set({ user: null, dialog: null, error: null })
  },

  deleteAccount: async (password) => {
    try {
      await deleteAccountRequest(password)
    } catch (err) {
      // A wrong password is 401 `bad_credentials`; keep the reader on the
      // confirm dialog with the reason, exactly as login does.
      return { ok: false, message: messageOf(err) }
    }
    // The account and its session are gone server-side; make the client match.
    // Same teardown as signOut, minus the logout call (there is nothing to log
    // out of): drop the native bearer and clear the signed-in state.
    setToken(null)
    set({ user: null, dialog: null, error: null })
    return { ok: true }
  },

  setError: (message) => set({ error: message }),

  setUser: (user) => set({ user }),
}))

/**
 * Did this failure mean «your session is gone»? If so, take it over.
 *
 * Every authed action funnels its catch through here — one handler for /room,
 * /profile and /auth, which is what the audit's finding asked for. A caller
 * that gets `true` back has nothing left to do: the auth slice is cleared (so
 * the app bar stops showing a signed-in avatar over a signed-out session) and
 * the دخول dialog is open with the reason on it, beside its own button. The
 * caller closes its surface and does NOT also print an error.
 *
 * `unauthenticated` is the server's code for «no session», and it is the ONLY
 * 401 this fires on: a wrong password at /auth/login and a wrong password on
 * the delete-account confirm are `bad_credentials`, which belong to the form
 * the reader is standing in.
 */
export function tookSessionExpiry(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 401 || err.code !== "unauthenticated") return false
  useAuth.getState().sessionExpired()
  return true
}

/** The initial letter that goes in the gold نِيب disc. */
export function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed ? [...trimmed][0]! : "؟"
}
