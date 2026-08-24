import { describe, it, expect } from "vitest"
import { loadConfig } from "./config.ts"
import { createApp } from "./app.ts"

const config = loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test" } as NodeJS.ProcessEnv)

describe("loadConfig", () => {
  it("defaults to the prod port and the repo-local database", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv)
    expect(c.host).toBe("127.0.0.1")
    expect(c.port).toBe(8010)
    expect(c.publicOrigin).toBe("https://qarid.avicenna.space")
    expect(c.dbPath.endsWith("/data/qarid.db")).toBe(true)
    expect(c.dev).toBe(true)
  })

  it("honours the env overrides", () => {
    const c = loadConfig({ HOST: "::1", PORT: "5750", DB_PATH: "/x/y.db", PUBLIC_ORIGIN: "http://localhost:6750", NODE_ENV: "production" } as NodeJS.ProcessEnv)
    expect(c).toMatchObject({ host: "::1", port: 5750, dbPath: "/x/y.db", publicOrigin: "http://localhost:6750", dev: false })
  })
})

describe("createApp without a corpus", () => {
  const { app } = createApp(config, null)

  it("serves /healthz", async () => {
    const res = await app.request("/healthz")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  it("sets the baseline security headers on every response", async () => {
    const res = await app.request("/healthz")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin")
  })

  it("puts a CSP with font-src 'self' data: on html responses", async () => {
    const res = await app.request("/")
    const csp = res.headers.get("Content-Security-Policy")
    // "/" is html only once dist/ exists; when it does, the CSP must be there
    if ((res.headers.get("content-type") ?? "").includes("text/html")) {
      expect(csp).toContain("font-src 'self' data:")
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
    } else {
      expect(res.status).toBe(200)
    }
  })

  it("answers 503 on /api/* rather than crashing", async () => {
    const res = await app.request("/api/meta")
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "corpus_unavailable" })
  })
})

describe("createApp with a corpus handle", () => {
  // A stub is enough here: Phase 0 mounts no routes yet, so all we assert is
  // that the 503 guard lifts and unknown /api paths 404 instead of returning
  // the SPA shell (a JSON client must never be handed html).
  const stub = { raw: {}, q: () => ({}), close: () => {} } as unknown as Parameters<typeof createApp>[1]
  const { app } = createApp(config, stub)

  it("404s unknown /api routes", async () => {
    const res = await app.request("/api/definitely-not-a-route")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not_found" })
  })

  it("still serves /healthz", async () => {
    expect(await (await app.request("/healthz")).text()).toBe("ok")
  })
})
