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

/**
 * Upper bound on the statement cache.
 *
 * Every route builds CONSTANT-SHAPED SQL (values arrive as bound parameters),
 * so the number of distinct strings is the number of filter *shapes*, not of
 * filter *values*. But `/api/poems` alone has ten optional filter dimensions
 * and five sorts, and `/api/facets` runs six variants of each — enumerate them
 * and an unbounded Map would hold thousands of compiled statements that nothing
 * will ask for twice. 512 covers every shape a real session emits many times
 * over; past that the least-recently-used entry is dropped and node:sqlite
 * finalises it when it is collected.
 */
export const STATEMENT_CACHE_MAX = 512

export function openDb(dbPath: string): Db {
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  for (const pragma of READ_PRAGMAS) raw.exec(pragma)

  // Map iteration order is insertion order, which is all an LRU needs: a hit
  // re-inserts at the end, so the first key is always the coldest.
  const cache = new Map<string, StatementSync>()
  return {
    raw,
    q(sql) {
      const hit = cache.get(sql)
      if (hit !== undefined) {
        cache.delete(sql)
        cache.set(sql, hit)
        return hit
      }
      const stmt = raw.prepare(sql)
      cache.set(sql, stmt)
      if (cache.size > STATEMENT_CACHE_MAX) {
        const coldest = cache.keys().next()
        if (!coldest.done) cache.delete(coldest.value)
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
