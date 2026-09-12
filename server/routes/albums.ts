/**
 * `/api/albums` — الدواوين, a reader's own compiled ديوان.
 *
 *   POST   /api/albums                  create
 *   GET    /api/albums/mine             YOUR shelves (the only listing there is)
 *   GET    /api/albums/:code            one shelf, resolved against the artefact
 *   PATCH  /api/albums/:code            owner: title · وصف · visibility · order
 *   DELETE /api/albums/:code            owner
 *   POST   /api/albums/:code/baits      add by ANCHOR; the server builds the snapshot
 *   DELETE /api/albums/:code/baits/:h   remove one بيت
 *   POST   /api/albums/:code/save       keep somebody else's shelf — المكتبة
 *   DELETE /api/albums/:code/save       let it go
 *   GET    /api/albums/:code/pool       the shelf as a مساجلة can play it
 *
 * ── THE ANCHOR, which is the whole design ─────────────────────────────────
 *
 * A ديوان stores `h_full` — the ingest's own fnv1a64 of the normalized بيت
 * (`baitAnchor`, shared/arabic.ts) — and never an id. `public_id` is `q<row id>`
 * for 73 % of قصائد and every id in the artefact moves on `npm run ingest`, so a
 * shelf of ids would quietly re-point at other people's poetry at the next
 * rebuild. `baits_hfull` makes re-finding a بيت a point lookup, and beside the
 * anchor rides a display SNAPSHOT taken at the moment of adding, so an entry the
 * artefact can no longer answer still renders as a بيت — marked «ليست في
 * الديوان اليوم» rather than silently gone. This is the same rule
 * `shared/anthologies.ts` holds for the curated shelves (CANON ANCHORS BY
 * CONTENT), applied to the shelves a reader compiles himself.
 *
 * The SERVER resolves; the client sends hashes and nothing else. A
 * client-supplied «poet» in the snapshot would be a client-supplied attribution
 * on a page carrying somebody's name, so an anchor the artefact cannot answer is
 * refused at the door rather than stored on trust.
 *
 * ── ENUMERATION ───────────────────────────────────────────────────────────
 *
 * There is no route that lists another reader's دواوين — `/mine` is the only
 * listing, and it reads the session's own id. A `private` shelf answers a
 * non-owner with `album_not_found`, exactly as a wrong code does: the code is
 * the capability (ten characters, 1.68 billion values, `AlbumCodeSchema`) and a
 * 403 would confirm that a shelf exists behind a code the reader guessed.
 *
 * ONE listing crosses that line and it is the PUBLISH gesture that opens it:
 * `GET /api/profile/:username` carries the account's `public` دواوين. It is not
 * an enumeration of a reader's shelves — `unlisted` ones stay invisible there,
 * and «مفتوح» is the state whose whole meaning is «show this on my page». There
 * is still no global feed; see §Backlog in CLAUDE.md for why.
 */

import { Hono, type Context } from "hono"

import {
  ALBUM_LIMITS,
  AlbumAddBaitsRequestSchema,
  AlbumCodeSchema,
  AlbumCreateRequestSchema,
  AlbumPatchRequestSchema,
  BaitAnchorSchema,
  type AlbumAddBaitsResponse,
  type AlbumEntry,
  type AlbumPoolResponse,
  type AlbumResponse,
  type AlbumSaveResponse,
  type AlbumSummary,
  type AlbumsResponse,
  type SavedAlbum,
} from "../../shared/schema.ts"
import { albumPool, readableAlbum } from "../albumGame.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { BAIT_COLS, POEM_COLS, POEM_JOINS, baitDto, str, strOrNull, type Row } from "../dto.ts"
import { decodeParam } from "../query.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import {
  addAlbumBaits,
  albumBaits,
  albumBaitCount,
  blockExistsBetween,
  countAlbums,
  countSavedAlbums,
  createAlbum,
  deleteAlbum,
  findAlbumByCode,
  isAlbumSaved,
  listAlbums,
  listSavedAlbums,
  removeAlbumBait,
  reorderAlbum,
  saveAlbum,
  unsaveAlbum,
  updateAlbum,
  type AlbumRow,
  type UserRow,
  type UsersDb,
} from "../users.ts"
import { currentUser, parseBody } from "./auth.ts"

/**
 * الدواوين get their OWN bucket, and the numbers are why.
 *
 * The profile's write limiter is 20 per 10 minutes per IP, which is right for
 * renaming an account and wrong for the gesture this feature IS: a reader
 * curating a ديوان presses «أضِف إلى ديوان» once per بيت, and twenty أبيات in
 * ten minutes is a slow afternoon, not abuse. Same SHAPE (per-IP token bucket,
 * ten-minute window), three times the tokens — still far under anything that
 * could fill a 300-بيت shelf by script, because the shelf's own cap does that.
 */
export const ALBUM_WRITE_LIMIT = { tokens: 60, windowMs: 10 * 60 * 1000 } as const

export function albumRoutes(db: Db, users: UsersDb | null, config: Config): Hono {
  const app = new Hono()
  const writeLimiter = createRateLimiter({ ...ALBUM_WRITE_LIMIT, keyOf: clientKey })

  const unavailable = (c: Context) =>
    c.json({ error: "albums_unavailable", message: "الدواوين غير متاحة على هذا الخادم" }, 503)
  const unauthenticated = (c: Context) =>
    c.json({ error: "unauthenticated", message: "ادخل بحسابك أوّلًا" }, 401)
  const notFound = (c: Context) => c.json({ error: "album_not_found", message: "لا ديوان بهذا الرمز" }, 404)

  // Every write is bucketed; the two reads are not (they are per-cookie and
  // cheap, and `/mine` is one indexed scan of a table with at most 50 rows).
  app.use("/", async (c, next) => (c.req.method === "POST" ? writeLimiter.middleware(c, next) : next()))
  app.use("/:code", async (c, next) => (c.req.method === "GET" ? next() : writeLimiter.middleware(c, next)))
  app.use("/:code/baits", writeLimiter.middleware)
  app.use("/:code/baits/:anchor", writeLimiter.middleware)
  app.use("/:code/save", writeLimiter.middleware)

  /** The signed-in account, or the 401/503 response that stands in for it. */
  const me = (c: Context): { ok: true; user: UserRow; users: UsersDb } | { ok: false; res: Response } => {
    if (!users) return { ok: false, res: unavailable(c) }
    const user = currentUser(c, users, config)
    if (!user) return { ok: false, res: unauthenticated(c) }
    return { ok: true, user, users }
  }

  /**
   * The album named by `:code`, and whether the caller may READ it.
   *
   * The three outcomes are deliberately two: yours, or a code that opens a
   * shelf its owner published. Everything else — a wrong code, someone else's
   * private shelf — is the same 404, because distinguishing them turns the
   * 1.68-billion-value code into a probe that says «warmer».
   */
  const readable = (c: Context): { album: AlbumRow; viewer: UserRow | null; users: UsersDb } | null => {
    if (!users) return null
    const viewer = currentUser(c, users, config)
    // `readableAlbum` (server/albumGame.ts) is the gate itself, spelled once:
    // «ضدّ صديق في هذا الديوان» asks the same question from the room routes,
    // and a second copy of it there would be a second place to get it wrong.
    const album = readableAlbum(users, decodeParam(c.req.param("code")) ?? "", viewer?.id ?? null)
    if (!album) return null
    return { album, viewer, users }
  }

  /** The same, but only for the OWNER — every write path starts here. */
  const owned = (c: Context): { album: AlbumRow; user: UserRow; users: UsersDb } | { res: Response } => {
    const who = me(c)
    if (!who.ok) return { res: who.res }
    const parsed = AlbumCodeSchema.safeParse(decodeParam(c.req.param("code")))
    if (!parsed.success) return { res: notFound(c) }
    const album = findAlbumByCode(who.users, parsed.data)
    // A shelf that is not yours is a shelf that does not exist, for the same
    // reason the read gate says so. `album_forbidden` exists on the wire for a
    // future surface that legitimately knows the album is there.
    if (!album || album.ownerUserId !== who.user.id) return { res: notFound(c) }
    return { album, user: who.user, users: who.users }
  }

  // ── create ────────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    const who = me(c)
    if (!who.ok) return who.res
    const parsed = await parseBody(c, AlbumCreateRequestSchema)
    if (!parsed.ok) return parsed.res
    if (countAlbums(who.users, who.user.id) >= ALBUM_LIMITS.perUser) {
      return c.json({ error: "too_many_albums", message: "بلغتَ أقصى عدد من الدواوين", limit: ALBUM_LIMITS.perUser }, 409)
    }
    const album = createAlbum(
      who.users,
      {
        ownerUserId: who.user.id,
        title: parsed.data.title,
        description: parsed.data.description,
        visibility: parsed.data.visibility,
      },
      Date.now(),
    )
    return c.json({ album: summaryOf(album, true, false) }, 201)
  })

  // ── mine ──────────────────────────────────────────────────────────────────
  //
  // Declared BEFORE `/:code`, because «MINE» is ten characters of the code
  // alphabet's own shape and hono matches in declaration order.
  app.get("/mine", (c) => {
    const who = me(c)
    if (!who.ok) return who.res
    const body: AlbumsResponse = {
      albums: listAlbums(who.users, who.user.id).map((a) => summaryOf(a, true, false)),
      saved: listSavedAlbums(who.users, who.user.id).map((row) => savedOf(who.users, who.user, row)),
    }
    return c.json(body)
  })

  // ── one shelf ─────────────────────────────────────────────────────────────
  app.get("/:code", (c) => {
    const hit = readable(c)
    if (!hit) return notFound(c)
    const isOwner = hit.viewer !== null && hit.viewer.id === hit.album.ownerUserId
    const body: AlbumResponse = {
      album: summaryOf(hit.album, isOwner, savedBy(hit.users, hit.viewer, hit.album)),
      entries: resolveAlbum(db, hit.users, hit.album),
    }
    return c.json(body)
  })

  // ── the shelf as a مساجلة ─────────────────────────────────────────────────
  //
  // «ساجِل في هذا الديوان»: the أبيات the OPPONENT may recite, resolved once at
  // the door and then carried by the stateless duel on every start and reply
  // (shared/schema.ts `poolBaitIds`). The gate is `readable`, so exactly the
  // shelves you may OPEN are the ones you may play inside — a ديوان you cannot
  // see is a 404 here as everywhere else.
  //
  // It says three numbers because they are three different truths and the door
  // must not blur them (`server/albumGame.ts`). No floor is enforced HERE: the
  // route's job is to say what the shelf is, and the client's door is what
  // refuses to open below `ALBUM_LIMITS.playableFloor` — a reader looking at a
  // six-بيت ديوان is owed the sentence, not an error.
  app.get("/:code/pool", (c) => {
    const hit = readable(c)
    if (!hit) return notFound(c)
    const pool = albumPool(db, hit.users, hit.album)
    const isOwner = hit.viewer !== null && hit.viewer.id === hit.album.ownerUserId
    const body: AlbumPoolResponse = {
      album: summaryOf(hit.album, isOwner, savedBy(hit.users, hit.viewer, hit.album)),
      count: pool.count,
      resolved: pool.resolved,
      playable: pool.baitIds.length,
      baitIds: pool.baitIds,
    }
    return c.json(body)
  })

  // ── المكتبة: keep somebody else's shelf ───────────────────────────────────
  //
  // The gate is `readable`, so exactly what you may OPEN is what you may keep:
  // a private shelf answers 404 like a wrong code, and an unlisted one is
  // saveable by whoever was given its link — which is the whole of what an
  // unlisted ديوان promises. Your own shelf is refused rather than silently
  // saved, because it is in «دواويني» already and a row that duplicated it
  // would print the same ديوان twice on one page.
  app.post("/:code/save", (c) => {
    const who = me(c)
    if (!who.ok) return who.res
    const hit = readable(c)
    if (!hit) return notFound(c)
    if (hit.album.ownerUserId === who.user.id) {
      return c.json({ error: "cannot_save_own", message: "هذا ديوانك، وهو في دواوينك أصلًا" }, 400)
    }
    if (!isAlbumSaved(who.users, who.user.id, hit.album.id) && countSavedAlbums(who.users, who.user.id) >= ALBUM_LIMITS.saved) {
      return c.json({ error: "too_many_saved", message: "امتلأت مكتبتك", limit: ALBUM_LIMITS.saved }, 409)
    }
    saveAlbum(who.users, who.user.id, hit.album.id, Date.now())
    const body: AlbumSaveResponse = { album: summaryOf(hit.album, false, true), saved: true }
    return c.json(body)
  })

  // Unsaving is deliberately NOT gated on `readable`: the one row a reader must
  // always be able to remove is the row pointing at a shelf that has since gone
  // private, and that shelf is exactly the one `readable` refuses.
  app.delete("/:code/save", (c) => {
    const who = me(c)
    if (!who.ok) return who.res
    const parsed = AlbumCodeSchema.safeParse(decodeParam(c.req.param("code")))
    if (!parsed.success) return notFound(c)
    const album = findAlbumByCode(who.users, parsed.data)
    if (!album) return notFound(c)
    unsaveAlbum(who.users, who.user.id, album.id)
    // A shelf the reader may no longer see comes back as a null album — the row
    // is gone either way, and nothing of a retracted ديوان crosses the gate on
    // its way out.
    const isOwner = album.ownerUserId === who.user.id
    const visible = isOwner || album.visibility !== "private"
    const body: AlbumSaveResponse = { album: visible ? summaryOf(album, isOwner, false) : null, saved: false }
    return c.json(body)
  })

  // ── edit ──────────────────────────────────────────────────────────────────
  app.patch("/:code", async (c) => {
    const hit = owned(c)
    if ("res" in hit) return hit.res
    const parsed = await parseBody(c, AlbumPatchRequestSchema)
    if (!parsed.ok) return parsed.res
    const now = Date.now()
    const { order, ...fields } = parsed.data
    updateAlbum(hit.users, hit.album.id, fields, now)
    if (order) reorderAlbum(hit.users, hit.album.id, order, now)
    const fresh = findAlbumByCode(hit.users, hit.album.code)!
    return c.json({ album: summaryOf(fresh, true, false) })
  })

  // ── delete ────────────────────────────────────────────────────────────────
  app.delete("/:code", (c) => {
    const hit = owned(c)
    if ("res" in hit) return hit.res
    deleteAlbum(hit.users, hit.album.id)
    return c.json({ ok: true as const })
  })

  // ── add أبيات ─────────────────────────────────────────────────────────────
  app.post("/:code/baits", async (c) => {
    const hit = owned(c)
    if ("res" in hit) return hit.res
    const parsed = await parseBody(c, AlbumAddBaitsRequestSchema)
    if (!parsed.ok) return parsed.res

    const held = albumBaitCount(hit.users, hit.album.id)
    if (held >= ALBUM_LIMITS.baits) {
      return c.json({ error: "album_full", message: "امتلأ هذا الديوان", limit: ALBUM_LIMITS.baits }, 409)
    }

    // De-duplicate WITHIN the request first: «أضِف القصيدة» over a قصيدة that
    // repeats a بيت sends the same anchor twice, and `INSERT OR IGNORE` would
    // count the second one as a duplicate of a بيت added one row earlier.
    const wanted: string[] = []
    const seen = new Set<string>()
    for (const item of parsed.data.items) {
      if (seen.has(item.hFull)) continue
      seen.add(item.hFull)
      wanted.push(item.hFull)
    }

    const inserts: Parameters<typeof addAlbumBaits>[2][number][] = []
    let unresolved = 0
    const room = ALBUM_LIMITS.baits - held
    for (const anchor of wanted) {
      const row = anchorRow(db, anchor)
      if (!row) {
        unresolved += 1
        continue
      }
      // The cap is counted on what will actually be WRITTEN, and the overflow is
      // simply not added — a 300-بيت shelf plus a 400-بيت قصيدة is a truncation
      // the toast reports, not a 409 that loses the first 300.
      if (inserts.length >= room) break
      inserts.push({
        hFull: anchor,
        snapshotSadr: str(row.b_sadr),
        snapshotAjuz: strOrNull(row.b_ajuz),
        snapshotPoet: str(row.po_name),
      })
    }

    // Every anchor the artefact refused, and nothing landed: say so rather than
    // answering «أُضيف 0» to a request that was wrong in kind.
    if (inserts.length === 0 && unresolved === wanted.length) {
      return c.json({ error: "unknown_baits", message: "لم أجد هذه الأبيات في الديوان" }, 404)
    }

    const now = Date.now()
    const added = addAlbumBaits(hit.users, hit.album.id, inserts, now)
    const fresh = findAlbumByCode(hit.users, hit.album.code)!
    const body: AlbumAddBaitsResponse = {
      album: summaryOf(fresh, true, false),
      added,
      duplicates: inserts.length - added,
      unresolved,
    }
    return c.json(body)
  })

  // ── remove one بيت ────────────────────────────────────────────────────────
  app.delete("/:code/baits/:anchor", (c) => {
    const hit = owned(c)
    if ("res" in hit) return hit.res
    const anchor = BaitAnchorSchema.safeParse(decodeParam(c.req.param("anchor")))
    if (!anchor.success) return c.json({ error: "unknown_baits", message: "لم أجد هذا البيت في هذا الديوان" }, 404)
    if (!removeAlbumBait(hit.users, hit.album.id, anchor.data, Date.now())) {
      return c.json({ error: "unknown_baits", message: "لم أجد هذا البيت في هذا الديوان" }, 404)
    }
    const fresh = findAlbumByCode(hit.users, hit.album.code)!
    return c.json({ album: summaryOf(fresh, true, false) })
  })

  return app
}

// ─────────────────────────────────────────────────────────────────────────────
// Shaping
// ─────────────────────────────────────────────────────────────────────────────

export function summaryOf(a: AlbumRow, isOwner: boolean, saved: boolean): AlbumSummary {
  return {
    code: a.code,
    title: a.title,
    description: a.description,
    visibility: a.visibility,
    count: a.count,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    curator: { username: a.ownerUsername, displayName: a.ownerDisplayName },
    isOwner,
    saved,
  }
}

/** Whether this viewer keeps this shelf — false for a signed-out one. */
export function savedBy(users: UsersDb, viewer: UserRow | null, album: AlbumRow): boolean {
  return viewer !== null && isAlbumSaved(users, viewer.id, album.id)
}

/**
 * One row of «من مكتبتك», gated.
 *
 * The two gates are re-read on every listing rather than written into the row at
 * save time, which is the whole reason a saved ديوان is an EDGE and not a copy:
 * a curator who takes his shelf back to `private` closes it for everyone who
 * kept it, in the same instant, without anything having to go and update their
 * rows. A block does the same, in either direction — a shelf is a person
 * speaking. Neither case deletes the reader's row: it stays, sayable and
 * removable, with nothing of the shelf on it.
 */
export function savedOf(users: UsersDb, viewer: UserRow, row: { savedAt: number; album: AlbumRow }): SavedAlbum {
  const { album, savedAt } = row
  if (album.visibility === "private") return { code: album.code, savedAt, album: null, gated: "private" }
  if (blockExistsBetween(users, viewer.id, album.ownerUserId)) {
    return { code: album.code, savedAt, album: null, gated: "blocked" }
  }
  return { code: album.code, savedAt, album: summaryOf(album, album.ownerUserId === viewer.id, true), gated: null }
}

/**
 * The one query that turns an anchor back into a بيت.
 *
 * `baits_hfull` makes it a point lookup, and the ORDER BY is the same one
 * `exactCopies` in server/game.ts uses for the same reason: the corpus holds the
 * same بيت under up to 51 ids, and which copy a shelf shows must be the
 * canonical شاعر's, nearest his مطلع — never whichever id SQLite inserted first
 * («قفا نبك» resolves to أبو العباس الجراوي on rowid order).
 */
function anchorRow(db: Db, anchor: string): Row | undefined {
  let key: bigint
  try {
    key = BigInt(anchor)
  } catch {
    return undefined
  }
  return db
    .q(
      `SELECT ${BAIT_COLS}, ${POEM_COLS}
       FROM baits b JOIN poems p ON p.id = b.poem_id ${POEM_JOINS}
       WHERE b.h_full = ?
       ORDER BY po.fame DESC, b.position ASC, b.id ASC LIMIT 1`,
    )
    .get(key) as Row | undefined
}

/**
 * Resolution, memoised per (album, updated_at).
 *
 * A 300-بيت shelf is 300 point lookups, which is ~4 ms on the real artefact —
 * affordable once, wasteful on every reload of a page that has not changed. The
 * key carries `updated_at`, so any write through this module's own helpers (all
 * of which stamp it) invalidates the entry by construction rather than by
 * anyone remembering to clear a cache. The map is bounded and dropped whole at
 * `MEMO_CAP`: a shelf is per-user data, so this is a working set, not a warm
 * cache like `facets.ts`'s, and an LRU would be more machinery than the 4 ms it
 * is protecting.
 */
const MEMO = new Map<string, AlbumEntry[]>()
const MEMO_CAP = 256

export function resolveAlbum(db: Db, users: UsersDb, album: AlbumRow): AlbumEntry[] {
  const key = `${album.id}:${album.updatedAt}`
  const hit = MEMO.get(key)
  if (hit) return hit
  const entries = albumBaits(users, album.id).map((row, i): AlbumEntry => {
    const found = anchorRow(db, row.hFull)
    return {
      hFull: row.hFull,
      // The stored positions are contiguous after a reorder, but a shelf that
      // has only ever been appended to and pruned has gaps. The wire carries the
      // INDEX, so the client's «up / down» arithmetic never has to know that.
      position: i,
      addedAt: row.addedAt,
      snapshot: { sadr: row.snapshotSadr, ajuz: row.snapshotAjuz, poet: row.snapshotPoet },
      bait: found ? baitDto(found) : null,
    }
  })
  if (MEMO.size >= MEMO_CAP) MEMO.clear()
  MEMO.set(key, entries)
  return entries
}

/** Test seam — the memo is keyed on `updated_at`, so this is only for fixtures. */
export function resetAlbumMemo(): void {
  MEMO.clear()
}
