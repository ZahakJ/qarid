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
import { PoetSlugSchema, PublicPoemIdSchema, SlugSchema } from "../shared/schema.ts"

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

export type Route =
  | { view: "home" }
  | { view: "poets"; era?: string; letter?: string }
  | { view: "poet"; slug: string }
  | { view: "poem"; id: string; bayt?: number }
  | { view: "browse"; query: BrowseQuery }
  | { view: "search"; q: string; page: number }
  | { view: "wander" }
  | { view: "duel" }
  | { view: "duel-play" }
  | { view: "duel-summary" }
  | { view: "daily" }
  | { view: "train" }
  | { view: "train-drill"; letter?: string }
  | { view: "train-arsenal" }
  | { view: "stats" }
  | { view: "favorites"; collection?: string }
  | { view: "rules" }

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
      return r
    }

    case "browse":
      return { view: "browse", query: parseBrowseQuery(params) }

    case "search":
      return { view: "search", q: params.get("q") ?? "", page: pageOf(params.get("p")) }

    case "wander":
      return { view: "wander" }

    case "duel": {
      const sub = seg[1]
      if (sub === "play") return { view: "duel-play" }
      if (sub === "summary") return { view: "duel-summary" }
      return { view: "duel" }
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

    case "rules":
      return { view: "rules" }

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
      return withQuery(`#/poem/${r.id}`, p.toString())
    }
    case "browse":
      return withQuery("#/browse", browseQueryString(r.query))
    case "search": {
      const p = new URLSearchParams()
      if (r.q) p.set("q", r.q)
      if (r.page > 1) p.set("p", String(r.page))
      return withQuery("#/search", p.toString())
    }
    case "wander":
      return "#/wander"
    case "duel":
      return "#/duel"
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
    case "rules":
      return "#/rules"
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
    case "search":
      return "البحث"
    case "wander":
      return "تجوال"
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
      return "إحصاءات"
    case "favorites":
      return "المختارات"
    case "rules":
      return "قواعد المساجلة"
  }
}

export const useRoute = create<{ route: Route }>()(() => ({ route: HOME }))

export function navigate(r: Route, replace = false): void {
  const hash = routeHash(r)
  if (location.hash === hash) return
  if (replace) {
    history.replaceState(null, "", hash)
    useRoute.setState({ route: parseHash(hash) })
  } else {
    location.hash = hash // fires hashchange → store update
  }
}

/** Parse the current hash, canonicalize it, subscribe. Returns cleanup. */
export function initRouter(): () => void {
  const apply = () => {
    const route = parseHash(location.hash)
    const canonical = routeHash(route)
    if (location.hash !== canonical) history.replaceState(null, "", canonical)
    useRoute.setState({ route })
  }
  apply()
  window.addEventListener("hashchange", apply)
  return () => window.removeEventListener("hashchange", apply)
}
