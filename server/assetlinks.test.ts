/**
 * The Digital Asset Links route (docs/roadmap-mobile.md §M1) — served so Android
 * can verify the site↔app pairing that makes `#/room/<code>` links open the app.
 */

import { describe, expect, it } from "vitest"

import { ANDROID_CERT_SHA256, ANDROID_PACKAGE } from "./assetlinks.ts"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"

function app() {
  return createApp(loadConfig({ HOST: "127.0.0.1", PORT: "5750", NODE_ENV: "test" } as NodeJS.ProcessEnv), null, null).app
}

describe("/.well-known/assetlinks.json", () => {
  it("serves the statement with the package name and cert fingerprint", async () => {
    const res = await app().request("/.well-known/assetlinks.json")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")

    const body = (await res.json()) as Array<{
      relation: string[]
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] }
    }>
    expect(Array.isArray(body)).toBe(true)
    const stmt = body[0]!
    expect(stmt.relation).toContain("delegate_permission/common.handle_all_urls")
    expect(stmt.target.namespace).toBe("android_app")
    expect(stmt.target.package_name).toBe(ANDROID_PACKAGE)
    expect(stmt.target.sha256_cert_fingerprints).toContain(ANDROID_CERT_SHA256)
  })

  it("uses the app id the Capacitor project ships", () => {
    expect(ANDROID_PACKAGE).toBe("space.avicenna.qarid")
  })

  it("states the fingerprint as colon-separated uppercase hex (asset-links format)", () => {
    expect(ANDROID_CERT_SHA256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  })

  it("is served even without the client bundle, and is not no-store", async () => {
    const res = await app().request("/.well-known/assetlinks.json")
    expect(res.headers.get("cache-control") ?? "").not.toContain("no-store")
  })
})
