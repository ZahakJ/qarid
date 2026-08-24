/**
 * `/api/auth/*` — accounts (v2.md §4).
 *
 *   POST /api/auth/register  open by default; REQUIRE_INVITE=1 gates it
 *   POST /api/auth/login
 *   POST /api/auth/logout
 *   GET  /api/auth/me        always 200 — `{user: null}` means "nobody"
 *
 * What an account is FOR, so nothing here grows past it: identity for §5's 1v1
 * مساجلة rooms, plus a page with your name on it. Solo play stays in
 * localStorage and needs no account at all. There is no email, so there is no
 * password reset and no address to leak — the owner deletes a row (README).
 *
 * The session cookie is `qarid_sess`: HttpOnly (script cannot read it),
 * SameSite=Lax (a cross-site POST cannot ride it, a normal link still can),
 * Secure whenever `PUBLIC_ORIGIN` is https, 90 days, rolling. The cookie holds
 * 32 random bytes; the table holds their SHA-256 (server/users.ts).
 *
 * Rate limits are per v2.md §4: registration 5/hour/IP, login 10/hour/IP —
 * keyed by `clientKey`, which reads CF-Connecting-IP first because Cloudflare
 * APPENDS to a client-supplied X-Forwarded-For (CLAUDE.md).
 */

import { Hono, type Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import type { z } from "zod"

import {
  AuthMeResponseSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  toErrorBody,
  type AuthUser,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import {
  SESSION_COOKIE,
  SESSION_REFRESH_AFTER_MS,
  SESSION_TTL_MS,
  createSession,
  createUser,
  dummyPasswordHash,
  findUserByUsername,
  hashPassword,
  hashToken,
  newSessionToken,
  purgeExpiredSessions,
  refreshSession,
  deleteSession,
  sessionUser,
  touchUser,
  verifyPassword,
  type UserRow,
  type UsersDb,
} from "../users.ts"

/**
 * The largest body an auth or profile request may carry.
 *
 * The same reasoning as `MAX_GAME_BODY` (server/routes/game.ts), one order of
 * magnitude smaller because these bodies are: a username, a password and — at
 * most — an 8 KB ترسانة snapshot. A schema cannot reject what has already been
 * read into a string and handed to `JSON.parse`.
 */
export const MAX_AUTH_BODY = 32 * 1024

/** v2.md §4 rate limits, as tokens-per-window. */
export const REGISTER_LIMIT = { tokens: 5, windowMs: 60 * 60 * 1000 } as const
export const LOGIN_LIMIT = { tokens: 10, windowMs: 60 * 60 * 1000 } as const

/**
 * Read a JSON body without ever holding more than `MAX_AUTH_BODY` of it.
 * `Content-Length` is a claim (a chunked request carries none), so the stream
 * is counted as it arrives too. An absent body parses as `{}` and the schema
 * then produces the honest field-level 400.
 */
export async function readJsonBody(c: Context, max = MAX_AUTH_BODY): Promise<{ ok: true; raw: unknown } | { ok: false; res: Response }> {
  const tooLarge = { ok: false as const, res: c.json({ error: "payload_too_large", limit: max }, 413) }
  const declared = Number(c.req.header("content-length") ?? "")
  if (Number.isFinite(declared) && declared > max) return tooLarge

  const stream = c.req.raw.body
  if (stream === null) return { ok: true, raw: {} }

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
    return { ok: true, raw: {} }
  } finally {
    reader.releaseLock()
  }

  if (size === 0) return { ok: true, raw: {} }
  try {
    return { ok: true, raw: JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  } catch {
    return { ok: true, raw: {} }
  }
}

/** Parse a JSON body through a schema, or answer `400 {error, issues}`. */
export async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
  max = MAX_AUTH_BODY,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const body = await readJsonBody(c, max)
  if (!body.ok) return body
  const result = schema.safeParse(body.raw)
  if (!result.success) return { ok: false, res: c.json(toErrorBody(result.error, "bad_body"), 400) }
  return { ok: true, data: result.data as z.infer<S> }
}

/** Row → wire. The id and the password hash never leave this process. */
export function authUser(row: UserRow): AuthUser {
  return {
    username: row.username,
    displayName: row.display_name,
    joinedAt: row.created_at,
    lastSeenAt: row.last_seen,
  }
}

/**
 * Whether the cookie must carry `Secure`.
 *
 * Keyed on PUBLIC_ORIGIN, not on NODE_ENV: the site is served to the world by
 * cloudflared over https while the origin itself is plain http on 127.0.0.1, so
 * "is this request encrypted" is the wrong question — "will the browser that
 * holds this cookie ever speak to us over https" is the right one. A dev box on
 * http://localhost:5751 gets a cookie without `Secure`, which is the only way
 * it can be stored at all.
 */
export function cookieSecure(config: Config): boolean {
  return config.publicOrigin.startsWith("https://")
}

/** One place that writes the session cookie — register, login and the roll. */
export function writeSessionCookie(c: Context, config: Config, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieSecure(config),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export function clearSessionCookie(c: Context, config: Config): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "Lax", secure: cookieSecure(config) })
}

/**
 * The signed-in user, or null — the door every authenticated route uses.
 *
 * It also does the ROLL: a session more than a day old has its expiry pushed
 * back to now + 90 days in the table and the cookie re-sent, so an active
 * player is never logged out while an abandoned session still dies on schedule.
 */
export function currentUser(c: Context, users: UsersDb | null, config: Config, now = Date.now()): UserRow | null {
  if (!users) return null
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  const found = sessionUser(users, hashToken(token), now)
  if (!found) return null
  if (now - (found.session.expires_at - SESSION_TTL_MS) > SESSION_REFRESH_AFTER_MS) {
    refreshSession(users, found.session.token_hash, now + SESSION_TTL_MS)
    writeSessionCookie(c, config, token)
  }
  return found.user
}

/** The invite gate. Open registration is the default (v2.md §4). */
function inviteAccepted(config: Config, invite: string | undefined): boolean {
  if (!config.requireInvite) return true
  if (!invite) return false
  // Not constant-time on purpose: an invite code is a coupon, not a
  // credential — it authorises nothing beyond creating an ordinary account.
  return config.inviteCodes.includes(invite)
}

export function authRoutes(users: UsersDb | null, config: Config): Hono {
  const app = new Hono()
  const registerLimiter = createRateLimiter({ ...REGISTER_LIMIT, keyOf: clientKey })
  const loginLimiter = createRateLimiter({ ...LOGIN_LIMIT, keyOf: clientKey })

  /** No writable database → this deployment simply has no accounts. */
  const unavailable = (c: Context) =>
    c.json({ error: "auth_unavailable", message: "الحسابات غير متاحة على هذا الخادم" }, 503)

  app.use("/register", registerLimiter.middleware)
  app.use("/login", loginLimiter.middleware)

  app.post("/register", async (c) => {
    if (!users) return unavailable(c)
    const parsed = await parseBody(c, RegisterRequestSchema)
    if (!parsed.ok) return parsed.res
    const { username, password, displayName, invite } = parsed.data

    if (!inviteAccepted(config, invite)) {
      return c.json({ error: "invite_required", message: "رمز الدعوة مطلوب أو غير صحيح" }, 403)
    }

    const now = Date.now()
    purgeExpiredSessions(users, now)

    // Cheap pre-check for the ordinary case; the UNIQUE index below is what
    // actually decides, because two signups can race this read.
    if (findUserByUsername(users, username)) {
      return c.json({ error: "username_taken", message: "هذا الاسم مأخوذ" }, 409)
    }

    const passHash = await hashPassword(password)
    const row = createUser(users, { username, displayName: displayName ?? username, passHash, now })
    if (!row) return c.json({ error: "username_taken", message: "هذا الاسم مأخوذ" }, 409)

    const token = newSessionToken()
    createSession(users, { userId: row.id, tokenHash: hashToken(token), now, ua: c.req.header("user-agent") ?? null })
    writeSessionCookie(c, config, token)
    return c.json({ user: authUser(row) }, 201)
  })

  app.post("/login", async (c) => {
    if (!users) return unavailable(c)
    const parsed = await parseBody(c, LoginRequestSchema)
    if (!parsed.ok) return parsed.res
    const { username, password } = parsed.data

    const row = findUserByUsername(users, username)
    // An unknown name still pays for one scrypt, so the response time cannot be
    // used to enumerate accounts.
    const stored = row?.pass_hash ?? (await dummyPasswordHash())
    const ok = await verifyPassword(password, stored)
    if (!row || !ok) {
      return c.json({ error: "bad_credentials", message: "الاسم أو كلمة السر غير صحيحة" }, 401)
    }

    const now = Date.now()
    purgeExpiredSessions(users, now)
    touchUser(users, row.id, now)
    const token = newSessionToken()
    createSession(users, { userId: row.id, tokenHash: hashToken(token), now, ua: c.req.header("user-agent") ?? null })
    writeSessionCookie(c, config, token)
    return c.json({ user: authUser({ ...row, last_seen: now }) })
  })

  app.post("/logout", (c) => {
    // Logging out of a server with no accounts is a no-op, not an error: the
    // client's own state is what it is really asking to clear.
    const token = users ? getCookie(c, SESSION_COOKIE) : undefined
    if (users && token) deleteSession(users, hashToken(token))
    clearSessionCookie(c, config)
    return c.json({ ok: true as const })
  })

  app.get("/me", (c) => {
    const now = Date.now()
    const row = currentUser(c, users, config, now)
    if (users && row) touchUser(users, row.id, now)
    return c.json(
      AuthMeResponseSchema.parse({
        user: row ? authUser(row) : null,
        requiresInvite: config.requireInvite,
        available: users !== null,
      }),
    )
  })

  return app
}
