/**
 * Where account-less matches live: an in-memory map for tests, and a small
 * SQLite file of its own for the server (`MATCHES_DB_PATH`, default
 * `data/qarid-matches.db`), so a restart keeps every live match. It is not the
 * accounts database — a match has no account to belong to.
 *
 * A match is one row: its code, the two columns the sweeper queries, and the
 * whole record as JSON. The record is small (tens of أبيات at most) and every
 * write replaces it whole, which is what a pure state machine produces anyway.
 */
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { dueAt, type MatchRecord } from "./machine.ts"

export interface MatchStore {
  get(code: string): MatchRecord | null
  /** false when the code is taken */
  insert(m: MatchRecord): boolean
  put(m: MatchRecord): void
  delete(code: string): void
  /** codes whose `dueAt` has passed — an expiry, a deadline or a purge */
  due(now: number, limit?: number): string[]
  /** codes of matches still waiting or active (to re-arm clocks on boot) */
  live(): string[]
  close(): void
}

export function memoryMatchStore(): MatchStore {
  const rows = new Map<string, MatchRecord>()
  return {
    get: (code) => rows.get(code.toUpperCase()) ?? null,
    insert(m) {
      if (rows.has(m.code)) return false
      rows.set(m.code, m)
      return true
    },
    put: (m) => void rows.set(m.code, m),
    delete: (code) => void rows.delete(code.toUpperCase()),
    due: (now, limit = 200) =>
      [...rows.values()]
        .filter((m) => dueAt(m) <= now)
        .slice(0, limit)
        .map((m) => m.code),
    live: () => [...rows.values()].filter((m) => m.status !== "done").map((m) => m.code),
    close: () => rows.clear(),
  }
}

/** `MATCHES_DB_PATH`, or `data/qarid-matches.db` beside the corpus. */
export function matchesDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MATCHES_DB_PATH ?? path.join(import.meta.dirname, "..", "..", "data", "qarid-matches.db")
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
  code       TEXT PRIMARY KEY COLLATE NOCASE,
  status     TEXT NOT NULL,
  due_at     INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_due ON matches (due_at);
`

export function sqliteMatchStore(file: string): MatchStore {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(SCHEMA)

  const getQ = db.prepare("SELECT data FROM matches WHERE code = ?")
  const insertQ = db.prepare(
    "INSERT OR IGNORE INTO matches (code, status, due_at, updated_at, data) VALUES (?, ?, ?, ?, ?)",
  )
  const putQ = db.prepare(
    `INSERT INTO matches (code, status, due_at, updated_at, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET status = excluded.status, due_at = excluded.due_at,
       updated_at = excluded.updated_at, data = excluded.data`,
  )
  const deleteQ = db.prepare("DELETE FROM matches WHERE code = ?")
  const dueQ = db.prepare("SELECT code FROM matches WHERE due_at <= ? ORDER BY due_at LIMIT ?")
  const liveQ = db.prepare("SELECT code FROM matches WHERE status <> 'done'")

  const args = (m: MatchRecord) => [m.code, m.status, dueAt(m), m.updatedAt, JSON.stringify(m)] as const

  return {
    get(code) {
      const row = getQ.get(code) as { data: string } | undefined
      if (!row) return null
      try {
        return JSON.parse(row.data) as MatchRecord
      } catch {
        return null
      }
    },
    insert: (m) => Number(insertQ.run(...args(m)).changes) === 1,
    put: (m) => void putQ.run(...args(m)),
    delete: (code) => void deleteQ.run(code),
    due: (now, limit = 200) => (dueQ.all(now, limit) as { code: string }[]).map((r) => r.code),
    live: () => (liveQ.all() as { code: string }[]).map((r) => r.code),
    close: () => db.close(),
  }
}

/**
 * Boot-time open: the file, or — when data/ is not writable — memory, with one
 * log line. Matches then last as long as the process instead of not at all.
 */
export function openMatchStore(file: string): MatchStore {
  try {
    return sqliteMatchStore(file)
  } catch (err) {
    console.error(`[qarid] matches db unavailable (${err instanceof Error ? err.message : err}); keeping matches in memory`)
    return memoryMatchStore()
  }
}
