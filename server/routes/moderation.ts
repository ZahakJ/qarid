/**
 * `/api/report`, `/api/block` and `/api/admin/*` — UGC moderation (Track 3).
 *
 * A public app with user content (display names, avatars) and live 1v1 play
 * between real people needs three things, and they are the three route groups
 * here:
 *
 *   POST   /api/report            a logged-in reader reports an account or a ديوان
 *   GET    /api/block             the reader's own block list (private to them)
 *   POST   /api/block             block one account
 *   DELETE /api/block             unblock one account
 *   GET    /api/admin/reports     the owner's report queue        (allowlist)
 *   POST   /api/admin/…           remove avatar / reset name / suspend / resolve,
 *                                 and over a ديوان: unlist it, clear its وصف
 *
 * Every route here is a CORPUS-FREE, per-cookie surface, exactly like
 * `/api/auth` and `/api/profile`: it touches only the writable users database,
 * answers 503 itself when that database is absent, and is `private, no-store`.
 * The CSRF `originGuard` and the `application/json`-only body reader (the two
 * locks in server/app.ts and server/routes/auth.ts) already sit above it, so a
 * cross-origin sibling page cannot ride the session cookie into any of these.
 *
 * ADMIN is gated by an ENV ALLOWLIST and nothing invented on top of it: a
 * minimal authenticated route set behind `ADMIN_USERNAMES`, 403 for every
 * account not on it and 401 for none. There is no admin UI — the owner drives it
 * with `curl`/the app — because the safe surface is the small one.
 */

import { Hono, type Context } from "hono"

import {
  AdminActionRequestSchema,
  AdminAlbumActionRequestSchema,
  AdminReportsResponseSchema,
  AdminResolveRequestSchema,
  BlockRequestSchema,
  PLACEHOLDER_DISPLAY_NAME,
  ReportRequestSchema,
  avatarUrlFor,
  type BlockedUser,
} from "../../shared/schema.ts"
import { isAdminUsername, type Config } from "../config.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import {
  SUSPEND_DEFAULT_DAYS,
  blockUser,
  createReport,
  deleteAvatar,
  deleteUserSessions,
  findAlbumByCode,
  findUserById,
  findUserByUsername,
  getAvatarEtag,
  hasBlocked,
  listBlocks,
  listReports,
  resolveReport,
  setDisplayName,
  suspendUser,
  unblockUser,
  unsuspendUser,
  updateAlbum,
  type UsersDb,
} from "../users.ts"
import { currentUser, parseBody } from "./auth.ts"

/**
 * Reports are logged-in but still a write, and a loud one for the owner: 15 an
 * hour per IP is far above anyone reporting real abuse and well below a flood.
 */
export const REPORT_LIMIT = { tokens: 15, windowMs: 60 * 60 * 1000 } as const

/** Block/unblock is cheap and self-directed: 40 per 10 minutes per IP. */
export const BLOCK_LIMIT = { tokens: 40, windowMs: 10 * 60 * 1000 } as const

/** Admin actions are the owner's own; a generous bucket keeps a fat-fingered loop honest. */
export const ADMIN_LIMIT = { tokens: 120, windowMs: 10 * 60 * 1000 } as const

const unavailable = (c: Context) =>
  c.json({ error: "auth_unavailable", message: "الحسابات غير متاحة على هذا الخادم" }, 503)

const unauthenticated = (c: Context) => c.json({ error: "unauthenticated", message: "سجّل الدخول أولًا" }, 401)

/** A block-list row, as the client renders it — the versioned avatar URL, no id. */
function blockedUser(db: UsersDb, row: { userId: number; username: string; displayName: string; createdAt: number }): BlockedUser {
  return {
    username: row.username,
    displayName: row.displayName,
    avatar: avatarUrlFor(row.username, getAvatarEtag(db, row.userId)),
    createdAt: row.createdAt,
  }
}

function blocksFor(db: UsersDb, userId: number): BlockedUser[] {
  return listBlocks(db, userId).map((r) => blockedUser(db, r))
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/report
// ─────────────────────────────────────────────────────────────────────────────

export function reportRoutes(users: UsersDb | null, config: Config): Hono {
  const app = new Hono()
  const limiter = createRateLimiter({ ...REPORT_LIMIT, keyOf: clientKey })
  app.use("/", limiter.middleware)

  app.post("/", async (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return unauthenticated(c)
    const parsed = await parseBody(c, ReportRequestSchema)
    if (!parsed.ok) return parsed.res

    /*
     * A report about a ديوان names the SHELF, and the server derives the
     * account from it.
     *
     * The اسم and the وصف of a ديوان are UGC on a page carrying its curator's
     * name, exactly as a display name is, so they need the same door. Two rules
     * hold it shut: the shelf must be one the reporter can actually OPEN (a
     * private shelf answers `not_found` here just as it does on the read route —
     * a report is not a probe that says «warmer»), and the reported account is
     * the shelf's owner, never the `targetUsername` beside it, which a client
     * could otherwise use to file a report against anybody in a third party's
     * name.
     */
    let albumId: number | null = null
    let target = null as ReturnType<typeof findUserByUsername>
    if (parsed.data.albumCode) {
      const album = findAlbumByCode(users, parsed.data.albumCode)
      if (!album || (album.visibility === "private" && album.ownerUserId !== me.id)) {
        return c.json({ error: "album_not_found", message: "لا ديوان بهذا الرمز" }, 404)
      }
      albumId = album.id
      target = findUserById(users, album.ownerUserId)
    } else {
      target = findUserByUsername(users, parsed.data.targetUsername!)
    }
    // An unknown name is a plain 404 like a missing profile — not a 400 that
    // would tell a scanner which names exist (they are enumerable anyway, but
    // the shape stays consistent with `/api/profile/:username`).
    if (!target) return c.json({ error: "not_found", message: "لا حساب بهذا الاسم" }, 404)
    if (target.id === me.id) return c.json({ error: "cannot_report_self", message: "لا يُبلَّغ عن النفس" }, 400)

    createReport(users, {
      reporterId: me.id,
      targetId: target.id,
      reason: parsed.data.reason,
      note: parsed.data.note ?? null,
      context: parsed.data.context ?? null,
      targetAlbumId: albumId,
      now: Date.now(),
    })
    return c.json({ ok: true as const })
  })

  return app
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/block
// ─────────────────────────────────────────────────────────────────────────────

export function blockRoutes(users: UsersDb | null, config: Config): Hono {
  const app = new Hono()
  const limiter = createRateLimiter({ ...BLOCK_LIMIT, keyOf: clientKey })
  // The GET is a read (the reader's own list) and, like every other profile
  // read, is unbucketed; the two writes pay the block bucket.
  app.use("/", async (c, next) => (c.req.method === "GET" ? next() : limiter.middleware(c, next)))

  app.get("/", (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return unauthenticated(c)
    return c.json({ blocks: blocksFor(users, me.id) })
  })

  app.post("/", async (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return unauthenticated(c)
    const parsed = await parseBody(c, BlockRequestSchema)
    if (!parsed.ok) return parsed.res

    const target = findUserByUsername(users, parsed.data.username)
    if (!target) return c.json({ error: "not_found", message: "لا حساب بهذا الاسم" }, 404)
    if (target.id === me.id) return c.json({ error: "cannot_block_self", message: "لا تحظر نفسك" }, 400)

    blockUser(users, me.id, target.id, Date.now())
    return c.json({ ok: true as const, blocks: blocksFor(users, me.id) })
  })

  app.delete("/", async (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return unauthenticated(c)
    const parsed = await parseBody(c, BlockRequestSchema)
    if (!parsed.ok) return parsed.res

    const target = findUserByUsername(users, parsed.data.username)
    // Unblocking a name that is gone (deleted, mistyped) is a no-op success, not
    // an error — the desired end state (not blocked) already holds.
    if (target) unblockUser(users, me.id, target.id)
    return c.json({ ok: true as const, blocks: blocksFor(users, me.id) })
  })

  return app
}

/** Whether the signed-in reader has blocked `targetId` — for the profile DTO. */
export { hasBlocked }

// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/* — behind the ADMIN_USERNAMES allowlist AND the normal session
// ─────────────────────────────────────────────────────────────────────────────

/** How many reports the queue returns at once. */
const ADMIN_REPORTS_LIMIT = 200

export function adminRoutes(users: UsersDb | null, config: Config): Hono {
  const app = new Hono()
  const limiter = createRateLimiter({ ...ADMIN_LIMIT, keyOf: clientKey })
  app.use("*", limiter.middleware)

  /**
   * The whole gate: a live session AND a username on the env allowlist. A
   * non-admin session is 403 (the route EXISTS, the account may not use it); no
   * session at all is 401. Returns the admin's row so the handlers need not
   * re-read it.
   */
  const requireAdmin = (c: Context) => {
    if (!users) return { res: unavailable(c) }
    const me = currentUser(c, users, config)
    if (!me) return { res: unauthenticated(c) }
    if (!isAdminUsername(config, me.username)) {
      return { res: c.json({ error: "forbidden", message: "لا صلاحية لك" }, 403) }
    }
    return { me }
  }

  /** Load the account an action targets, or answer 404. */
  const loadTarget = async (c: Context) => {
    const parsed = await parseBody(c, AdminActionRequestSchema)
    if (!parsed.ok) return { res: parsed.res }
    const target = findUserByUsername(users!, parsed.data.username)
    if (!target) return { res: c.json({ error: "not_found", message: "لا حساب بهذا الاسم" }, 404) }
    return { target, data: parsed.data }
  }

  app.get("/reports", (c) => {
    const gate = requireAdmin(c)
    if (gate.res) return gate.res
    const raw = (c.req.query("status") ?? "open").toLowerCase()
    const status = raw === "resolved" ? "resolved" : raw === "all" ? "all" : "open"
    const reports = listReports(users!, { status, limit: ADMIN_REPORTS_LIMIT })
    return c.json(AdminReportsResponseSchema.parse({ reports }))
  })

  app.post("/avatar/remove", async (c) => {
    const gate = requireAdmin(c)
    if (gate.res) return gate.res
    const t = await loadTarget(c)
    if (t.res) return t.res
    deleteAvatar(users!, t.target.id)
    return c.json({ ok: true as const })
  })

  app.post("/display-name/reset", async (c) => {
    const gate = requireAdmin(c)
    if (gate.res) return gate.res
    const t = await loadTarget(c)
    if (t.res) return t.res
    setDisplayName(users!, t.target.id, PLACEHOLDER_DISPLAY_NAME)
    return c.json({ ok: true as const })
  })

  app.post("/suspend", async (c) => {
    const gate = requireAdmin(c)
    if (gate.res) return gate.res
    const t = await loadTarget(c)
    if (t.res) return t.res
    const days = t.data.days ?? SUSPEND_DEFAULT_DAYS
    const now = Date.now()
    suspendUser(users!, t.target.id, now + days * 24 * 60 * 60 * 1000)
    // A suspension only bites if the account is also logged OUT — otherwise the
    // live cookie/bearer keeps playing until it expires. One DELETE kills both.
    deleteUserSessions(users!, t.target.id)
    return c.json({ ok: true as const })
  })

  app.post("/unsuspend", async (c) => {
    const gate = requireAdmin(c)
    if (gate.res) return gate.res
    const t = await loadTarget(c)
    if (t.res) return t.res
    unsuspendUser(users!, t.target.id)
    return c.json({ ok: true as const })
  })

  /** Load the ديوان an album action targets, or answer 404. */
  const loadAlbum = async (c: Context) => {
    const parsed = await parseBody(c, AdminAlbumActionRequestSchema)
    if (!parsed.ok) return { res: parsed.res }
    const album = findAlbumByCode(users!, parsed.data.code)
    if (!album) return { res: c.json({ error: "album_not_found", message: "لا ديوان بهذا الرمز" }, 404) }
    return { album }
  }

  /**
   * POST /api/admin/album/unlist — take a reported ديوان back to `private`.
   *
   * The narrowest action that answers the complaint: the shelf stops being a
   * page anybody else can open, its link stops working, and it leaves the
   * curator's profile — while every بيت on it, and the order he put them in,
   * is untouched in his own «دواويني». Deleting a reader's collection is not an
   * action the allowlist has, and should not be: the offence is in the words
   * around the أبيات, and the other action is the one that removes those.
   */
  app.post("/album/unlist", async (c) => {
    const gate = requireAdmin(c)
    if (gate.res) return gate.res
    const t = await loadAlbum(c)
    if (t.res) return t.res
    updateAlbum(users!, t.album.id, { visibility: "private" }, Date.now())
    return c.json({ ok: true as const })
  })

  /** POST /api/admin/album/description/clear — drop the one free-text field. */
  app.post("/album/description/clear", async (c) => {
    const gate = requireAdmin(c)
    if (gate.res) return gate.res
    const t = await loadAlbum(c)
    if (t.res) return t.res
    updateAlbum(users!, t.album.id, { description: null }, Date.now())
    return c.json({ ok: true as const })
  })

  app.post("/reports/resolve", async (c) => {
    const gate = requireAdmin(c)
    if (gate.res) return gate.res
    const parsed = await parseBody(c, AdminResolveRequestSchema)
    if (!parsed.ok) return parsed.res
    resolveReport(users!, parsed.data.id, Date.now())
    return c.json({ ok: true as const })
  })

  return app
}
