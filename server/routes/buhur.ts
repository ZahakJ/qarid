/**
 * `/api/buhur` — one example بيت per بحر, for صفحة البحور (`#/buhur`).
 *
 *   GET /api/buhur   sixteen `{slug, bait}` rows, in الخليل's دوائر order
 *
 * The page it feeds is a LESSON, and almost all of the lesson ships in the
 * bundle: the اسم, the التفعيلات, the دائرة and the مفتاح are static
 * (`client/data/buhur.ts`), and the count of قصائد on each بحر is already in
 * `/api/meta`'s `meters[].poemCount`, precomputed into `meta_json` at ingest.
 * The one sentence only the corpus can say is «هذا بيتٌ على هذا البحر», so that
 * is the whole payload — sixteen أبيات and nothing else.
 *
 * ── Why this is a route at all, and why it is memoised ──────────────────────
 *
 * Because the honest alternatives were measured on the real artefact
 * (`build_id d1a38337`) and both are worse:
 *
 *   `/api/baits?meter=<slug>&limit=1`  — the بيت-mode browse route, fame-first
 *     already. No index leads with `meter_id`, so SQLite skip-scans `gb_rand`
 *     and sorts the survivors in a temp b-tree: **560 ms** for الطويل, 2.3 s to
 *     fill the page. Every `node:sqlite` call blocks the one event loop
 *     (CLAUDE.md), so that is 2.3 seconds of every other visitor's latency, on
 *     every load of this page, forever.
 *
 *   sixteen `/api/poems?meter=<slug>&sort=fame` calls from the client — 45 ms
 *     worst, 192 ms total, which is affordable ONCE but is paid again by every
 *     reader, and cannot express the two gates below because they are not query
 *     parameters (nor should they be: they are this page's editorial taste, not
 *     a facet of the ديوان).
 *
 * So: one query per بحر, narrowed by `poems_meter(meter_id, bait_count, id)`,
 * **25 ms worst / 97 ms total cold**, memoised on the DB HANDLE in a WeakMap —
 * the shape `server/query.ts`'s slug maps, `facets.ts`'s facet memo and
 * `anthology.ts`'s entry memo all already use — and pre-warmed at boot by
 * `warmBuhur`, whose worst single stall (25 ms) is well under `warmFacets`'
 * documented 69 ms. The artefact is immutable, so the answer is a pure function
 * of the query and the memo can never go stale. After the warm, the page costs
 * the corpus nothing at all.
 *
 * ── What makes a بيت a good EXAMPLE ─────────────────────────────────────────
 *
 * Three gates, and each one is about teaching rather than about fame:
 *
 *  • `meter_variant IS NULL` — a مجزوء or مشطور قصيدة is on the بحر but not on
 *    its full تفعيلات, and the card prints those تفعيلات directly under the
 *    بيت. An example that does not scan against the line above it teaches the
 *    reader something false.
 *  • `has_tashkeel = 1` — this is the one page in قريض where the vowels ARE the
 *    content. You cannot hear مُتَفاعِلُنْ in an unvoweled line.
 *  • `bait_count BETWEEN 5 AND 40` — a five-بيت floor keeps out fragments the
 *    scraper cut, and the ceiling keeps out the ديوان-as-one-poem blobs
 *    (CLAUDE.md §The artefact: dctabudhabi files all of المتنبي under one
 *    مطلع). Neither bound is about quality; both are about the row being a
 *    قصيدة.
 *
 * Within that, the order is the app's own: `po.fame DESC` — the curated canon
 * in `shared/famousPoets.ts` — then the longer قصيدة, then id, so the answer is
 * deterministic for an artefact. `textIsClean` (baits.ts) then walks the window
 * and takes the first مطلع the scraper did not damage, exactly as بيت اليوم
 * does, and for the same reason: this is a بيت printed as an exemplar.
 */

import { Hono } from "hono"

import { BUHUR } from "../../shared/meters.ts"
import type { BahrExample, BuhurResponse } from "../../shared/schema.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db.ts"
import { BAIT_COLS, BAIT_CONTEXT_COLS, BAIT_JOINS, baitDto, type Row } from "../dto.ts"
import { slugMaps } from "../query.ts"
import { textIsClean } from "./baits.ts"

/**
 * How many قصائد the picker looks at before it settles for a damaged مطلع.
 * On the real corpus every بحر answers on the first row; the window is a
 * tiebreak, not a search, and it costs the same query either way (the temp
 * b-tree is built before the LIMIT bites).
 */
const CANDIDATES = 24

/** The two bounds that say «this row is a قصيدة», not a fragment or a ديوان. */
const MIN_BAITS = 5
const MAX_BAITS = 40

const MEMO = new WeakMap<Db, Map<string, BahrExample>>()

function memoOf(db: Db): Map<string, BahrExample> {
  let byHandle = MEMO.get(db)
  if (!byHandle) {
    byHandle = new Map()
    MEMO.set(db, byHandle)
  }
  return byHandle
}

/**
 * The candidate window: قصائد on this بحر, best first. It selects the مطلع's
 * own بيت — `position = 1` — rather than the denormalised `preview_sadr`, so
 * what comes back is a real `BaitDto` with a `baytKey`, and the card can hand
 * it to `BaytPlate` with ♥ / نسخ / بطاقة / ساجِلني live like every other بيت in
 * the app.
 */
function windowFor(db: Db, meterId: number): Row[] {
  return db
    .q(
      `SELECT ${BAIT_COLS}, ${BAIT_CONTEXT_COLS}
       FROM (SELECT p.id AS pid FROM poems p JOIN poets po ON po.id = p.poet_id
             WHERE p.meter_id = ? AND p.meter_variant IS NULL AND p.has_tashkeel = 1
               AND p.bait_count BETWEEN ? AND ?
             ORDER BY po.fame DESC, p.bait_count DESC, p.id ASC LIMIT ?) sel
       JOIN baits b ON b.poem_id = sel.pid AND b.position = 1
       ${BAIT_JOINS}
       ORDER BY po.fame DESC, p.bait_count DESC, p.id ASC`,
    )
    .all(meterId, MIN_BAITS, MAX_BAITS, CANDIDATES) as Row[]
}

/** One بحر, resolved once per DB handle. */
function exampleFor(db: Db, slug: string): BahrExample {
  const memo = memoOf(db)
  const hit = memo.get(slug)
  if (hit) return hit

  const meterId = slugMaps(db).meter.get(slug)
  let bait: BahrExample["bait"] = null
  if (meterId !== undefined) {
    const rows = windowFor(db, meterId)
    // A بيت with no عجز is half a line, and half a line cannot show a whole
    // بحر's تفعيلات — so it is not an example even when it is clean.
    const usable = rows.filter((r) => r.b_ajuz !== null && String(r.b_ajuz).trim() !== "")
    const row = usable.find((r) => textIsClean(String(r.b_sadr), String(r.b_ajuz))) ?? usable[0]
    if (row !== undefined) bait = baitDto(row)
  }

  const item: BahrExample = { slug, bait }
  memo.set(slug, item)
  return item
}

export function buhurRoutes(db: Db, _config: Config): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const body: BuhurResponse = { items: BUHUR.map((m) => exampleFor(db, m.slug)) }
    return c.json(body)
  })

  return app
}

/**
 * Fire-and-forget pre-warm, the shape `warmFacets` and `warmAnthologies`
 * established — and held to the same two rules. It awaits a `setImmediate`
 * before every بحر, so the socket is accepting from the first millisecond and
 * no single turn is longer than one un-warmed request (25 ms worst, measured);
 * and a failure returns what it managed rather than taking the boot down,
 * because a corpus this route cannot read must still serve the ديوان.
 *
 * Returns how many بحور were warmed — sixteen on a healthy artefact.
 */
export async function warmBuhur(db: Db): Promise<number> {
  let warmed = 0
  for (const m of BUHUR) {
    await new Promise((resolve) => setImmediate(resolve))
    try {
      exampleFor(db, m.slug)
      warmed += 1
    } catch (err) {
      console.error(`[qarid] buhur pre-warm failed on ${m.slug}: ${err instanceof Error ? err.message : err}`)
      return warmed
    }
  }
  return warmed
}
