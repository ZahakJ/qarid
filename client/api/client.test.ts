import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { ApiError, post, qs, request, resetInflight } from "./client.ts"

const Shape = z.object({ ok: z.boolean(), n: z.number() })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  resetInflight()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("request", () => {
  it("parses a good body through the schema", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, n: 3, extra: "stripped" })))
    await expect(request("/api/x", Shape)).resolves.toEqual({ ok: true, n: 3 })
  })

  it("throws a parse ApiError when the body does not match", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: "yes" })))
    await expect(request("/api/x", Shape)).rejects.toMatchObject({ name: "ApiError", kind: "parse" })
  })

  it("maps 503 to corpus_unavailable — the corpus has not been built", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "corpus_unavailable" }, 503)))
    const err = await request("/api/meta", Shape).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ kind: "corpus_unavailable", status: 503, code: "corpus_unavailable" })
  })

  it("carries the server's machine code and message on a 400", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "bad_query", message: "قيمة غير مقبولة" }, 400)))
    const err = (await request("/api/poems", Shape).catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe("http")
    expect(err.code).toBe("bad_query")
    expect(err.message).toBe("قيمة غير مقبولة")
  })

  it("turns a transport failure into a network ApiError with an Arabic message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    const err = (await request("/api/x", Shape).catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe("network")
    expect(/[؀-ۿ]/.test(err.message)).toBe(true)
  })
})

describe("in-flight dedupe", () => {
  it("shares one promise across concurrent identical GETs", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return jsonResponse({ ok: true, n: calls })
      }),
    )
    const [a, b] = await Promise.all([request("/api/x", Shape), request("/api/x", Shape)])
    expect(calls).toBe(1)
    expect(a).toEqual(b)
  })

  it("does not share across different paths", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return jsonResponse({ ok: true, n: calls })
      }),
    )
    await Promise.all([request("/api/x", Shape), request("/api/y", Shape)])
    expect(calls).toBe(2)
  })

  it("releases the key so a later call re-fetches", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return jsonResponse({ ok: true, n: calls })
      }),
    )
    await request("/api/x", Shape)
    await request("/api/x", Shape)
    expect(calls).toBe(2)
  })

  it("never shares a request that carries an AbortSignal", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return jsonResponse({ ok: true, n: calls })
      }),
    )
    const ac = new AbortController()
    await Promise.all([request("/api/x", Shape, { signal: ac.signal }), request("/api/x", Shape, { signal: ac.signal })])
    expect(calls).toBe(2)
  })

  it("does not leave a rejected promise cached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "boom" }, 500)))
    await expect(request("/api/x", Shape)).rejects.toBeInstanceOf(ApiError)
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, n: 1 })))
    await expect(request("/api/x", Shape)).resolves.toEqual({ ok: true, n: 1 })
  })
})

describe("post", () => {
  it("sends JSON and is never deduped", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, n: 1 }))
    vi.stubGlobal("fetch", fetchMock)
    await Promise.all([post("/api/game/verify", Shape, { text: "بيت" }), post("/api/game/verify", Shape, { text: "بيت" })])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.method).toBe("POST")
    expect(init?.body).toBe(JSON.stringify({ text: "بيت" }))
  })
})

describe("qs", () => {
  it("drops empty values and returns a bare path when nothing is left", () => {
    expect(qs("/api/poems", { era: "abbasi", meter: undefined, theme: "", page: 2, famous: false })).toBe(
      "/api/poems?era=abbasi&page=2&famous=false",
    )
    expect(qs("/api/meta", { a: undefined, b: null })).toBe("/api/meta")
  })
})
