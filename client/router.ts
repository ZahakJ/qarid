/**
 * Hash router (daedalus flavour: parseHash / routeHash / useRoute / navigate /
 * initRouter). The URL owns navigation state — for #/browse it owns the facet
 * state outright and the store only mirrors it (design-ux.md §1, §3 Browse).
 *
 * parseHash and routeHash are pure inverses over every canonical Route, which
 * is what router.test.ts pins. Anything unparseable falls back to home.
 */
import { create } from "zustand"
import { isHijaiLetter } from "../shared/letters.ts"
import { anthologyBySlug } from "../shared/anthologies.ts"
import { AlbumCodeSchema, PoetSlugSchema, PublicPoemIdSchema, RoomCodeSchema, SlugSchema, UsernameSchema } from "../shared/schema.ts"
import { BUHUR } from "./data/buhur.ts"

export type BrowseSort = "fame" | "recent" | "length" | "random"
const SORTS: readonly BrowseSort[] = ["fame", "recent", "length", "random"]

/** Facet state for #/browse. Absent key === facet not applied. */
export type BrowseQuery = {
  era?: string
  meter?: string
  theme?: string
  /** single folded Arabic letter — the روي of the poem */
  rawiyy?: string
  /** single folded Arabic letter — first letter of the مطلع */
  letter?: string
  sort?: BrowseSort
  /** 1-based; 1 is canonical and omitted from the hash */
  page?: number
}

/**
 * Facet state for `#/qafiya` — باحث القافية. Absent key === not applied.
 *
 * It is deliberately NOT a `BrowseQuery`. التصفح asks «ما في الديوان على هذه
 * القيود» and its unit flips between قصائد and أبيات; باحث القافية asks one
 * question only — «ما قافى به الفحول هذا الروي» — so the روي is the axis and
 * البحر and العصر are the two narrowings a poet writing on it would want.
 * Sharing the type would have meant a غرض and a حرف بداية the page has no
 * meaning for.
 */
export type QafiyaQuery = {
  /** single folded Arabic letter — the روي being hunted */
  rawiyy?: string
  meter?: string
  era?: string
  /** 1-based; 1 is canonical and omitted from the hash */
  page?: number
}

export type Route =
  | { view: "home" }
  | { view: "poets"; era?: string; letter?: string }
  | { view: "poet"; slug: string }
  /**
   * `#/poem/<id>` — the قصيدة, and `?read=1` the same قصيدة read.
   *
   * وضع القراءة is a ROUTE and not a piece of component state, and that is what
   * buys it its three exits for free: the browser's back button, the phone's
   * hardware one and a shared link that opens straight into the reading. The
   * page underneath is the same mounted `PoemView` either way — `pageKey` drops
   * the flag, so entering and leaving the reading never counts as arriving at a
   * new page.
   */
  | { view: "poem"; id: string; bayt?: number; read?: true }
  | { view: "browse"; query: BrowseQuery }
  /**
   * `#/qafiya` — باحث القافية, the writing tool.
   *
   * التصفح is for a reader; this is for someone with a half-finished بيت and a
   * روي to answer. Same corpus, same `/api/baits` door, different question —
   * which is why it is its own route with its own query rather than a preset
   * of `#/browse`: a URL a poet can keep and come back to.
   */
  | { view: "qafiya"; query: QafiyaQuery }
  /**
   * `#/buhur` — صفحة البحور, the sixteen taught.
   *
   * `bahr` is the card to open on: a بحر chip's popover links here with its own
   * slug, and the page scrolls to that card and pulses it, the way `?bayt=N`
   * does on a قصيدة. It is a SCROLL TARGET, not a filter — the other fifteen
   * cards are still there, because the whole point is that a بحر is one of a
   * circle of relatives.
   */
  | { view: "buhur"; bahr?: string }
  | { view: "search"; q: string; page: number }
  | { view: "wander" }
  /**
   * `#/duel` — the setup screen, and `?poet=<slug>` the same screen with the
   * «قيود» already carrying one شاعر (مساجلة في ديوان فلان).
   *
   * It is a query on the SETUP route rather than a route of its own, and rather
   * than a start: «ساجِل من ديوانه» on a شاعر page is a door into the same five
   * decisions every duel is made of, with the one the reader has already made
   * filled in. That also makes the constraint a URL — the شاعر survives a
   * reload, a share and the back button — and keeps ONE way into a مساجلة.
   */
  | { view: "duel"; poet?: string }
  | { view: "duel-play" }
  | { view: "duel-summary" }
  | { view: "daily" }
  | { view: "train" }
  | { view: "train-drill"; letter?: string }
  | { view: "train-arsenal" }
  | { view: "stats" }
  | { view: "favorites"; collection?: string }
  | { view: "rules" }
  /**
   * `#/anthology` — المختارات المنظومة, the two curated shelves, and
   * `#/anthology/<slug>` one of them.
   *
   * A shelf slug is one of `shared/anthologies.ts`'s own (`muallaqat`, `sair`),
   * checked here rather than at render: an unknown one is not a page and the
   * router says so by falling back, exactly as it does for a bad شاعر slug.
   */
  | { view: "anthology" }
  | { view: "anthology-shelf"; slug: string }
  /**
   * `#/diwans` — «دواويني», the shelves you have compiled.
   *
   * It is a route and not a panel on the profile page because it is a place you
   * go back to: a reader who has named four دواوين has an index, and an index
   * behind a tab on somebody's account page is an index nobody can link to.
   */
  | { view: "diwans" }
  /**
   * `#/diwan/<CODE>` — one ديوان.
   *
   * The code carries the whole claim. A room needs `?k=` beside its six spoken
   * letters because the code there is a NAME; here the code is ten characters
   * and IS the capability, so the link a reader shares is the plain one and
   * there is no second secret to lose (shared/schema.ts `AlbumCodeSchema`).
   */
  | { view: "diwan"; code: string }
  /** `#/privacy` — the hosted privacy policy the app and the listing link to */
  | { view: "privacy" }
  /**
   * `#/more` — the «المزيد» tab of the phone chrome (client/components/TabBar.tsx).
   *
   * It is a real route, not a sheet, so the hardware back button and the
   * history stack treat it like every other screen. On desktop it renders too
   * — nothing links to it there, because the masthead already is the index it
   * stands in for.
   */
  | { view: "more" }
  /** `#/u/<username>` — an account's page (v2.md §4) */
  | { view: "profile"; username: string }
  /**
   * `#/room/<code>` — a 1v1 مساجلة room (v2.md §5).
   *
   * `key` is the invite that rides in the share link (`?k=…`). The CODE names
   * the room and is spoken aloud; the KEY is what proves you were given the
   * link, and the server checks it before it hands out the empty seat or the
   * transcript (server/rooms.ts `newJoinKey`).
   */
  | { view: "room"; code: string; key?: string }

export const HOME: Route = { view: "home" }

/** One of the 28 folded letters — the only thing a رويّ / حرف facet may be. */
function isLetter(v: string | undefined): v is string {
  return !!v && isHijaiLetter(v)
}

/** ASCII slug: era / meter / theme (server-supplied). */
function isSlug(v: string | undefined): v is string {
  return v !== undefined && SlugSchema.safeParse(v).success
}

/** Poet slugs are NOT ascii — 92K rows have no poet url, so the fallback slug
 * is derived from the Arabic name_key (CLAUDE.md spike finding 2). */
function isPoetSlug(v: string | undefined): v is string {
  return v !== undefined && PoetSlugSchema.safeParse(v).success
}

function isPoemId(v: string | undefined): v is string {
  return v !== undefined && PublicPoemIdSchema.safeParse(v).success
}

/** A username is a path segment, so the hash is validated like every other. */
function isUsername(v: string | undefined): v is string {
  return v !== undefined && UsernameSchema.safeParse(v).success
}

/**
 * A room code is SPOKEN before it is typed («badiru»), so the hash accepts any
 * case and canonicalises to upper — `routeHash` writes the uppercase form and
 * `initRouter` rewrites the address bar to it. SQLite matches NOCASE anyway;
 * this is so one room has one URL.
 */
function roomCodeOf(v: string | undefined): string | null {
  const parsed = RoomCodeSchema.safeParse(v)
  return parsed.success ? parsed.data : null
}

/** A ديوان's code is read aloud too, so it canonicalizes to upper like a room's. */
function albumCodeOf(v: string | undefined): string | null {
  const parsed = AlbumCodeSchema.safeParse(v)
  return parsed.success ? parsed.data : null
}

/**
 * One of the SIXTEEN — not one of the 32 rows in `meters`. `#/buhur` teaches
 * البحور, and «الموشح» or «شعر التفعيلة» is not one, so a `?b=` naming a real
 * meter slug that is not a بحر is still not a card to open on.
 */
const BAHR_SLUGS = new Set(BUHUR.map((b) => b.slug))
function isBahrSlug(v: string | undefined): v is string {
  return v !== undefined && BAHR_SLUGS.has(v)
}

function isSort(v: string | undefined): v is BrowseSort {
  return !!v && (SORTS as readonly string[]).includes(v)
}

/** 1-based page; garbage and 1 both collapse to 1. */
function pageOf(v: string | null): number {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1
}

function split(raw: string): { seg: string[]; params: URLSearchParams } {
  const h = raw.startsWith("#") ? raw.slice(1) : raw
  const qi = h.indexOf("?")
  const path = qi === -1 ? h : h.slice(0, qi)
  const params = new URLSearchParams(qi === -1 ? "" : h.slice(qi + 1))
  const seg = path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
  return { seg, params }
}

/** Pure: any hash string → a Route. Unknown paths fall back to home. */
export function parseHash(raw: string): Route {
  const { seg, params } = split(raw)
  const head = seg[0]
  switch (head) {
    case undefined:
    case "":
      return HOME

    case "poets": {
      const era = params.get("era") ?? undefined
      const letter = params.get("letter") ?? undefined
      const r: Route = { view: "poets" }
      if (isSlug(era)) r.era = era
      if (isLetter(letter)) r.letter = letter
      return r
    }

    case "poet": {
      const slug = seg[1]
      return isPoetSlug(slug) ? { view: "poet", slug } : HOME
    }

    case "poem": {
      const id = seg[1]
      if (!isPoemId(id)) return HOME
      const r: Route = { view: "poem", id }
      const bayt = Number(params.get("bayt"))
      if (Number.isInteger(bayt) && bayt >= 1) r.bayt = bayt
      // `?read=1` and nothing else: the flag is a switch, so anything that is
      // not the one canonical value is simply not the reading mode.
      if (params.get("read") === "1") r.read = true
      return r
    }

    case "browse":
      return { view: "browse", query: parseBrowseQuery(params) }

    case "qafiya":
      return { view: "qafiya", query: parseQafiyaQuery(params) }

    case "buhur": {
      // Only one of the sixteen is a card to open on. An unknown `?b=` is
      // dropped rather than guessed — the page is still the page.
      const bahr = params.get("b") ?? undefined
      return isBahrSlug(bahr) ? { view: "buhur", bahr } : { view: "buhur" }
    }

    case "search":
      return { view: "search", q: params.get("q") ?? "", page: pageOf(params.get("p")) }

    case "wander":
      return { view: "wander" }

    case "duel": {
      const sub = seg[1]
      if (sub === "play") return { view: "duel-play" }
      if (sub === "summary") return { view: "duel-summary" }
      // A شاعر slug that is not a slug is dropped, not guessed — the setup
      // screen is still the setup screen, exactly as `#/buhur?b=` is still the
      // page of البحور when its target names nothing.
      const poet = params.get("poet") ?? undefined
      return isPoetSlug(poet) ? { view: "duel", poet } : { view: "duel" }
    }

    case "daily":
      return { view: "daily" }

    case "train": {
      const sub = seg[1]
      if (sub === "drill") {
        // «تدرّب» on a weak حرف opens the drill scoped to it; anything that is
        // not one of the 28 folded letters is dropped, not guessed.
        const letter = params.get("letter") ?? undefined
        return isLetter(letter) ? { view: "train-drill", letter } : { view: "train-drill" }
      }
      if (sub === "arsenal") return { view: "train-arsenal" }
      return { view: "train" }
    }

    case "stats":
      return { view: "stats" }

    case "favorites": {
      const collection = params.get("collection") ?? undefined
      return collection ? { view: "favorites", collection } : { view: "favorites" }
    }

    case "anthology": {
      const slug = seg[1]
      if (slug === undefined) return { view: "anthology" }
      return anthologyBySlug(slug) ? { view: "anthology-shelf", slug } : { view: "anthology" }
    }

    case "rules":
      return { view: "rules" }

    case "diwans":
      return { view: "diwans" }

    case "diwan": {
      const code = albumCodeOf(seg[1])
      return code ? { view: "diwan", code } : { view: "diwans" }
    }

    case "privacy":
      return { view: "privacy" }

    case "more":
      return { view: "more" }

    case "room": {
      const code = roomCodeOf(seg[1])
      if (!code) return HOME
      const key = params.get("k")
      return key ? { view: "room", code, key } : { view: "room", code }
    }

    case "u": {
      // `#/u/<username>` — one letter, because it is typed and shared by hand.
      const username = seg[1]
      return isUsername(username) ? { view: "profile", username } : HOME
    }

    default:
      return HOME
  }
}

/** Facet decoding for #/browse — invalid values are dropped, not guessed. */
export function parseBrowseQuery(params: URLSearchParams): BrowseQuery {
  const q: BrowseQuery = {}
  const era = params.get("era") ?? undefined
  const meter = params.get("meter") ?? undefined
  const theme = params.get("theme") ?? undefined
  const rawiyy = params.get("rawiyy") ?? undefined
  const letter = params.get("letter") ?? undefined
  const sort = params.get("sort") ?? undefined
  if (isSlug(era)) q.era = era
  if (isSlug(meter)) q.meter = meter
  if (isSlug(theme)) q.theme = theme
  if (isLetter(rawiyy)) q.rawiyy = rawiyy
  if (isLetter(letter)) q.letter = letter
  if (isSort(sort)) q.sort = sort
  const page = pageOf(params.get("p"))
  if (page > 1) q.page = page
  return q
}

/** The قافية hunt's own three keys. Invalid values are dropped, not guessed. */
export function parseQafiyaQuery(params: URLSearchParams): QafiyaQuery {
  const q: QafiyaQuery = {}
  const rawiyy = params.get("rawiyy") ?? undefined
  const meter = params.get("meter") ?? undefined
  const era = params.get("era") ?? undefined
  if (isLetter(rawiyy)) q.rawiyy = rawiyy
  // Only a real بحر: the other narrowings a poet wants are the عصر and nothing
  // else, and «قافية على الموشح» is not a thing anyone is hunting.
  if (isBahrSlug(meter)) q.meter = meter
  if (isSlug(era)) q.era = era
  const page = pageOf(params.get("p"))
  if (page > 1) q.page = page
  return q
}

/** Stable key order, so one hunt has one URL. */
export function qafiyaQueryString(q: QafiyaQuery): string {
  const p = new URLSearchParams()
  if (q.rawiyy) p.set("rawiyy", q.rawiyy)
  if (q.meter) p.set("meter", q.meter)
  if (q.era) p.set("era", q.era)
  if (q.page && q.page > 1) p.set("p", String(q.page))
  return p.toString()
}

/** Facet encoding — stable key order so one facet state has one URL. */
export function browseQueryString(q: BrowseQuery): string {
  const p = new URLSearchParams()
  if (q.era) p.set("era", q.era)
  if (q.meter) p.set("meter", q.meter)
  if (q.theme) p.set("theme", q.theme)
  if (q.rawiyy) p.set("rawiyy", q.rawiyy)
  if (q.letter) p.set("letter", q.letter)
  if (q.sort) p.set("sort", q.sort)
  if (q.page && q.page > 1) p.set("p", String(q.page))
  return p.toString()
}

/** True when no facet is applied (sort/page are not facets). */
export function isEmptyBrowseQuery(q: BrowseQuery): boolean {
  return !q.era && !q.meter && !q.theme && !q.rawiyy && !q.letter
}

function withQuery(path: string, qs: string): string {
  return qs ? `${path}?${qs}` : path
}

/** Pure inverse of parseHash for every canonical Route. */
export function routeHash(r: Route): string {
  switch (r.view) {
    case "home":
      return "#/"
    case "poets": {
      const p = new URLSearchParams()
      if (r.era) p.set("era", r.era)
      if (r.letter) p.set("letter", r.letter)
      return withQuery("#/poets", p.toString())
    }
    case "poet":
      return `#/poet/${encodeURIComponent(r.slug)}`
    case "poem": {
      const p = new URLSearchParams()
      if (r.bayt && r.bayt >= 1) p.set("bayt", String(r.bayt))
      if (r.read) p.set("read", "1")
      return withQuery(`#/poem/${r.id}`, p.toString())
    }
    case "browse":
      return withQuery("#/browse", browseQueryString(r.query))
    case "qafiya":
      return withQuery("#/qafiya", qafiyaQueryString(r.query))
    case "buhur":
      return withQuery("#/buhur", r.bahr ? `b=${r.bahr}` : "")
    case "search": {
      const p = new URLSearchParams()
      if (r.q) p.set("q", r.q)
      if (r.page > 1) p.set("p", String(r.page))
      return withQuery("#/search", p.toString())
    }
    case "wander":
      return "#/wander"
    case "duel":
      return withQuery("#/duel", r.poet ? `poet=${encodeURIComponent(r.poet)}` : "")
    case "duel-play":
      return "#/duel/play"
    case "duel-summary":
      return "#/duel/summary"
    case "daily":
      return "#/daily"
    case "train":
      return "#/train"
    case "train-drill": {
      const p = new URLSearchParams()
      if (r.letter) p.set("letter", r.letter)
      return withQuery("#/train/drill", p.toString())
    }
    case "train-arsenal":
      return "#/train/arsenal"
    case "stats":
      return "#/stats"
    case "favorites": {
      const p = new URLSearchParams()
      if (r.collection) p.set("collection", r.collection)
      return withQuery("#/favorites", p.toString())
    }
    case "anthology":
      return "#/anthology"
    case "anthology-shelf":
      return `#/anthology/${r.slug}`
    case "rules":
      return "#/rules"
    case "diwans":
      return "#/diwans"
    case "diwan":
      return `#/diwan/${r.code}`
    case "privacy":
      return "#/privacy"
    case "more":
      return "#/more"
    case "profile":
      return `#/u/${encodeURIComponent(r.username)}`
    case "room":
      return r.key ? `#/room/${r.code}?k=${encodeURIComponent(r.key)}` : `#/room/${r.code}`
  }
}

/** Arabic label for a route — masthead, breadcrumbs, document.title. */
export function routeTitle(r: Route): string {
  switch (r.view) {
    case "home":
      return "قريض"
    case "poets":
      return "الشعراء"
    case "poet":
      return "الشاعر"
    case "poem":
      return "القصيدة"
    case "browse":
      return "التصفح"
    case "qafiya":
      return "باحث القافية"
    case "buhur":
      return "البحور"
    case "search":
      return "البحث"
    case "wander":
      return "التجوال"
    case "duel":
      return "المساجلة"
    case "duel-play":
      return "المساجلة"
    case "duel-summary":
      return "خلاصة المساجلة"
    case "daily":
      return "تحدّي اليوم"
    case "train":
      return "التحفيظ"
    case "train-drill":
      return "المذاكرة"
    case "train-arsenal":
      return "الترسانة"
    case "stats":
      return "الإحصاءات"
    case "favorites":
      return "المختارات"
    case "anthology":
      return "المختارات المنظومة"
    case "anthology-shelf":
      // The shelf's OWN name — «المعلقات» over «المختارات المنظومة» is what the
      // reader came for, and the parent title is one chevron away.
      return anthologyBySlug(r.slug)?.title ?? "المختارات المنظومة"
    case "rules":
      return "قواعد المساجلة"
    case "diwans":
      return "دواويني"
    case "diwan":
      return "ديوان"
    case "privacy":
      return "سياسة الخصوصية"
    case "more":
      return "المزيد"
    case "profile":
      return "الحساب"
    case "room":
      return "مساجلة الأصدقاء"
  }
}

/**
 * The identity of a PAGE, for the one thing that has to know when the reader
 * has arrived somewhere new: the scroll position (App.tsx).
 *
 * It deliberately drops the parts of a hash that a reader changes WITHOUT
 * leaving the page — `#/browse`'s facets, sort and `?p=`, `#/search`'s page,
 * `#/poem`'s `?bayt=` anchor and its `?read=1`. Entering وضع القراءة is not
 * arriving at a new page: the قصيدة is the same one, and the reader's own
 * scroll is restored by `readerStore` when the reading ends.
 * `#/browse` writes `?p=2` into the hash every time
 * «المزيد» fires, and jumping to the top there would throw away the position of
 * the very rows it just loaded. Everything else — a different شاعر, a different
 * قصيدة, another view — is a new page and starts at its top.
 */
export function pageKey(r: Route): string {
  switch (r.view) {
    case "poet":
      return `poet:${r.slug}`
    case "poem":
      return `poem:${r.id}`
    case "search":
      return `search:${r.q}`
    case "poets":
      return `poets:${r.era ?? ""}:${r.letter ?? ""}`
    case "train-drill":
      return `train-drill:${r.letter ?? ""}`
    case "favorites":
      return `favorites:${r.collection ?? ""}`
    case "profile":
      return `profile:${r.username}`
    case "room":
      return `room:${r.code}`
    case "anthology-shelf":
      return `anthology:${r.slug}`
    case "diwan":
      return `diwan:${r.code}`
    default:
      return r.view
  }
}

export const useRoute = create<{ route: Route }>()(() => ({ route: HOME }))

export function navigate(r: Route, replace = false): void {
  const hash = routeHash(r)
  if (location.hash === hash) return
  if (replace) {
    // Keep whatever `qd` this entry already carries — a replace is the SAME
    // history entry wearing a different hash, so its depth has not changed.
    history.replaceState(history.state, "", hash)
    useRoute.setState({ route: parseHash(hash) })
  } else {
    location.hash = hash // fires hashchange → store update
  }
}

/**
 * How deep into this app's own history the current entry sits — 0 for the
 * entry the reader ARRIVED on.
 *
 * The phone chrome's back chevron needs one fact a hash router does not
 * otherwise have: whether `history.back()` lands on another screen of قريض or
 * walks out of the app entirely (a shared `#/poem/…` link opened cold has
 * nothing behind it but the referring page). Counting `hashchange` events is
 * wrong — a BACK fires one too — so the depth is stamped on the entry itself,
 * in `history.state.qd`: an entry that already carries one is being re-visited
 * and its number is the truth, an entry with none is new and is one deeper than
 * where we stood. `replaceState` neither adds an entry nor fires an event, so
 * stamping is free.
 */
let depth = 0
export function navDepth(): number {
  return depth
}

/**
 * A shared قصيدة arrives as `/p/<id>` — a real PATH, because a hash fragment is
 * never sent to a server and so could never carry per-قصيدة preview tags
 * (server/share.ts). The server answers that path with the ordinary shell plus
 * the قصيدة's head; the app's own vocabulary is still the hash, so the path is
 * folded back into `#/poem/<id>` before the first route is ever parsed.
 *
 * `replaceState`, never an assignment to `location`: assigning would reload the
 * whole shell, and pushing would leave the reader's first Back on the قصيدة he
 * is already looking at. An explicit hash on the URL wins — it is the more
 * specific instruction of the two.
 */
const SHARE_PATH = /^\/p\/([^/]+)\/?$/

/**
 * The pure half: what `/p/<id>` should become, or null to leave the URL alone.
 * An explicit hash wins — it is the more specific of the two instructions.
 */
export function sharePathToHash(pathname: string, hash: string): string | null {
  if (hash) return null
  const m = SHARE_PATH.exec(pathname)
  return m ? `/#/poem/${m[1]}` : null
}

function foldSharePath(): void {
  const next = sharePathToHash(location.pathname, location.hash)
  if (next !== null) history.replaceState(history.state, "", next)
}

/** Parse the current hash, canonicalize it, subscribe. Returns cleanup. */
export function initRouter(): () => void {
  foldSharePath()
  let first = true
  const apply = () => {
    const route = parseHash(location.hash)
    const canonical = routeHash(route)
    const stamped = (history.state as { qd?: number } | null)?.qd
    if (typeof stamped === "number") depth = stamped
    else depth = first ? 0 : depth + 1
    // Always re-stamp: it also canonicalizes the hash, which used to be the
    // only reason this line ran.
    history.replaceState({ ...(history.state as object | null), qd: depth }, "", canonical)
    first = false
    useRoute.setState({ route })
  }
  apply()
  window.addEventListener("hashchange", apply)
  return () => window.removeEventListener("hashchange", apply)
}
