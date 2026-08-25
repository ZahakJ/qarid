/**
 * `/api/profile/*` — the page with your name on it (v2.md §4).
 *
 *   GET  /api/profile/:username   public: name, joined date, duel record
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
  ArsenalSchema,
  ArsenalSyncRequestSchema,
  MAX_ARSENAL_BYTES,
  PROFILE_MATCHES_LIMIT,
  ProfileResponseSchema,
  ProfileUpdateRequestSchema,
  UsernameSchema,
  type ProfileResponse,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import { decodeParam, parseParam } from "../query.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import {
  duelStats,
  findUserByUsername,
  getArsenal,
  putArsenal,
  recentMatches,
  setDisplayName,
  type UserRow,
  type UsersDb,
} from "../users.ts"
import { authUser, currentUser, parseBody } from "./auth.ts"

/** Profile writes are cheap but they are writes: 20 per 10 minutes per IP. */
export const PROFILE_WRITE_LIMIT = { tokens: 20, windowMs: 10 * 60 * 1000 } as const

export function profileRoutes(users: UsersDb | null, config: Config): Hono {
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
      user: authUser(row),
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
    })
  }

  app.use("/update", writeLimiter.middleware)
  app.use("/arsenal", writeLimiter.middleware)

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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
