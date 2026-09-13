/**
 * `node scripts/albums/fold.ts [--apply]` — fold the shelves compiled BEFORE
 * migration 11 into playlists.
 *
 * Under the first shape a ديوان stored only أبيات, so «أضِف القصيدة» left a
 * forty-بيت قصيدة as forty rows. Migration 11 carried every one of those rows
 * over unchanged (it cannot read the corpus, and a schema step must not guess),
 * so a shelf compiled a قصيدة at a time still reads as a run of أبيات. This
 * script is the corpus-aware half: it walks every shelf, finds each MAXIMAL run
 * of consecutive بيت entries that belong to one قصيدة and together hold EVERY
 * anchorable بيت of it, and replaces the run with one `poem` entry seated at the
 * run's first position. A partial run — the reader kept twelve lines of a
 * forty-بيت قصيدة — is a selection, not the قصيدة, and is left exactly as it
 * is. Nothing is reordered; the poem entry takes the position its first بيت
 * had, and every other entry keeps its own.
 *
 * Dry by default: it prints what it would fold. `--apply` writes, one
 * transaction per shelf, and stamps `updated_at` so the resolution memos
 * invalidate by construction. Idempotent — a second run finds nothing to fold.
 * Stop the server first, or run it against a snapshot; the writable database
 * is single-writer and the live process holds it.
 */
import path from "node:path"

import { poemAnchor } from "../../shared/arabic.ts"
import { openDb } from "../../server/db.ts"
import { albumEntries, openUsersDb, type UsersDb } from "../../server/users.ts"

const ROOT = path.resolve(import.meta.dirname, "..", "..")
const apply = process.argv.includes("--apply")
const corpus = openDb(process.env.DB_PATH ?? path.join(ROOT, "data", "qarid.db"))
const users: UsersDb = openUsersDb(process.env.USERS_DB_PATH ?? path.join(ROOT, "data", "qarid-users.db"))

type PoemInfo = { id: number; publicId: string; key: string; title: string; poet: string; baitCount: number; anchors: Set<string>; sadr: string; ajuz: string | null }

/** The قصيدة a بيت anchor belongs to — the same fame-first copy the shelf shows. */
function poemOf(anchor: string): PoemInfo | null {
  let key: bigint
  try {
    key = BigInt(anchor)
  } catch {
    return null
  }
  const row = corpus
    .q(
      `SELECT p.id AS id, p.public_id AS pid, p.dedup_key AS key, p.title AS title, po.name AS poet,
              p.bait_count AS n, p.preview_sadr AS sadr, p.preview_ajuz AS ajuz
       FROM baits b JOIN poems p ON p.id = b.poem_id JOIN poets po ON po.id = p.poet_id
       WHERE b.h_full = ? ORDER BY po.fame DESC, b.position ASC, b.id ASC LIMIT 1`,
    )
    .get(key) as Record<string, unknown> | undefined
  if (!row) return null
  const anchors = new Set(
    (corpus.q("SELECT CAST(h_full AS TEXT) AS h FROM baits WHERE poem_id = ? AND h_full IS NOT NULL").all(Number(row.id)) as Array<{ h: string }>).map((r) => String(r.h)),
  )
  return {
    id: Number(row.id),
    publicId: String(row.pid),
    key: String(row.key),
    title: String(row.title),
    poet: String(row.poet),
    baitCount: Number(row.n),
    anchors,
    sadr: row.sadr === null ? "" : String(row.sadr),
    ajuz: row.ajuz === null || row.ajuz === undefined ? null : String(row.ajuz),
  }
}

const albums = users.q("SELECT id, code, title FROM albums ORDER BY id").all() as Array<{ id: number; code: string; title: string }>
let folded = 0
for (const album of albums) {
  const entries = albumEntries(users, album.id)
  const plans: Array<{ poem: PoemInfo; anchors: string[]; position: number }> = []
  let i = 0
  while (i < entries.length) {
    const e = entries[i]!
    if (e.kind !== "bait") {
      i += 1
      continue
    }
    const poem = poemOf(e.anchor)
    if (!poem) {
      i += 1
      continue
    }
    // The maximal run of consecutive بيت entries of this قصيدة.
    const run: string[] = []
    let j = i
    while (j < entries.length && entries[j]!.kind === "bait" && poem.anchors.has(entries[j]!.anchor)) {
      run.push(entries[j]!.anchor)
      j += 1
    }
    const held = new Set(run)
    const whole = poem.anchors.size > 0 && [...poem.anchors].every((a) => held.has(a))
    if (whole) plans.push({ poem, anchors: run, position: e.position })
    i = j
  }
  if (plans.length === 0) continue
  console.log(`${album.code} «${album.title}»`)
  for (const plan of plans) {
    console.log(`  ${plan.anchors.length} أبيات @${plan.position} → قصيدة «${plan.poem.title}» (${plan.poem.poet}, ${plan.poem.publicId})`)
  }
  if (!apply) continue
  users.raw.exec("BEGIN IMMEDIATE")
  try {
    const now = Date.now()
    const del = users.q("DELETE FROM album_entries WHERE album_id = ? AND anchor = ?")
    const ins = users.q(
      `INSERT INTO album_entries
         (album_id, kind, anchor, poem_key, position, snapshot_title, snapshot_sadr, snapshot_ajuz,
          snapshot_poet, snapshot_count, added_at)
       VALUES (?, 'poem', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const plan of plans) {
      for (const a of plan.anchors) del.run(album.id, a)
      ins.run(
        album.id,
        poemAnchor(plan.poem.key),
        plan.poem.key,
        plan.position,
        plan.poem.title,
        plan.poem.sadr,
        plan.poem.ajuz,
        plan.poem.poet,
        plan.poem.baitCount,
        now,
      )
      folded += 1
    }
    users.q("UPDATE albums SET updated_at = ? WHERE id = ?").run(now, album.id)
    users.raw.exec("COMMIT")
  } catch (err) {
    users.raw.exec("ROLLBACK")
    throw err
  }
}
console.log(apply ? `folded ${folded} قصيدة` : "dry run — pass --apply to write")
users.close()
corpus.close()
