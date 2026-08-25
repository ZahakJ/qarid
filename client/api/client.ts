/**
 * The ONLY door to the API. Every response is parsed through its zod schema
 * from shared/schema.ts, so a server that drifts fails loudly here instead of
 * quietly rendering `undefined` into a بيت. No ad-hoc `fetch` anywhere else in
 * the client (design-ux.md §6).
 *
 * Three jobs:
 *  1. parse — `request(path, Schema)` returns the schema's OUTPUT type.
 *  2. dedupe — concurrent identical GETs (two panels, one facet count) share
 *     one in-flight promise, keyed by method+path+body.
 *  3. errors — everything non-2xx, unparseable, or aborted becomes an
 *     `ApiError` carrying an Arabic `message` a view can render as-is.
 */
import type { z } from "zod"
import { ApiErrorSchema } from "../../shared/schema.ts"
import { nativeHeaders, resolveApiUrl } from "../platform/native.ts"

export type ApiErrorKind =
  | "network" /* offline, DNS, connection reset */
  | "http" /* 4xx/5xx with a body */
  | "corpus_unavailable" /* 503 — data/qarid.db has not been built */
  | "parse" /* 2xx whose body did not match the schema */
  | "aborted" /* the view navigated away */

/** One error type for the whole client; `message` is display-ready Arabic. */
export class ApiError extends Error {
  kind: ApiErrorKind
  status: number
  /** server-supplied machine code, e.g. `bad_query`, `not_found` */
  code: string | null
  path: string

  constructor(kind: ApiErrorKind, message: string, path: string, status = 0, code: string | null = null) {
    super(message)
    this.name = "ApiError"
    this.kind = kind
    this.status = status
    this.code = code
    this.path = path
  }
}

const ARABIC_MESSAGE: Record<ApiErrorKind, string> = {
  network: "تعذّر الاتصال بالخادم",
  http: "تعذّر تنفيذ الطلب",
  corpus_unavailable: "الديوان غير متاح الآن",
  parse: "وصل ردٌّ غير مفهوم من الخادم",
  aborted: "أُلغي الطلب",
}

/**
 * Arabic for the server's machine codes.
 *
 * `server/query.ts` answers a 404 as `{error:'not_found', message:'poem'}` —
 * `message` there is the internal RESOURCE NAME, for a log, not for a reader.
 * Rendered straight it put a lone Latin «poem» in the middle of an all-Arabic
 * page. Any `message` that is not Arabic is dropped on the floor
 * (`arabicOnly`) and the code's own Arabic stands in for it.
 */
const ARABIC_CODE: Record<string, string> = {
  not_found: "لا شيء بهذا المعرّف في الديوان",
  bad_request: "طلب غير مفهوم",
  bad_query: "قيد غير مقبول في الطلب",
  corpus_unavailable: "الديوان غير متاح الآن",
}

const ARABIC_RE = /[\u0600-\u06ff]/

/** The server's own `message`, but only when it is written for a reader. */
function arabicOnly(detail: string | undefined): string | undefined {
  return detail && ARABIC_RE.test(detail) ? detail : undefined
}

/** In-flight GETs keyed by method+path — a second caller joins the first. */
const inflight = new Map<string, Promise<unknown>>()

function keyOf(path: string, init?: RequestInit): string {
  const method = (init?.method ?? "GET").toUpperCase()
  const body = typeof init?.body === "string" ? init.body : ""
  return `${method} ${path} ${body}`
}

/** Requests carrying an AbortSignal are never shared — one owner, one abort. */
function dedupable(init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase()
  return method === "GET" && !init?.signal
}

async function run<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    // In the native shell `resolveApiUrl` prefixes the deployment origin and
    // `nativeHeaders` adds the bearer + `X-Client`; both are no-ops on the web,
    // so the same-origin cookie flow is unchanged (platform/native.ts).
    res = await fetch(resolveApiUrl(path), {
      ...init,
      headers: { Accept: "application/json", ...nativeHeaders(), ...(init?.headers ?? {}) },
    })
  } catch (err) {
    if (init?.signal?.aborted) throw new ApiError("aborted", ARABIC_MESSAGE.aborted, path)
    throw new ApiError("network", ARABIC_MESSAGE.network, path, 0, err instanceof Error ? err.name : null)
  }

  if (!res.ok) {
    let code: string | null = null
    let detail: string | undefined
    try {
      const parsed = ApiErrorSchema.safeParse(await res.json())
      if (parsed.success) {
        code = parsed.data.error
        detail = parsed.data.message
      }
    } catch {
      /* non-JSON error body — status alone has to do */
    }
    const kind: ApiErrorKind = res.status === 503 ? "corpus_unavailable" : "http"
    // the server's own text wins when it was written for a reader; otherwise
    // the code's Arabic, and only then the generic line for the kind
    const message = arabicOnly(detail) ?? (code ? ARABIC_CODE[code] : undefined) ?? ARABIC_MESSAGE[kind]
    throw new ApiError(kind, message, path, res.status, code)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new ApiError("parse", ARABIC_MESSAGE.parse, path, res.status)
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    console.error(`qarid: ${path} failed schema validation`, parsed.error)
    throw new ApiError("parse", ARABIC_MESSAGE.parse, path, res.status)
  }
  return parsed.data
}

/**
 * `request('/api/meta', MetaResponseSchema)` → typed, validated body.
 * Pass `init.signal` (AbortController per view) to opt out of dedupe.
 */
export function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  if (!dedupable(init)) return run(path, schema, init)
  const key = keyOf(path, init)
  const existing = inflight.get(key) as Promise<T> | undefined
  if (existing) return existing
  const p = run(path, schema, init).finally(() => {
    if (inflight.get(key) === p) inflight.delete(key)
  })
  inflight.set(key, p)
  return p
}

/** POST JSON (the three /api/game routes). Never deduped. */
export function post<T>(path: string, schema: z.ZodType<T>, body: unknown, init?: RequestInit): Promise<T> {
  return run(path, schema, {
    ...init,
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  })
}

/** Build `/api/x?a=1&b=2`, dropping undefined/null/empty values. */
export function qs(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `${path}?${s}` : path
}

/** Test seam / hard reset — drops every shared in-flight promise. */
export function resetInflight(): void {
  inflight.clear()
}
