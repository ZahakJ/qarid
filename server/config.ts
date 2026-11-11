import path from "node:path"
import { isCanonicalUsername, usernameKey } from "./username.ts"

export type Config = {
  host: string
  port: number
  publicOrigin: string
  /** absolute path to the built, read-only corpus database */
  dbPath: string
  /** absolute path to the writable accounts database (v2.md §4) */
  usersDbPath: string
  /** REQUIRE_INVITE=1 closes open registration */
  requireInvite: boolean
  /** INVITE_CODES — comma list, only read when `requireInvite` */
  inviteCodes: readonly string[]
  /**
   * ADMIN_USERNAMES — comma list of accounts that may reach `/api/admin/*`
   * Empty by default: no account is an admin unless the operator names
   * it in the environment, and the routes 403 for everyone else. Matched by
   * `usernameKey` (NFKC + lowercase). A listed name cannot be taken through
   * open registration: register the account first, then list it.
   */
  adminUsernames: readonly string[]
  dev: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = path.join(import.meta.dirname, "..")
  const codes = (env.INVITE_CODES ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
  const admins = (env.ADMIN_USERNAMES ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8010),
    publicOrigin: env.PUBLIC_ORIGIN ?? "https://qarid.example.com",
    dbPath: env.DB_PATH ?? path.join(root, "data", "qarid.db"),
    usersDbPath: env.USERS_DB_PATH ?? path.join(root, "data", "qarid-users.db"),
    // Registration is OPEN by default (v2.md §4). `REQUIRE_INVITE=1` closes it,
    // and with no `INVITE_CODES` set that means closed to everyone — which is
    // the accurate reading of "require an invite and issue none", not a reason to
    // silently fall back to open.
    requireInvite: env.REQUIRE_INVITE === "1" || env.REQUIRE_INVITE === "true",
    inviteCodes: codes,
    adminUsernames: admins,
    dev: env.NODE_ENV !== "production",
  }
}

/**
 * Is this NAME on the admin allowlist? Compared by `usernameKey`, so «Owner»,
 * «owner» and a Kelvin-sign «owneK» all count as the allowlisted name. Used to
 * keep listed names out of open registration; it is NOT the admin check — see
 * `isAdminAccount`. An empty allowlist makes this always false.
 */
export function isAdminUsername(config: Config, username: string | null | undefined): boolean {
  if (!username) return false
  const want = usernameKey(username)
  if (!want) return false
  return config.adminUsernames.some((u) => usernameKey(u) === want)
}

/**
 * Is this ACCOUNT an admin? Only the account that owns the allowlisted name's
 * key (`users.username_key`), and only if its stored name is itself canonical:
 * a look-alike account (a pre-existing «owneK» with a Kelvin sign, which the
 * key migration leaves without a key) never is. An empty allowlist makes this
 * always false: no `/api/admin` route is reachable until the operator sets
 * `ADMIN_USERNAMES`.
 */
export function isAdminAccount(
  config: Config,
  account: { username: string; username_key: string | null } | null | undefined,
): boolean {
  if (!account || !account.username_key || !isCanonicalUsername(account.username)) return false
  if (account.username_key !== usernameKey(account.username)) return false
  return config.adminUsernames.some((u) => usernameKey(u) === account.username_key)
}
