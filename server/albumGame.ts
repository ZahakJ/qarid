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
 * ── TWO NUMBERS THAT ARE NOT THE SAME NUMBER ─────────────────────────────────
 *
 * A shelf holds `count` أبيات. `resolved` is how many of them today's artefact
 * can still find (a rebuild may have dropped a قصيدة; the shelf still prints
 * those from its snapshot — CLAUDE.md's anchor invariant). `playable` is how
 * many of THOSE `game_baits` will serve, and it is the only one a duel can
 * honour: 39.8 % of قصائد carry no بحر and the pool admits only `kind='bahr'`,
 * so a thirty-بيت ديوان is often a twelve-بيت مساجلة. Every door says the
 * playable number, because a door that promised thirty and played twelve would
 * be the interface knowing and not saying.
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
import { albumBaits, findAlbumByCode, type AlbumRow, type UsersDb } from "./users.ts"

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
  /** أبيات on the shelf */
  count: number
  /** those today's artefact still holds */
  resolved: number
  /** those a مساجلة can serve — one id each, best copy first */
  baitIds: number[]
  /** every anchor on the shelf, for the room's membership test */
  anchors: Set<string>
}

/** How many أبيات the pool query will look at — the shelf's own cap. */
const MAX_ANCHORS = 300

/**
 * Resolve a shelf into its playable pool, memoised per `(album, updated_at)`.
 *
 * The key is the album's `updated_at`, which every write helper in
 * `server/users.ts` stamps — so an added or removed بيت invalidates this by
 * construction, exactly as `resolveAlbum`'s memo does, rather than by anyone
 * remembering to clear a cache. The map is bounded and dropped whole: this is a
 * per-user working set, not a warm cache like `facets.ts`'s.
 */
const MEMO = new Map<string, AlbumPool>()
const MEMO_CAP = 128

export function albumPool(db: Db, users: UsersDb, album: AlbumRow): AlbumPool {
  const key = `${album.id}:${album.updatedAt}`
  const hit = MEMO.get(key)
  if (hit) return hit

  const rows = albumBaits(users, album.id).slice(0, MAX_ANCHORS)
  const anchors = new Set<string>()
  const keys: bigint[] = []
  for (const row of rows) {
    if (anchors.has(row.hFull)) continue
    anchors.add(row.hFull)
    try {
      keys.push(BigInt(row.hFull))
    } catch {
      // An anchor the users db holds that is not a decimal integer cannot name
      // a بيت; it is still ON the shelf (the snapshot renders), simply not
      // playable. `BaitAnchorSchema` makes this unreachable through the API.
    }
  }

  const pool: AlbumPool = { count: album.count, resolved: 0, baitIds: [], anchors }
  if (keys.length > 0) {
    // ONE query for the whole shelf: `baits_hfull` makes each anchor a point
    // lookup, and the join out is at most 300 × (copies of one بيت) rows, which
    // is why the fame ordering can be done in SQL and read greedily here.
    const seen = new Set<string>()
    const resolvedAnchors = new Set<string>()
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
    for (const row of found) {
      const h = String(row.h)
      resolvedAnchors.add(h)
      if (row.playable === null || row.playable === undefined) continue
      if (seen.has(h)) continue
      seen.add(h)
      pool.baitIds.push(Number(row.bid))
    }
    pool.resolved = resolvedAnchors.size
  }

  if (MEMO.size >= MEMO_CAP) MEMO.clear()
  MEMO.set(key, pool)
  return pool
}

/** Test seam — the memo is keyed on `updated_at`, so this is only for fixtures. */
export function resetAlbumPoolMemo(): void {
  MEMO.clear()
}
