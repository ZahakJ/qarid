import path from "node:path"

export type Config = {
  host: string
  port: number
  publicOrigin: string
  /** absolute path to the built, read-only corpus database */
  dbPath: string
  dev: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = path.join(import.meta.dirname, "..")
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8010),
    publicOrigin: env.PUBLIC_ORIGIN ?? "https://qarid.avicenna.space",
    dbPath: env.DB_PATH ?? path.join(root, "data", "qarid.db"),
    dev: env.NODE_ENV !== "production",
  }
}
