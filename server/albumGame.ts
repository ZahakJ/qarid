/**
 * `server/albumGame.ts` — a ديوان, as a مساجلة can play it.
 *
 * This is the one place that turns a reader's shelf into something the game
 * engine understands, and it is a separate module because THREE surfaces need
 * exactly the same answer and none of them may disagree with the others:
 *
 *   • `GET /api/albums/:code/pool` — the solo door («ساجِل في هذا الديوان»),
 *     which hands the client the bait ids the opponent may recite;
 *   • `POST /api/room` with an `albumCode` — the contest, whose opening بيت
 *     comes off the shelf and whose floor is checked before a room exists;
 *   • `playTurn` (server/rooms.ts) — which asks, on every accepted بيت, whether
 *     the بيت the verifier MATCHED is on the shelf.
 *
 * ── FOUR NUMBERS THAT ARE NOT THE SAME NUMBER ────────────────────────────────
 *
 * A shelf holds `count` ENTRIES — قصائد whole, and single أبيات. `resolved` is
 * how many of them today's artefact can still find (a rebuild may have dropped
 * a قصيدة; the shelf still prints those from its snapshot — CLAUDE.md's anchor
 * invariant). `baits` is the أبيات those entries amount to once every قصيدة is
 * opened. `playable` is how many of THOSE `game_baits` will serve, and it is
 * the only one a duel can honour: 39.8 % of قصائد carry no بحر and the pool
 * admits only `kind='bahr'`, so a thirty-بيت ديوان is often a twelve-بيت
 * مساجلة. Every door says the playable number, because a door that promised
 * thirty and played twelve would be the interface knowing and not saying.
 *
 * ── THE MEMBERSHIP TEST IS THE ANCHOR, NEVER AN ID ───────────────────────────
 *
 * The corpus holds the same بيت under up to 51 ids. A player who answers with a
 * different copy of a بيت that IS on the shelf has answered from the ديوان, and
 * an id-set test would tell him he had not — which is precisely the failure the
 * whole anchor design exists to prevent. So membership is `baitAnchor(sadr,
 * ajuz)` over the matched بيت, compared against the `h_full` strings the shelf
 * stores: one normalizer, one hash, spelled once (shared/arabic.ts).
 *
 * The POOL, on the other hand, must be ids — that is what `game_baits` is keyed
 * on — and it holds exactly ONE id per بيت, the best-ranked playable copy in the
 * same `po.fame DESC, b.position ASC, b.id ASC` order the anchor resolves by.
 * Two copies of one بيت in the pool would let the opponent recite it twice: the
 * duel's exclusions are by id, and the second copy is a different id in a
 * different قصيدة.
 */

import { AlbumCodeSchema } from "../shared/schema.ts"
import type { Db } from "./db.ts"
import { albumEntries, findAlbumByCode, type AlbumRow, type UsersDb } from "./users.ts"

/**
 * THE READ GATE, spelled once — «yours, or a code that opens a shelf its owner
 * published», and everything else is nothing at all.
 *
 * `/api/albums/:code` and its `/pool`, and `POST /api/room` with an
 * `albumCode`, all ask this exact question, and a room that let a host play
 * inside a shelf he could not open would be an enumeration oracle wearing a
 * مساجلة: the 1.68-billion-value code is the capability, so a wrong code and a
 * private shelf must be indistinguishable everywhere, not merely on the route
 * where somebody remembered.
 */
export function readableAlbum(users: UsersDb, code: string, viewerId: number | null): AlbumRow | null {
  const parsed = AlbumCodeSchema.safeParse(code)
  if (!parsed.success) return null
  const album = findAlbumByCode(users, parsed.data)
  if (!album) return null
  if (album.visibility === "private" && album.ownerUserId !== viewerId) return null
  return album
}

export type AlbumPool = {
  /** entries on the shelf */
  count: number
  /** those today's artefact still holds */
  resolved: number
  /** the أبيات those entries amount to — every بيت of every resolved قصيدة, plus the single ones */
  baits: number
  /** those a مساجلة can serve — one id each, in shelf order, best copy of each بيت */
  baitIds: number[]
  /** every anchor of every بيت on the shelf, for the room's membership test */
  anchors: Set<string>
}

/**
 * How many أبيات one shelf may resolve to before the pool stops reading.
 *
 * A قصيدة entry brings every one of its أبيات (the longest in the corpus has
 * 951), and two hundred entries of those would be a memo of 190,000 strings per
 * shelf — a working set a hostile reader could grow into gigabytes across his
 * fifty دواوين. Five thousand covers any shelf a reader compiles by hand (the
 * mean قصيدة is fourteen أبيات) and bounds the rest; a shelf past it plays its
 * first five thousand, in its own order.
 */
const POOL_BAITS_CAP = 5000

/**
 * Resolve a shelf into its playable pool, memoised per `(album, updated_at)`.
 *
 * The key is the album's `updated_at`, which every write helper in
 * `server/users.ts` stamps — so an added or removed entry invalidates this by
 * construction, exactly as `resolveAlbum`'s memo does, rather than by anyone
 * remembering to clear a cache. The map is bounded and dropped whole: this is a
 * per-user working set, not a warm cache like `facets.ts`'s.
 *
 * The walk is in SHELF order, because `baitIds` is truncated for the wire at
 * `ALBUM_LIMITS.pool` and «the first thousand» has to mean the first thousand
 * the curator arranged. A قصيدة entry is one point lookup on `poems.dedup_key`
 * and one range read on `baits_poem_pos`; the single أبيات are gathered and
 * answered by ONE `IN` query over `baits_hfull`, as before.
 */
const MEMO = new Map<string, AlbumPool>()
const MEMO_CAP = 128

type PoolRow = { h: string; bid: number; playable: boolean }

export function albumPool(db: Db, users: UsersDb, album: AlbumRow): AlbumPool {
  const key = `${album.id}:${album.updatedAt}`
  const hit = MEMO.get(key)
  if (hit) return hit

  const entries = albumEntries(users, album.id)
  const pool: AlbumPool = { count: entries.length, resolved: 0, baits: 0, baitIds: [], anchors: new Set() }

  // Every بيت the shelf amounts to, in shelf order, each entry's rows in a run.
  // Read once for the single أبيات (one IN query), then interleaved in order.
  const single = singleBaitRows(
    db,
    entries.filter((e) => e.kind === "bait").map((e) => e.anchor),
  )

  const seen = new Set<string>()
  const take = (rows: readonly PoolRow[]): void => {
    for (const row of rows) {
      if (pool.baits >= POOL_BAITS_CAP) return
      pool.baits += 1
      pool.anchors.add(row.h)
      if (!row.playable || seen.has(row.h)) continue
      seen.add(row.h)
      pool.baitIds.push(row.bid)
    }
  }

  for (const entry of entries) {
    if (entry.kind === "poem") {
      const rows = poemBaitRows(db, entry.poemKey!)
      if (rows === null) continue
      pool.resolved += 1
      take(rows)
    } else {
      const rows = single.get(entry.anchor)
      if (rows === undefined) continue
      pool.resolved += 1
      take(rows)
    }
  }

  if (MEMO.size >= MEMO_CAP) MEMO.clear()
  MEMO.set(key, pool)
  return pool
}

/**
 * The أبيات of one قصيدة entry, in the قصيدة's order — or null when today's
 * artefact has no row under that dedup key.
 *
 * The playable copy is the بيت's OWN row: a قصيدة on a shelf is one specific
 * copy (the dedup winner), and `game_baits` is keyed on its ids, so there is
 * nothing to rank here — unlike a single بيت, whose best copy across the corpus
 * `singleBaitRows` picks by fame.
 */
function poemBaitRows(db: Db, dedupKey: string): PoolRow[] | null {
  const poem = db.q("SELECT id FROM poems WHERE dedup_key = ?").get(dedupKey) as { id: number } | undefined
  if (!poem) return null
  const rows = db
    .q(
      `SELECT CAST(b.h_full AS TEXT) AS h, b.id AS bid, gb.bait_id AS playable
       FROM baits b LEFT JOIN game_baits gb ON gb.bait_id = b.id
       WHERE b.poem_id = ? AND b.h_full IS NOT NULL
       ORDER BY b.position ASC`,
    )
    .all(Number(poem.id)) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    h: String(r.h),
    bid: Number(r.bid),
    playable: r.playable !== null && r.playable !== undefined,
  }))
}

/**
 * The single أبيات, anchor → the best copy in the corpus — ONE query for the
 * whole shelf. `baits_hfull` makes each anchor a point lookup, and the join out
 * is at most 200 × (copies of one بيت) rows, which is why the fame ordering can
 * be done in SQL and read greedily here: the first row per anchor is the copy
 * `resolveAlbum` shows too.
 */
function singleBaitRows(db: Db, anchors: readonly string[]): Map<string, PoolRow[]> {
  const out = new Map<string, PoolRow[]>()
  const keys: bigint[] = []
  for (const a of new Set(anchors)) {
    try {
      keys.push(BigInt(a))
    } catch {
      // An anchor the users db holds that is not a decimal integer cannot name
      // a بيت; it is still ON the shelf (the snapshot renders), simply not
      // playable. `BaitAnchorSchema` makes this unreachable through the API.
    }
  }
  if (keys.length === 0) return out
  const found = db
    .q(
      // `CAST(h_full AS TEXT)` and not the column: it is a signed 64-bit
      // integer, and the anchor a shelf stores is its DECIMAL STRING
      // (`baitAnchor`, shared/arabic.ts). Reading it back as a JS number
      // would round it, and the row would then belong to no anchor at all.
      `SELECT CAST(b.h_full AS TEXT) AS h, b.id AS bid, gb.bait_id AS playable
       FROM baits b
       JOIN poems p ON p.id = b.poem_id
       JOIN poets po ON po.id = p.poet_id
       LEFT JOIN game_baits gb ON gb.bait_id = b.id
       WHERE b.h_full IN (${keys.map(() => "?").join(",")})
       ORDER BY po.fame DESC, b.position ASC, b.id ASC`,
    )
    .all(...keys) as Array<Record<string, unknown>>
  for (const r of found) {
    const h = String(r.h)
    const playable = r.playable !== null && r.playable !== undefined
    const rows = out.get(h)
    // One row per anchor: the first PLAYABLE copy in fame order if there is
    // one, else the first copy at all — so an unplayable بيت still counts as a
    // بيت the shelf holds and an anchor the room accepts.
    if (rows === undefined) out.set(h, [{ h, bid: Number(r.bid), playable }])
    else if (!rows[0]!.playable && playable) rows[0] = { h, bid: Number(r.bid), playable }
  }
  return out
}

/** Test seam — the memo is keyed on `updated_at`, so this is only for fixtures. */
export function resetAlbumPoolMemo(): void {
  MEMO.clear()
}
