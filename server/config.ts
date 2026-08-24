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
  dev: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = path.join(import.meta.dirname, "..")
  const codes = (env.INVITE_CODES ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8010),
    publicOrigin: env.PUBLIC_ORIGIN ?? "https://qarid.avicenna.space",
    dbPath: env.DB_PATH ?? path.join(root, "data", "qarid.db"),
    usersDbPath: env.USERS_DB_PATH ?? path.join(root, "data", "qarid-users.db"),
    // Registration is OPEN by default (v2.md §4). `REQUIRE_INVITE=1` closes it,
    // and with no `INVITE_CODES` set that means closed to everyone — which is
    // the honest reading of "require an invite and issue none", not a reason to
    // silently fall back to open.
    requireInvite: env.REQUIRE_INVITE === "1" || env.REQUIRE_INVITE === "true",
    inviteCodes: codes,
    dev: env.NODE_ENV !== "production",
  }
}
