/**
 * `/api/albums` — الدواوين, a reader's own compiled ديوان.
 *
 *   POST   /api/albums                  create
 *   GET    /api/albums/mine             YOUR shelves (the only listing there is)
 *   GET    /api/albums/:code            one shelf, resolved against the artefact
 *   PATCH  /api/albums/:code            owner: title · وصف · visibility · order
 *   DELETE /api/albums/:code            owner
 *   POST   /api/albums/:code/entries    add قصائد (by public id) and أبيات (by anchor);
 *                                       the server anchors them and builds the snapshot
 *   DELETE /api/albums/:code/entries/:a remove one entry by its anchor
 *   POST   /api/albums/:code/save       keep somebody else's shelf — المكتبة
 *   DELETE /api/albums/:code/save       let it go
 *   GET    /api/albums/:code/pool       the shelf as a مساجلة can play it
 *
 * ── A ديوان IS A PLAYLIST ─────────────────────────────────────────────────
 *
 * An entry is a whole قصيدة or a single بيت, and a قصيدة is ONE entry: the
 * first shape of this feature exploded «أضِف القصيدة» into forty rows in a flat
 * list, and two قصائد added back to back read as one unbroken run of verse.
 * The two kinds share one ordered list and one anchor rule.
 *
 * ── THE ANCHOR, which is the whole design ─────────────────────────────────
 *
 * A ديوان stores CONTENT and never an id. `public_id` is `q<row id>` for 73 %
 * of قصائد and every id in the artefact moves on `npm run ingest`, so a shelf
 * of ids would quietly re-point at other people's poetry at the next rebuild.
 * A بيت's anchor is `h_full` — the ingest's own fnv1a64 of the normalized بيت
 * (`baitAnchor`, shared/arabic.ts), a point lookup on `baits_hfull`. A قصيدة's
 * is its `dedup_key` — `nameKey|مطلع`, the ingest's own decision about which
 * rows are one قصيدة, UNIQUE on `poems` — stored whole for the lookup and
 * hashed for the wire (`poemAnchor`). Beside every anchor rides a display
 * SNAPSHOT taken at the moment of adding, so an entry the artefact can no
 * longer answer still renders as what it was — marked «ليست في الديوان اليوم»
 * rather than silently gone. This is the same rule `shared/anthologies.ts`
 * holds for the curated shelves (CANON ANCHORS BY CONTENT), applied to the
 * shelves a reader compiles himself.
 *
 * The SERVER resolves; the client sends a hash or a public id and nothing
 * else. A client-supplied «poet» in the snapshot would be a client-supplied
 * attribution on a page carrying somebody's name, so an item the artefact
 * cannot answer is refused at the door rather than stored on trust.
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

import { poemAnchor } from "../../shared/arabic.ts"
import {
  ALBUM_LIMITS,
  AlbumAddEntriesRequestSchema,
  AlbumAnchorSchema,
  AlbumCodeSchema,
  AlbumCreateRequestSchema,
  AlbumPatchRequestSchema,
  type AlbumAddEntriesResponse,
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
import { BAIT_COLS, POEM_COLS, POEM_JOINS, baitDto, num, poemSummary, str, strOrNull, type Row } from "../dto.ts"
import { decodeParam } from "../query.ts"
import { clientKey, createRateLimiter } from "../ratelimit.ts"
import {
  addAlbumEntries,
  albumEntries,
  albumEntryCount,
  blockExistsBetween,
  countAlbums,
  countSavedAlbums,
  createAlbum,
  deleteAlbum,
  findAlbumByCode,
  isAlbumSaved,
  listAlbums,
  listSavedAlbums,
  removeAlbumEntry,
  reorderAlbum,
  saveAlbum,
  unsaveAlbum,
  updateAlbum,
  type AlbumEntryInsert,
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
 * could fill a shelf by script, because the shelf's own cap does that.
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
  app.use("/:code/entries", writeLimiter.middleware)
  app.use("/:code/entries/:anchor", writeLimiter.middleware)
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
  // It says four numbers because they are four different truths and the door
  // must not blur them (`server/albumGame.ts`). No floor is enforced HERE: the
  // route's job is to say what the shelf is, and the client's door is what
  // refuses to open below `ALBUM_LIMITS.playableFloor` — a reader looking at a
  // six-بيت ديوان is owed the sentence, not an error.
  //
  // `baitIds` is cut at `ALBUM_LIMITS.pool` for the wire and `playable` is NOT:
  // the solo duel carries the list on every request and a playlist of long
  // قصائد does not fit, so the door prints both and says which it plays from.
  app.get("/:code/pool", (c) => {
    const hit = readable(c)
    if (!hit) return notFound(c)
    const pool = albumPool(db, hit.users, hit.album)
    const isOwner = hit.viewer !== null && hit.viewer.id === hit.album.ownerUserId
    const body: AlbumPoolResponse = {
      album: summaryOf(hit.album, isOwner, savedBy(hit.users, hit.viewer, hit.album)),
      count: pool.count,
      resolved: pool.resolved,
      baits: pool.baits,
      playable: pool.baitIds.length,
      baitIds: pool.baitIds.slice(0, ALBUM_LIMITS.pool),
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

  // ── add entries ───────────────────────────────────────────────────────────
  app.post("/:code/entries", async (c) => {
    const hit = owned(c)
    if ("res" in hit) return hit.res
    const parsed = await parseBody(c, AlbumAddEntriesRequestSchema)
    if (!parsed.ok) return parsed.res

    const held = albumEntryCount(hit.users, hit.album.id)
    if (held >= ALBUM_LIMITS.entries) {
      return c.json({ error: "album_full", message: "امتلأ هذا الديوان", limit: ALBUM_LIMITS.entries }, 409)
    }

    // Resolve first, dedupe on the ANCHOR second: a قصيدة sent by id and the
    // same قصيدة sent twice are one anchor, and `INSERT OR IGNORE` would count
    // the second one as a duplicate of an entry added one row earlier.
    const inserts: AlbumEntryInsert[] = []
    const seen = new Set<string>()
    let unresolved = 0
    const room = ALBUM_LIMITS.entries - held
    for (const item of parsed.data.items) {
      const insert = item.kind === "poem" ? poemInsert(db, item.id) : baitInsert(db, item.hFull)
      if (insert === null) {
        unresolved += 1
        continue
      }
      if (seen.has(insert.anchor)) continue
      seen.add(insert.anchor)
      // The cap is counted on what will actually be WRITTEN, and the overflow is
      // simply not added — a full shelf plus a bulk add is a truncation the toast
      // reports, not a 409 that loses what was already there.
      if (inserts.length >= room) break
      inserts.push(insert)
    }

    // Every item the artefact refused, and nothing landed: say so rather than
    // answering «أُضيف 0» to a request that was wrong in kind.
    if (inserts.length === 0 && unresolved === parsed.data.items.length) {
      return c.json({ error: "unknown_entry", message: "لم أجد ذلك في الديوان" }, 404)
    }

    const now = Date.now()
    const added = addAlbumEntries(hit.users, hit.album.id, inserts, now)
    const fresh = findAlbumByCode(hit.users, hit.album.code)!
    const body: AlbumAddEntriesResponse = {
      album: summaryOf(fresh, true, false),
      added,
      duplicates: inserts.length - added,
      unresolved,
    }
    return c.json(body)
  })

  // ── remove one entry ──────────────────────────────────────────────────────
  app.delete("/:code/entries/:anchor", (c) => {
    const hit = owned(c)
    if ("res" in hit) return hit.res
    const anchor = AlbumAnchorSchema.safeParse(decodeParam(c.req.param("anchor")))
    if (!anchor.success) return c.json({ error: "unknown_entry", message: "لم أجد ذلك في هذا الديوان" }, 404)
    if (!removeAlbumEntry(hit.users, hit.album.id, anchor.data, Date.now())) {
      return c.json({ error: "unknown_entry", message: "لم أجد ذلك في هذا الديوان" }, 404)
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
    poems: a.poems,
    baits: a.baits,
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
 * The one query that turns a بيت's anchor back into a بيت.
 *
 * `baits_hfull` makes it a point lookup, and the ORDER BY is the same one
 * `exactCopies` in server/game.ts uses for the same reason: the corpus holds the
 * same بيت under up to 51 ids, and which copy a shelf shows must be the
 * canonical شاعر's, nearest his مطلع — never whichever id SQLite inserted first
 * («قفا نبك» resolves to أبو العباس الجراوي on rowid order).
 */
function baitRowByAnchor(db: Db, anchor: string): Row | undefined {
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

/** A قصيدة's row plus its dedup key, by either of the two keys a shelf uses. */
const POEM_BY = `SELECT ${POEM_COLS}, p.dedup_key AS p_dedup_key
  FROM poems p ${POEM_JOINS}`

/** …by PUBLIC id — what the client sends at add time. */
function poemRowById(db: Db, publicId: string): Row | undefined {
  return db.q(`${POEM_BY} WHERE p.public_id = ?`).get(publicId) as Row | undefined
}

/** …by DEDUP KEY — what the shelf stored, a point lookup on the UNIQUE index. */
function poemRowByKey(db: Db, dedupKey: string): Row | undefined {
  return db.q(`${POEM_BY} WHERE p.dedup_key = ?`).get(dedupKey) as Row | undefined
}

/** The row `addAlbumEntries` writes for a قصيدة, or null when the id names nothing. */
function poemInsert(db: Db, publicId: string): AlbumEntryInsert | null {
  const row = poemRowById(db, publicId)
  if (!row) return null
  const key = str(row.p_dedup_key)
  return {
    kind: "poem",
    anchor: poemAnchor(key),
    poemKey: key,
    snapshot: {
      title: str(row.p_title),
      // The مطلع, so a قصيدة the artefact later loses still shows its first
      // line. `preview_sadr` is null for six verse-less rows the ingest keeps.
      sadr: strOrNull(row.p_preview_sadr) ?? "",
      ajuz: strOrNull(row.p_preview_ajuz),
      poet: str(row.po_name),
      baitCount: num(row.p_bait_count),
    },
  }
}

/** The row `addAlbumEntries` writes for a بيت, or null when the anchor names nothing. */
function baitInsert(db: Db, anchor: string): AlbumEntryInsert | null {
  const row = baitRowByAnchor(db, anchor)
  if (!row) return null
  return {
    kind: "bait",
    anchor,
    snapshot: { sadr: str(row.b_sadr), ajuz: strOrNull(row.b_ajuz), poet: str(row.po_name) },
  }
}

/**
 * Resolution, memoised per (album, updated_at).
 *
 * A 200-entry shelf is 200 point lookups, which is a few milliseconds on the
 * real artefact — affordable once, wasteful on every reload of a page that has
 * not changed. The key carries `updated_at`, so any write through this module's
 * own helpers (all of which stamp it) invalidates the entry by construction
 * rather than by anyone remembering to clear a cache. The map is bounded and
 * dropped whole at `MEMO_CAP`: a shelf is per-user data, so this is a working
 * set, not a warm cache like `facets.ts`'s, and an LRU would be more machinery
 * than the milliseconds it is protecting.
 */
const MEMO = new Map<string, AlbumEntry[]>()
const MEMO_CAP = 256

export function resolveAlbum(db: Db, users: UsersDb, album: AlbumRow): AlbumEntry[] {
  const key = `${album.id}:${album.updatedAt}`
  const hit = MEMO.get(key)
  if (hit) return hit
  const entries = albumEntries(users, album.id).map((row, i): AlbumEntry => {
    // The stored positions are contiguous after a reorder, but a shelf that
    // has only ever been appended to and pruned has gaps. The wire carries the
    // INDEX, so the client's «up / down» arithmetic never has to know that.
    const base = { anchor: row.anchor, position: i, addedAt: row.addedAt }
    if (row.kind === "poem") {
      const found = poemRowByKey(db, row.poemKey!)
      return {
        kind: "poem",
        ...base,
        snapshot: {
          title: row.snapshotTitle ?? "",
          sadr: row.snapshotSadr,
          ajuz: row.snapshotAjuz,
          poet: row.snapshotPoet,
          baitCount: row.snapshotCount ?? 0,
        },
        poem: found ? poemSummary(found) : null,
      }
    }
    const found = baitRowByAnchor(db, row.anchor)
    return {
      kind: "bait",
      ...base,
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
