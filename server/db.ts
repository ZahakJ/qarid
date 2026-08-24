import fs from "node:fs"
import { DatabaseSync, type StatementSync } from "node:sqlite"

/**
 * The runtime database is a build artefact: opened read-only, never written.
 * Pragmas per design-server.md §7 — mmap the whole ~1.5 GB file, a 128 MB page
 * cache, temp tables in RAM, and query_only as a belt-and-braces guard on top
 * of readOnly so a stray INSERT throws instead of corrupting the artefact.
 */
export const READ_PRAGMAS = [
  "PRAGMA query_only = 1",
  "PRAGMA mmap_size = 2147483648",
  "PRAGMA cache_size = -131072",
  "PRAGMA temp_store = MEMORY",
] as const

export type Db = {
  raw: DatabaseSync
  /** prepared-statement cache — every hot query goes through this, never db.prepare directly */
  q(sql: string): StatementSync
  close(): void
}

export function openDb(dbPath: string): Db {
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  for (const pragma of READ_PRAGMAS) raw.exec(pragma)

  const cache = new Map<string, StatementSync>()
  return {
    raw,
    q(sql) {
      let stmt = cache.get(sql)
      if (!stmt) {
        stmt = raw.prepare(sql)
        cache.set(sql, stmt)
      }
      return stmt
    },
    close() {
      cache.clear()
      raw.close()
    },
  }
}

/**
 * Boot-time tolerant open: a machine without a built corpus still serves
 * /healthz and the static client (which will show its own error state) rather
 * than crash-looping under systemd.
 */
export function openDbIfPresent(dbPath: string): Db | null {
  if (!fs.existsSync(dbPath)) {
    console.warn(`[qarid] no database at ${dbPath} — serving /healthz + static only (run: npm run ingest)`)
    return null
  }
  try {
    return openDb(dbPath)
  } catch (err) {
    console.warn(`[qarid] failed to open ${dbPath}: ${(err as Error).message} — serving /healthz + static only`)
    return null
  }
}
