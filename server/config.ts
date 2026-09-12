import path from "node:path"

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
   * (Track 3). Empty by default: no account is an admin unless the owner names
   * it in the environment, and the routes 403 for everyone else. Matched
   * case-insensitively, because usernames are `UNIQUE COLLATE NOCASE`.
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
    // the honest reading of "require an invite and issue none", not a reason to
    // silently fall back to open.
    requireInvite: env.REQUIRE_INVITE === "1" || env.REQUIRE_INVITE === "true",
    inviteCodes: codes,
    adminUsernames: admins,
    dev: env.NODE_ENV !== "production",
  }
}

/**
 * Is this username on the admin allowlist? (Track 3.) Case-insensitive, because
 * accounts are `UNIQUE COLLATE NOCASE` — «Owner» and «owner» are one account and
 * must be one admin. An empty allowlist makes this always false: no `/api/admin`
 * route is reachable until the owner sets `ADMIN_USERNAMES`.
 */
export function isAdminUsername(config: Config, username: string | null | undefined): boolean {
  if (!username) return false
  const want = username.trim().toLowerCase()
  if (!want) return false
  return config.adminUsernames.some((u) => u.toLowerCase() === want)
}
