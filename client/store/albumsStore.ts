/**
 * الدواوين — YOUR shelves, and the picker that puts a بيت on one.
 *
 * Like `authStore`, this is deliberately NOT persisted. A ديوان lives on the
 * server (it has a code, a visibility and a curator, and it outlives this
 * browser), so a copy in localStorage would be a second source of truth that
 * survives a sign-out, an account deletion and every edit made in another tab.
 * `useCollections` — the ♥ and the local مجموعات — is the offline shape and it
 * stays exactly what it is; a ديوان is the shareable one.
 *
 * The store holds four things: the list, the مكتبة (the shelves other readers
 * compiled and this one kept — the same `/mine` payload carries both), the
 * picker's open بيت, and a `busy`/`error` pair the picker renders. Everything
 * else is a request.
 */
import { create } from "zustand"

import { ApiError } from "../api/client.ts"
import {
  addAlbumBaits as addBaitsRequest,
  createAlbum as createRequest,
  getMyAlbums,
  saveAlbum as saveRequest,
  unsaveAlbum as unsaveRequest,
} from "../api/queries.ts"
import { HARF_FORMS, countedNoun, formatAlbums, formatBaits } from "../../shared/format.ts"
import { ALBUM_LIMITS, type AlbumSummary, type AlbumVisibility, type SavedAlbum } from "../../shared/schema.ts"
import { tookSessionExpiry, useAuth } from "./authStore.ts"
import { toast } from "./toastStore.ts"

/**
 * What the picker was opened on: the anchors to add, and enough words to say
 * what is being added («أُضيف بيتُ المتنبي», «أُضيفت 12 بيتًا»).
 *
 * It is a LIST because one gesture adds one بيت and another adds a whole
 * قصيدة, and there is no reason for those to be two dialogs — the sheet says
 * how many it is carrying and the rest is identical.
 */
export type AlbumPick = {
  anchors: string[]
  /** what the sheet calls what is being added */
  label: string
}

/**
 * Every number in this map comes out of `shared/format.ts` and out of
 * `ALBUM_LIMITS`, never out of a sentence.
 *
 * Both halves are load-bearing. «(300 بيتًا)» and «(100 ديوانًا)» happen to be
 * right at 300 and 100 and would read «(3 بيتًا)» / «(2 ديوانًا)» the day a cap
 * moved, which is exactly the glued-noun defect `countedNoun` exists to
 * prevent. And the family has to be one register: «ستين حرفًا» spelled out sat
 * one line under «(50)» and «(300 بيتًا)» in digits, in the same map, on the
 * same screen.
 */
const ALBUM_ERROR: Record<string, string> = {
  too_many_albums: `بلغتَ أقصى عدد من الدواوين (${formatAlbums(ALBUM_LIMITS.perUser)})`,
  album_full: `امتلأ هذا الديوان (${formatBaits(ALBUM_LIMITS.baits)})`,
  unknown_baits: "لم أجد هذه الأبيات في الديوان",
  album_not_found: "لا ديوان بهذا الرمز",
  albums_unavailable: "الدواوين غير متاحة على هذا الخادم",
  bad_body: `راجع ما كتبته: للديوان اسمٌ لا يزيد على ${countedNoun(ALBUM_LIMITS.titleChars, HARF_FORMS)}`,
  cannot_save_own: "هذا ديوانك، وهو في دواوينك أصلًا",
  too_many_saved: `امتلأت مكتبتك (${formatAlbums(ALBUM_LIMITS.saved)})`,
}

export function albumMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const byCode = err.code ? ALBUM_ERROR[err.code] : undefined
    return byCode ?? err.message
  }
  return "تعذّر تنفيذ الطلب"
}

type AlbumsStore = {
  albums: AlbumSummary[]
  /** دواوين OTHER readers compiled and this one keeps — «من مكتبتك» */
  saved: SavedAlbum[]
  /** "unknown" until the first load answers — the picker shows a skeleton */
  status: "unknown" | "loading" | "ready" | "error"
  /** the بيت (or قصيدة) the picker is open on, or null when it is closed */
  pick: AlbumPick | null
  busy: boolean
  error: string | null

  /** Re-read the list. Cheap: at most 50 rows out of one indexed scan. */
  reload: () => Promise<void>
  open: (pick: AlbumPick) => void
  close: () => void
  /** «ديوانٌ جديد» from inside the picker; returns the new code, or null. */
  create: (title: string, visibility?: AlbumVisibility) => Promise<string | null>
  /** Put the open pick on one shelf. Returns whether anything landed. */
  addTo: (code: string) => Promise<boolean>
  /** A view that edited a shelf hands the fresh summary back to the list. */
  merge: (album: AlbumSummary) => void
  /** …and one that deleted it takes it out. */
  forget: (code: string) => void
  /**
   * «أضِف إلى مكتبتك» / «أخرِجه من مكتبتك». Returns the shelf's new state so a
   * page that is showing it can flip its own copy without a re-read.
   */
  keep: (code: string, on: boolean) => Promise<boolean>
}

export const useAlbums = create<AlbumsStore>()((set, get) => ({
  albums: [],
  saved: [],
  status: "unknown",
  pick: null,
  busy: false,
  error: null,

  reload: async () => {
    set({ status: "loading" })
    try {
      const res = await getMyAlbums()
      set({ albums: res.albums, saved: res.saved, status: "ready", error: null })
    } catch (err) {
      // A signed-out reader has no دواوين and that is not an error state — the
      // picker's own auth door handles it, and the list is simply empty.
      if (err instanceof ApiError && err.status === 401) {
        set({ albums: [], saved: [], status: "ready" })
        return
      }
      set({ status: "error", error: albumMessage(err) })
    }
  },

  /**
   * Open the picker — and take the AUTH DOOR when there is nobody to open it
   * for.
   *
   * The existing pattern, and it does all three things at once: the دخول dialog
   * comes up with its reason on it, the caller prints no error of its own, and
   * the app bar never claims a session the API has refused. A picker that
   * opened onto «ادخل أولًا» would be a dialog whose only content is a
   * complaint.
   */
  open: (pick) => {
    if (!useAuth.getState().user) {
      useAuth.getState().openDialog("login")
      return
    }
    set({ pick, error: null, busy: false })
    void get().reload()
  },

  close: () => set({ pick: null, error: null, busy: false }),

  create: async (title, visibility = "private") => {
    if (get().busy) return null
    set({ busy: true, error: null })
    try {
      const res = await createRequest({ title, description: null, visibility })
      set((s) => ({ albums: [res.album, ...s.albums], busy: false }))
      return res.album.code
    } catch (err) {
      if (tookSessionExpiry(err)) {
        set({ busy: false, pick: null })
        return null
      }
      set({ busy: false, error: albumMessage(err) })
      return null
    }
  },

  addTo: async (code) => {
    const pick = get().pick
    if (!pick || get().busy) return false
    set({ busy: true, error: null })
    try {
      const res = await addBaitsRequest(code, pick.anchors)
      set((s) => ({
        albums: s.albums.map((a) => (a.code === res.album.code ? res.album : a)),
        busy: false,
        pick: null,
      }))
      toast(addedMessage(res.added, res.duplicates, res.album.title), res.added > 0 ? "ok" : "info")
      return res.added > 0
    } catch (err) {
      if (tookSessionExpiry(err)) {
        set({ busy: false, pick: null })
        return false
      }
      set({ busy: false, error: albumMessage(err) })
      return false
    }
  },

  merge: (album) =>
    set((s) => ({
      albums: s.albums.some((a) => a.code === album.code)
        ? s.albums.map((a) => (a.code === album.code ? album : a))
        : [album, ...s.albums],
    })),

  forget: (code) =>
    set((s) => ({
      albums: s.albums.filter((a) => a.code !== code),
      saved: s.saved.filter((r) => r.code !== code),
    })),

  /**
   * Keep a shelf, or let it go.
   *
   * The list is patched from the RESPONSE, never from an optimistic guess: the
   * server is the one that knows whether the row landed (a full مكتبة, a shelf
   * that went private between the page load and the press), and «أُضيف» over a
   * refusal is the one lie a reader catches immediately.
   */
  keep: async (code, on) => {
    // Same auth door the picker takes: the دخول dialog with its reason on it,
    // rather than a toast complaining about a session the reader never had.
    if (!useAuth.getState().user) {
      useAuth.getState().openDialog("login")
      return false
    }
    if (get().busy) return !on
    set({ busy: true, error: null })
    try {
      const res = on ? await saveRequest(code) : await unsaveRequest(code)
      set((s) => ({
        busy: false,
        saved: res.saved
          ? [
              ...(res.album ? [{ code, savedAt: Date.now(), album: res.album, gated: null }] : []),
              ...s.saved.filter((r) => r.code !== code),
            ]
          : s.saved.filter((r) => r.code !== code),
      }))
      toast(res.saved ? "أُضيف إلى مكتبتك" : "أُخرِج من مكتبتك", res.saved ? "ok" : "info")
      return res.saved
    } catch (err) {
      if (tookSessionExpiry(err)) {
        set({ busy: false })
        return !on
      }
      const message = albumMessage(err)
      set({ busy: false, error: message })
      toast(message, "danger")
      return !on
    }
  },
}))

/**
 * What the toast says, and it says the honest thing in all three cases.
 *
 * «أُضيف» over a duplicate is a lie a reader catches immediately (the count on
 * the card did not move), and a bare «تمّ» after adding a 40-بيت قصيدة to a
 * shelf that already held it says nothing at all. The counted noun is
 * `shared/format.ts`'s, never glued here.
 */
export function addedMessage(added: number, duplicates: number, title: string): string {
  if (added === 0 && duplicates > 0) return `هذه الأبيات في «${title}» أصلًا`
  if (added === 0) return `لم يُضف شيء إلى «${title}»`
  return `أُضيف إلى «${title}»: ${formatBaits(added)}`
}
