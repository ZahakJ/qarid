/**
 * `/api/profile/*` — the page with your name on it (v2.md §4).
 *
 *   GET  /api/profile/:username   public: name, joined date, duel record, دواوينه
 *   POST /api/profile/update      own display name
 *   POST /api/profile/arsenal     opt-in ترسانة snapshot (≤ 8 KB)
 *
 * The duel numbers are read off `rooms` / `match_turns` — the tables
 * `server/users.ts` creates at migration 1 and §5's multiplayer agent will
 * write. They are real queries over empty tables today, which is why the page
 * says «لا مساجلات بعد» rather than «قريبًا»: the day the first room is played
 * this page is already correct.
 *
 * SOLO play is not here and never will be. `qarid:v1:profile` in the reader's
 * own browser stays the source of truth for the single-player record (v2.md
 * §4); an account exists for multiplayer and identity. The one thing that
 * crosses over is the ترسانة, and only because the reader pressed «زامِن».
 */

import { Hono, type Context } from "hono"

import {
  AccountDeleteRequestSchema,
  ArsenalSchema,
  ArsenalSyncRequestSchema,
  AVATAR_MIME_TYPES,
  MAX_ARSENAL_BYTES,
  MAX_AVATAR_BYTES,
  PROFILE_MATCHES_LIMIT,
  ProfileResponseSchema,
  ProfileUpdateRequestSchema,
  UsernameSchema,
  avatarUrlFor,
  type ProfileResponse,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import { decodeParam, parseParam } from "../query.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import {
  blockExistsBetween,
  deleteAvatar,
  deleteUserAccount,
  detectImageMime,
  duelStats,
  findUserByUsername,
  getArsenal,
  getAvatar,
  hasBlocked,
  isAlbumSaved,
  listPublicAlbums,
  putAvatar,
  putArsenal,
  recentMatches,
  setDisplayName,
  verifyPassword,
  type UserRow,
  type UsersDb,
} from "../users.ts"
import { summaryOf } from "./albums.ts"
import { authUser, clearSessionCookie, currentUser, parseBody } from "./auth.ts"

/**
 * Told the codes of the rooms an account was still LIVE in when it was deleted,
 * so the wire can push their ending to whoever is watching. `server/app.ts`
 * supplies one that reaches the room hub when both databases are open; on a box
 * with no corpus (and so no room sockets) it is absent and the database-level
 * ending is the whole story.
 */
export type RoomNotifier = (codes: readonly string[]) => void

/** Profile writes are cheap but they are writes: 20 per 10 minutes per IP. */
export const PROFILE_WRITE_LIMIT = { tokens: 20, windowMs: 10 * 60 * 1000 } as const

export function profileRoutes(users: UsersDb | null, config: Config, notifyRooms?: RoomNotifier): Hono {
  const app = new Hono()
  const writeLimiter = createRateLimiter({ ...PROFILE_WRITE_LIMIT, keyOf: clientKey })

  const unavailable = (c: Context) =>
    c.json({ error: "auth_unavailable", message: "الحسابات غير متاحة على هذا الخادم" }, 503)

  /** The whole page payload for one user, from the caller's point of view. */
  const payload = (db: UsersDb, row: UserRow, viewer: UserRow | null): ProfileResponse => {
    const stored = getArsenal(db, row.id)
    // A snapshot written by an older build is DROPPED, not rendered: the
    // schema is the contract, and a half-parsed ترسانة would show wrong counts
    // under someone's name.
    let arsenal: ProfileResponse["arsenal"] = null
    if (stored) {
      const parsed = ArsenalSchema.safeParse(safeJson(stored.snapshot))
      if (parsed.success) arsenal = { letters: parsed.data, updatedAt: stored.updatedAt }
    }
    const isSelf = viewer !== null && viewer.id === row.id
    return ProfileResponseSchema.parse({
      user: authUser(row, db),
      isSelf,
      stats: duelStats(db, row.id),
      // The CODE is a credential, not a fact about the match (see
      // ProfileMatchSchema). `GET /api/profile/:username` needs no cookie, so
      // handing every reader the codes of this account's rooms — the `waiting`
      // ones above all — published the invite to every مساجلة on the site.
      // The record stays public; the door does not.
      recent: recentMatches(db, row.id, PROFILE_MATCHES_LIMIT).map((m) => ({
        ...m,
        code: isSelf ? m.code : null,
      })),
      arsenal,
      // A fact about the VIEWER — has the signed-in reader blocked this account —
      // so the «احظر» button can render as «ألغِ الحظر». Never set on your own
      // page or for a signed-out reader, and it reveals only the viewer's own
      // action (blocking is private; the blocked user is never told).
      youBlocked: viewer !== null && !isSelf ? hasBlocked(db, viewer.id, row.id) : false,
      /**
       * «دواوينه» — the account's PUBLIC shelves.
       *
       * `public` is the only visibility that reaches this list, and that is the
       * publish gesture itself: an `unlisted` ديوان is reachable by its link and
       * printing it here would hand out the capability its owner chose not to
       * publish. The shelves are SUMMARIES — no أبيات — so this stays the
       * corpus-free route it has always been (no resolution, no artefact), and
       * `#/diwan/<CODE>` does the reading.
       *
       * A block in either direction empties it, the way `blockExistsBetween`
       * shuts a room door: a shelf is a person speaking, and the point of a
       * block is not to hear him.
       */
      albums:
        viewer !== null && !isSelf && blockExistsBetween(db, viewer.id, row.id)
          ? []
          : listPublicAlbums(db, row.id).map((a) =>
              summaryOf(a, isSelf, viewer !== null && isAlbumSaved(db, viewer.id, a.id)),
            ),
    })
  }

  app.use("/update", writeLimiter.middleware)
  app.use("/arsenal", writeLimiter.middleware)
  // Deletion re-verifies the password, but it is still a credential-sensitive
  // write and it must not be scriptable in a tight loop: the profile-write
  // bucket (20 / 10 min / IP) is the same one the roadmap points at for these.
  app.use("/delete", writeLimiter.middleware)
  // The avatar WRITES reuse the same profile-write bucket (20 / 10 min / IP).
  // The GET is a read and, like every other profile read, is not bucketed.
  app.use("/avatar", writeLimiter.middleware)

  app.post("/update", async (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return c.json({ error: "unauthenticated", message: "سجّل الدخول أولًا" }, 401)
    const parsed = await parseBody(c, ProfileUpdateRequestSchema)
    if (!parsed.ok) return parsed.res
    setDisplayName(users, me.id, parsed.data.displayName)
    return c.json(payload(users, { ...me, display_name: parsed.data.displayName }, me))
  })

  app.post("/arsenal", async (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return c.json({ error: "unauthenticated", message: "سجّل الدخول أولًا" }, 401)
    const parsed = await parseBody(c, ArsenalSyncRequestSchema)
    if (!parsed.ok) return parsed.res

    // The 8 KB cap of v2.md §4 is measured on what will actually be STORED, not
    // on the request: a body can be pretty-printed and a snapshot cannot. 28
    // letters × two integers is ~1.5 KB, so this only ever catches abuse.
    const snapshot = JSON.stringify(parsed.data.arsenal)
    if (Buffer.byteLength(snapshot, "utf8") > MAX_ARSENAL_BYTES) {
      return c.json({ error: "arsenal_too_large", limit: MAX_ARSENAL_BYTES }, 413)
    }
    const now = Date.now()
    putArsenal(users, me.id, snapshot, now)
    return c.json({ ok: true as const, arsenal: { letters: parsed.data.arsenal, updatedAt: now } })
  })

  /**
   * POST /api/profile/delete — IRREVERSIBLY delete the signed-in account.
   *
   * A hard Google Play requirement for an app with accounts, and reachable both
   * in the native shell (bearer) and on the web (cookie): the settings on your
   * own `#/u/<name>` page is the web deletion URL the listing must point at.
   *
   * The password is re-entered and verified with scrypt + `timingSafeEqual`,
   * the same door login and the password change use — a ridden cookie or a
   * walked-away session cannot erase the account, only its owner can. Then
   * `deleteUserAccount` settles every live room, drops every session and every
   * byte the account owns, and anonymizes the shared match history it does not
   * (server/users.ts). The session that made this request is among the ones the
   * cascade kills; the cookie is cleared here so the browser stops sending a
   * name that no longer exists.
   */
  app.post("/delete", async (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return c.json({ error: "unauthenticated", message: "سجّل الدخول أولًا" }, 401)
    const parsed = await parseBody(c, AccountDeleteRequestSchema)
    if (!parsed.ok) return parsed.res

    if (!(await verifyPassword(parsed.data.password, me.pass_hash))) {
      return c.json({ error: "bad_credentials", message: "كلمة السر غير صحيحة" }, 401)
    }

    const { endedRoomCodes } = deleteUserAccount(users, me.id, Date.now())
    // Tell anyone still watching a room he was playing in that it is over. The
    // rooms he hosted are already gone with him and are skipped inside.
    if (notifyRooms && endedRoomCodes.length > 0) notifyRooms(endedRoomCodes)
    // The request's own session was cascade-deleted; stop the cookie riding.
    clearSessionCookie(c, config)
    return c.json({ ok: true as const })
  })

  /**
   * POST /api/profile/avatar — set YOUR OWN avatar (owner only).
   *
   * `currentUser` is the whole authorization: a user can only ever write the
   * row keyed by their own id, there is no `:username` to target someone else's.
   * The bytes are read off the STREAM with a hard 256 KB cap (a `Content-Length`
   * is a claim), the declared type is narrowed to the raster image types — the
   * one lock that keeps a no-preflight cross-origin `text/plain` POST out, on
   * top of the CSRF originGuard — and then the MAGIC BYTES decide the truth: an
   * SVG or a renamed HTML page is 415, never stored, never served.
   */
  app.post("/avatar", async (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return c.json({ error: "unauthenticated", message: "سجّل الدخول أولًا" }, 401)

    // The declared content-type must be one this route accepts. None of these is
    // a CORS "simple" type, so a cross-origin page cannot send one without a
    // preflight the server only answers for the Capacitor allowlist — the same
    // second lock `application/json` is on the auth routes.
    const declaredType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
    const ACCEPTED_UPLOAD_TYPES = new Set<string>([...AVATAR_MIME_TYPES, "application/octet-stream"])
    if (!ACCEPTED_UPLOAD_TYPES.has(declaredType)) {
      return c.json({ error: "unsupported_media_type", message: "لا تُقبل إلا صورة من نوع PNG أو JPEG أو WEBP" }, 415)
    }

    const body = await readBinaryBody(c, MAX_AVATAR_BYTES)
    if (!body.ok) return body.res
    if (body.bytes.length === 0) {
      return c.json({ error: "empty_body", message: "لا صورة في الطلب" }, 400)
    }

    // The bytes ARE the type. The client's header does not decide this.
    const mime = detectImageMime(body.bytes)
    if (!mime) {
      return c.json({ error: "unsupported_media_type", message: "لا تُقبل إلا صورة من نوع PNG أو JPEG أو WEBP" }, 415)
    }

    const etag = putAvatar(users, me.id, mime, body.bytes, Date.now())
    return c.json({ ok: true as const, avatar: avatarUrlFor(me.username, etag) })
  })

  /** DELETE /api/profile/avatar — remove YOUR OWN avatar, back to the نِيب disc. */
  app.delete("/avatar", (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return c.json({ error: "unauthenticated", message: "سجّل الدخول أولًا" }, 401)
    deleteAvatar(users, me.id)
    return c.json({ ok: true as const, avatar: null })
  })

  /**
   * GET /api/profile/:username/avatar — serve the stored bytes.
   *
   * The `Content-Type` is the STORED mime from the three-value allowlist, never
   * a sniff and never the uploader's claim; `X-Content-Type-Options: nosniff`
   * (set globally in app.ts and again here for the record) forbids the browser
   * from second-guessing it; `Content-Disposition: inline` and a locked type
   * mean the one thing this route can never do is hand back an uploaded blob as
   * `text/html`. The URL is `?v=<etag>`-versioned, so it may be cached hard and
   * a replaced picture — a new etag, a new URL — busts it. No avatar → 404, and
   * the client falls back to the نِيب disc.
   */
  app.get("/:username/avatar", (c) => {
    if (!users) return unavailable(c)
    const raw = decodeParam(c.req.param("username"))
    const parsed = parseParam(c, UsernameSchema, raw)
    if (!parsed.ok) return c.json({ error: "not_found", message: "لا صورة" }, 404)
    const row = findUserByUsername(users, parsed.data)
    if (!row) return c.json({ error: "not_found", message: "لا صورة" }, 404)
    const avatar = getAvatar(users, row.id)
    if (!avatar) return c.json({ error: "not_found", message: "لا صورة" }, 404)

    const quoted = `"${avatar.etag}"`
    // A conditional re-fetch that still matches is 304 — no body, same headers.
    if ((c.req.header("if-none-match") ?? "").includes(avatar.etag)) {
      c.header("ETag", quoted)
      c.header("Cache-Control", avatarCachePolicy(c.req.query("v")))
      return c.body(null, 304)
    }
    // The mime is re-checked against the allowlist at serve time too: a value
    // outside it (a hand-edited row) is refused rather than trusted.
    if (!AVATAR_MIME_TYPES.includes(avatar.mime)) {
      return c.json({ error: "not_found", message: "لا صورة" }, 404)
    }
    // A Response built by hand — the body is the raw bytes and the headers are
    // the LOCKED set: the stored mime (never a sniff), inline disposition,
    // nosniff, the strong ETag, and the versioned cache policy. Nothing here is
    // attacker-chosen, so this route cannot be made to answer as `text/html`.
    return new Response(new Uint8Array(avatar.bytes), {
      status: 200,
      headers: {
        "Content-Type": avatar.mime,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        ETag: quoted,
        "Cache-Control": avatarCachePolicy(c.req.query("v")),
      },
    })
  })

  app.get("/:username", (c) => {
    if (!users) return unavailable(c)
    const raw = decodeParam(c.req.param("username"))
    const parsed = parseParam(c, UsernameSchema, raw)
    // An illegally-shaped username cannot name a row, so it is a 404 like any
    // other unknown name — the client would never emit one, and answering 400
    // would only tell a scanner which shapes are worth trying.
    if (!parsed.ok) return c.json({ error: "not_found", message: "لا حساب بهذا الاسم" }, 404)
    const row = findUserByUsername(users, parsed.data)
    if (!row) return c.json({ error: "not_found", message: "لا حساب بهذا الاسم" }, 404)
    return c.json(payload(users, row, currentUser(c, users, config)))
  })

  return app
}

/**
 * How long a served avatar may be reused. A request that carries the `?v=<etag>`
 * cache-buster is safe to keep for a year `immutable` — a changed picture is a
 * different URL — while a bare `/avatar` (no version) gets a short window so an
 * update is still picked up. The ETag makes either one revalidate to a 304.
 */
function avatarCachePolicy(version: string | undefined): string {
  return version ? "public, max-age=31536000, immutable" : "public, max-age=60"
}

/**
 * Read a request body as raw bytes, never holding more than `max`.
 *
 * The binary twin of `readJsonBody` (server/routes/auth.ts): `Content-Length`
 * is checked first but a chunked upload carries none, so the stream is counted
 * as it arrives and cancelled the instant it crosses the cap — the point is to
 * reject an oversized body by BYTE COUNT before it is ever fully in memory, the
 * same reasoning `MAX_GAME_BODY` is built on.
 */
async function readBinaryBody(
  c: Context,
  max: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; res: Response }> {
  const tooLarge = { ok: false as const, res: c.json({ error: "payload_too_large", limit: max }, 413) }
  const declared = Number(c.req.header("content-length") ?? "")
  if (Number.isFinite(declared) && declared > max) return tooLarge

  const stream = c.req.raw.body
  if (stream === null) return { ok: true, bytes: Buffer.alloc(0) }

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        size += value.byteLength
        if (size > max) {
          await reader.cancel().catch(() => {})
          return tooLarge
        }
        chunks.push(value)
      }
    }
  } catch {
    return { ok: true, bytes: Buffer.alloc(0) }
  } finally {
    reader.releaseLock()
  }
  return { ok: true, bytes: Buffer.concat(chunks) }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
