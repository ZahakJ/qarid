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
  PasswordChangeRequestSchema,
  PasswordResetRequestSchema,
  RegisterRequestSchema,
  avatarUrlFor,
  toErrorBody,
  type AuthUser,
} from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import {
  SESSION_COOKIE,
  SESSION_REFRESH_AFTER_MS,
  SESSION_TTL_MS,
  canonicalizeRecoveryCode,
  clearRecoveryFailures,
  createSession,
  createUser,
  deleteUserSessions,
  dummyPasswordHash,
  findUserByUsername,
  generateRecoveryCode,
  getAvatarEtag,
  getRecovery,
  hashPassword,
  hashRecoveryCode,
  hashToken,
  isSuspended,
  newSessionToken,
  purgeExpiredSessions,
  purgeStaleRooms,
  recordRecoveryFailure,
  refreshSession,
  deleteSession,
  sessionUser,
  setPassword,
  setRecovery,
  touchUser,
  verifyPassword,
  verifyRecoveryCode,
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
 * Password reset is the hardest-limited auth route by IP: a recovery code is a
 * guessing target, so an unauthenticated caller gets 10 attempts an hour before
 * the door shuts — on top of the per-USERNAME lock in `user_recovery` that a
 * distributed guesser rotating IPs still has to answer to.
 */
export const RESET_LIMIT = { tokens: 10, windowMs: 60 * 60 * 1000 } as const

/**
 * Read a JSON body without ever holding more than `MAX_AUTH_BODY` of it.
 * `Content-Length` is a claim (a chunked request carries none), so the stream
 * is counted as it arrives too. An absent body parses as `{}` and the schema
 * then produces the honest field-level 400.
 *
 * A BODY MUST DECLARE ITSELF `application/json`, and that is a security check,
 * not tidiness. `text/plain`, `application/x-www-form-urlencoded` and
 * `multipart/form-data` are the three types a cross-origin request may send
 * with NO preflight — so a page that only wanted the side effect could reach
 * this parser through a bare `<form>` or a `fetch(..., {mode:'no-cors'})`
 * carrying JSON as text. Requiring the one content type a browser will not send
 * across origins without asking permission first removes that shape entirely,
 * and it is the second lock on the same door as `server/origin.ts`.
 */
export async function readJsonBody(c: Context, max = MAX_AUTH_BODY): Promise<{ ok: true; raw: unknown } | { ok: false; res: Response }> {
  const tooLarge = { ok: false as const, res: c.json({ error: "payload_too_large", limit: max }, 413) }
  const declared = Number(c.req.header("content-length") ?? "")
  if (Number.isFinite(declared) && declared > max) return tooLarge

  const stream = c.req.raw.body
  if (stream === null) return { ok: true, raw: {} }

  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
  if (type !== "application/json") {
    return {
      ok: false,
      res: c.json({ error: "unsupported_media_type", message: "الطلب يجب أن يكون application/json" }, 415),
    }
  }

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

/**
 * Row → wire. The id and the password hash never leave this process.
 *
 * `db` is threaded through so the DTO can carry the versioned avatar URL (or
 * null) without ever putting the bytes in JSON — one point read of the etag,
 * never the blob. A missing handle simply means no avatar, like every other
 * account fact on a deployment with no writable users database.
 */
export function authUser(row: UserRow, db: UsersDb | null = null): AuthUser {
  const etag = db ? getAvatarEtag(db, row.id) : null
  return {
    username: row.username,
    displayName: row.display_name,
    joinedAt: row.created_at,
    lastSeenAt: row.last_seen,
    avatar: avatarUrlFor(row.username, etag),
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

// ─────────────────────────────────────────────────────────────────────────────
// Bearer tokens (docs/roadmap-mobile.md §M1)
//
// A native WebView's cookies are unreliable cross-origin, so the Capacitor app
// authenticates with `Authorization: Bearer <token>`. A bearer token IS a
// session token — 32 random bytes whose SHA-256 sits in the SAME `sessions`
// table the cookie uses — just handed back in the login/register body instead
// of (as well as) the cookie, and only when the client asks. Nothing about the
// web flow changes: web clients send no bearer, get no `token`, keep the cookie.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a raw `Authorization` header value → the token, or null. */
export function parseBearerHeader(value: string | undefined): string | null {
  if (!value) return null
  const m = /^Bearer[ \t]+(.+)$/i.exec(value.trim())
  const token = m?.[1]?.trim()
  return token ? token : null
}

/** The bearer token this request carries in its `Authorization` header. */
export function bearerToken(c: Context): string | null {
  return parseBearerHeader(c.req.header("authorization"))
}

/**
 * Did the client ask for a bearer token? Two equivalent signals: the
 * `X-Client: capacitor` header the app sets on every request, or an explicit
 * `{bearer: true}` in the request body. The header is the documented one; the
 * flag exists so the behaviour is exercisable without spoofing a client header.
 */
export function wantsBearer(c: Context, body?: { bearer?: boolean }): boolean {
  if ((c.req.header("x-client") ?? "").trim().toLowerCase() === "capacitor") return true
  return body?.bearer === true
}

/**
 * A bearer token may be MINTED only over a secure transport — an https
 * `PUBLIC_ORIGIN` (production) or a localhost origin (dev, smoke, the emulator).
 * A token returned in a body over plain http to a public host would be a
 * credential travelling in the clear, so issuance is refused there. Same
 * `cookieSecure` logic the `Secure` cookie flag already keys on.
 */
export function bearerIssuanceAllowed(config: Config): boolean {
  if (cookieSecure(config)) return true
  let host: string
  try {
    host = new URL(config.publicOrigin).hostname.toLowerCase()
  } catch {
    return false
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
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
 * Mint one session and set the cookie, returning the raw token. The cookie is
 * ALWAYS written — that is the web flow, unchanged — and the caller decides
 * whether to also hand the token back in the body for a bearer client.
 */
function startSession(c: Context, users: UsersDb, config: Config, userId: number, now: number): string {
  const token = newSessionToken()
  createSession(users, { userId, tokenHash: hashToken(token), now, ua: c.req.header("user-agent") ?? null })
  writeSessionCookie(c, config, token)
  return token
}

/**
 * The body for a session response — `token` present only for a bearer client,
 * `recoveryCode` only on register/reset (never a plain login). Both are secrets
 * that live only in this body; the caller decides when each belongs.
 */
function sessionBody(
  user: UserRow,
  token: string | null,
  db: UsersDb | null = null,
  recoveryCode?: string,
): { user: AuthUser; token?: string; recoveryCode?: string } {
  const body: { user: AuthUser; token?: string; recoveryCode?: string } = { user: authUser(user, db) }
  if (token) body.token = token
  if (recoveryCode) body.recoveryCode = recoveryCode
  return body
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
  // Bearer beats cookie: a native client sends the header, a browser the cookie.
  // Both are session tokens hashed into the same table, so the lookup is one path.
  const bearer = bearerToken(c)
  const token = bearer ?? getCookie(c, SESSION_COOKIE)
  if (!token) return null
  const found = sessionUser(users, hashToken(token), now)
  if (!found) return null
  if (now - (found.session.expires_at - SESSION_TTL_MS) > SESSION_REFRESH_AFTER_MS) {
    // Tokens roll exactly like cookie sessions — same 90-day push. A bearer
    // session rolls in the TABLE only; there is no cookie to re-send, and the
    // token itself is unchanged, so the native client keeps the one it holds.
    refreshSession(users, found.session.token_hash, now + SESSION_TTL_MS)
    if (!bearer) writeSessionCookie(c, config, token)
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
  const resetLimiter = createRateLimiter({ ...RESET_LIMIT, keyOf: clientKey })

  /** No writable database → this deployment simply has no accounts. */
  const unavailable = (c: Context) =>
    c.json({ error: "auth_unavailable", message: "الحسابات غير متاحة على هذا الخادم" }, 503)

  /** A bearer token was asked for over an insecure transport — refused. */
  const insecureBearer = (c: Context) =>
    c.json({ error: "insecure_bearer", message: "الرمز يُصدر عبر https فقط" }, 403)

  app.use("/register", registerLimiter.middleware)
  app.use("/login", loginLimiter.middleware)
  // Password change reuses the auth (login) bucket — it is an auth-sensitive
  // write, and «reuse the auth limiter» is the roadmap's own instruction. The
  // authenticated recovery-code regeneration rides the same bucket.
  app.use("/password", loginLimiter.middleware)
  app.use("/recovery", loginLimiter.middleware)
  // The unauthenticated reset gets its own, harder bucket — the recovery code
  // is a guessing target and no session gates this route.
  app.use("/reset", resetLimiter.middleware)

  app.post("/register", async (c) => {
    if (!users) return unavailable(c)
    const parsed = await parseBody(c, RegisterRequestSchema)
    if (!parsed.ok) return parsed.res
    const { username, password, displayName, invite } = parsed.data

    if (!inviteAccepted(config, invite)) {
      return c.json({ error: "invite_required", message: "رمز الدعوة مطلوب أو غير صحيح" }, 403)
    }

    const wantBearer = wantsBearer(c, parsed.data)
    if (wantBearer && !bearerIssuanceAllowed(config)) return insecureBearer(c)

    const now = Date.now()
    purgeExpiredSessions(users, now)
    purgeStaleRooms(users, now)

    // Cheap pre-check for the ordinary case; the UNIQUE index below is what
    // actually decides, because two signups can race this read.
    if (findUserByUsername(users, username)) {
      return c.json({ error: "username_taken", message: "هذا الاسم مأخوذ" }, 409)
    }

    const passHash = await hashPassword(password)
    const row = createUser(users, { username, displayName: displayName ?? username, passHash, now })
    if (!row) return c.json({ error: "username_taken", message: "هذا الاسم مأخوذ" }, 409)

    // The once-shown recovery code: generated here, stored ONLY as a scrypt hash,
    // and handed back in this body so the client can show it to the reader once.
    const recoveryCode = generateRecoveryCode()
    setRecovery(users, row.id, await hashRecoveryCode(canonicalizeRecoveryCode(recoveryCode)!), now)

    const token = startSession(c, users, config, row.id, now)
    return c.json(sessionBody(row, wantBearer ? token : null, users, recoveryCode), 201)
  })

  app.post("/login", async (c) => {
    if (!users) return unavailable(c)
    const parsed = await parseBody(c, LoginRequestSchema)
    if (!parsed.ok) return parsed.res
    const { username, password } = parsed.data

    const wantBearer = wantsBearer(c, parsed.data)
    if (wantBearer && !bearerIssuanceAllowed(config)) return insecureBearer(c)

    const row = findUserByUsername(users, username)
    // An unknown name still pays for one scrypt, so the response time cannot be
    // used to enumerate accounts.
    const stored = row?.pass_hash ?? (await dummyPasswordHash())
    const ok = await verifyPassword(password, stored)
    if (!row || !ok) {
      return c.json({ error: "bad_credentials", message: "الاسم أو كلمة السر غير صحيحة" }, 401)
    }

    // A suspended account (Track 3) is refused AFTER the password check, so the
    // «suspended» answer is never an oracle for a wrong password. The credential
    // was right; the door is shut by the owner, not by the login form.
    const nowSuspend = Date.now()
    if (isSuspended(row, nowSuspend)) {
      return c.json({ error: "account_suspended", message: "أُوقف هذا الحساب مؤقتًا" }, 403)
    }

    const now = Date.now()
    purgeExpiredSessions(users, now)
    purgeStaleRooms(users, now)
    touchUser(users, row.id, now)
    const token = startSession(c, users, config, row.id, now)
    return c.json(sessionBody({ ...row, last_seen: now }, wantBearer ? token : null, users))
  })

  app.post("/logout", (c) => {
    // Logging out of a server with no accounts is a no-op, not an error: the
    // client's own state is what it is really asking to clear. A bearer client
    // sends its token in the header; a web client in the cookie — either revokes.
    const token = users ? (bearerToken(c) ?? getCookie(c, SESSION_COOKIE)) : undefined
    if (users && token) deleteSession(users, hashToken(token))
    clearSessionCookie(c, config)
    return c.json({ ok: true as const })
  })

  /**
   * POST /api/auth/password — change the password, revoking EVERY session.
   *
   * The revoke is the whole reason this route exists (docs/roadmap-mobile.md
   * §M1): cookie and bearer tokens share one table, so `deleteUserSessions`
   * kills all of them at once — every other device, and this one. The current
   * device is then re-established with a fresh session so the reader who just
   * changed their password is not thrown out of the tab they did it in. The
   * OLD password is verified first, in constant time, so a ridden cookie cannot
   * silently re-key the account.
   */
  app.post("/password", async (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return c.json({ error: "unauthenticated", message: "سجّل الدخول أولًا" }, 401)
    const parsed = await parseBody(c, PasswordChangeRequestSchema)
    if (!parsed.ok) return parsed.res
    const { oldPassword, newPassword } = parsed.data

    const wantBearer = wantsBearer(c, parsed.data)
    if (wantBearer && !bearerIssuanceAllowed(config)) return insecureBearer(c)

    if (!(await verifyPassword(oldPassword, me.pass_hash))) {
      return c.json({ error: "bad_credentials", message: "كلمة السر الحالية غير صحيحة" }, 401)
    }

    const now = Date.now()
    setPassword(users, me.id, await hashPassword(newPassword))
    // Revoke everything — cookie AND bearer — then re-issue this one device.
    deleteUserSessions(users, me.id)
    const token = startSession(c, users, config, me.id, now)
    return c.json(sessionBody(me, wantBearer ? token : null, users))
  })

  /**
   * POST /api/auth/reset — set a new password with the recovery code, UN-authed.
   *
   * The no-email reset (Play launch). The whole route is built to be neither a
   * user-enumeration oracle nor a code-guessing tool:
   *
   *  • UNKNOWN USER and WRONG CODE return the SAME 401 `bad_recovery`, and an
   *    unknown user still pays for one scrypt (against a dummy hash) so the two
   *    cannot be told apart by wall-clock time either. Usernames are already
   *    enumerable here (`GET /api/profile/:u`), so the secret this protects is
   *    the CODE, not the name.
   *  • GUESSING is fought on two axes: the per-IP `resetLimiter` above, and the
   *    per-username lock in `user_recovery` — five wrong codes and the account's
   *    reset door shuts for fifteen minutes, which a distributed guesser
   *    rotating IPs still cannot walk around.
   *  • On success the password is re-keyed with scrypt, EVERY session (cookie
   *    and bearer) is revoked, and the just-used code is ROTATED — a new one is
   *    issued and shown once, because the old one has now been spoken aloud. The
   *    current device is re-established so the reader lands signed in.
   */
  app.post("/reset", async (c) => {
    if (!users) return unavailable(c)
    const parsed = await parseBody(c, PasswordResetRequestSchema)
    if (!parsed.ok) return parsed.res
    const { username, recoveryCode, newPassword } = parsed.data

    const wantBearer = wantsBearer(c, parsed.data)
    if (wantBearer && !bearerIssuanceAllowed(config)) return insecureBearer(c)

    // One generic answer for every "no" below — an unknown name, a bad code, a
    // malformed code — so none of them is distinguishable from the others.
    const badRecovery = () => c.json({ error: "bad_recovery", message: "الاسم أو رمز الاستعادة غير صحيح" }, 401)
    const locked = () =>
      c.json({ error: "recovery_locked", message: "أُغلق باب الاستعادة مؤقتًا بعد محاولات كثيرة — أمهِل قليلًا" }, 429)

    const now = Date.now()
    const row = findUserByUsername(users, username)
    const recovery = row ? getRecovery(users, row.id) : null

    // The lock is checked before the (real or dummy) verify, so a locked account
    // does not even spend a scrypt. A user with no recovery row is never locked.
    if (recovery && recovery.locked_until > now) return locked()

    const canonical = canonicalizeRecoveryCode(recoveryCode)
    // Always run one scrypt: the stored hash for a real account, a throwaway for
    // an unknown user or an unparseable code, so timing is flat across all three.
    const stored = recovery?.code_hash ?? (await dummyPasswordHash())
    const ok = canonical !== null && (await verifyRecoveryCode(canonical, stored))

    if (!row || !recovery || !ok) {
      // Only a real account with a real recovery row can be locked out; the
      // dummy path leaves nothing to count.
      if (row && recovery) recordRecoveryFailure(users, row.id, now)
      return badRecovery()
    }

    // The code was right. Re-key, revoke every session, and rotate the code.
    setPassword(users, row.id, await hashPassword(newPassword))
    deleteUserSessions(users, row.id)
    clearRecoveryFailures(users, row.id)
    const nextCode = generateRecoveryCode()
    setRecovery(users, row.id, await hashRecoveryCode(canonicalizeRecoveryCode(nextCode)!), now)
    touchUser(users, row.id, now)

    // Land the reader signed in on this device, exactly as the password change
    // re-establishes the current one after the revoke.
    const token = startSession(c, users, config, row.id, now)
    return c.json(sessionBody({ ...row, last_seen: now }, wantBearer ? token : null, users, nextCode))
  })

  /**
   * POST /api/auth/recovery — regenerate the recovery code, AUTHENTICATED.
   *
   * The signup code may be lost, and only its hash is stored, so there is no
   * «view» — only «issue a fresh one». It invalidates the old (a rotation, same
   * as the reset does), shows the new once, and keeps nothing but its hash. No
   * password step: a live session is the proof, and every credential change
   * already revokes those sessions elsewhere.
   */
  app.post("/recovery", async (c) => {
    if (!users) return unavailable(c)
    const me = currentUser(c, users, config)
    if (!me) return c.json({ error: "unauthenticated", message: "سجّل الدخول أولًا" }, 401)
    const now = Date.now()
    const code = generateRecoveryCode()
    setRecovery(users, me.id, await hashRecoveryCode(canonicalizeRecoveryCode(code)!), now)
    return c.json({ recoveryCode: code })
  })

  app.get("/me", (c) => {
    const now = Date.now()
    const row = currentUser(c, users, config, now)
    if (users && row) touchUser(users, row.id, now)
    return c.json(
      AuthMeResponseSchema.parse({
        user: row ? authUser(row, users) : null,
        requiresInvite: config.requireInvite,
        available: users !== null,
      }),
    )
  })

  return app
}
