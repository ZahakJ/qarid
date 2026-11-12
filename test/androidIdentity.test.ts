/**
 * `tools/android-identity.ts` — a release is refused under the placeholder
 * identity (the v2.1.2 / v2.1.3 Android builds shipped as com.example.qarid).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  checkCheckout,
  isPlaceholderAppId,
  parseProperties,
  releaseIdentityProblems,
} from "../tools/android-identity.ts"

const REAL = { applicationId: "org.acme.qarid", appLinkHost: "qarid.acme.org" }

describe("releaseIdentityProblems", () => {
  it("accepts a real identity with matching QARID_APP_ID and synced config", () => {
    expect(
      releaseIdentityProblems({ identity: REAL, envAppId: "org.acme.qarid", syncedAppId: "org.acme.qarid" }),
    ).toEqual([])
  })

  it("refuses a checkout without identity.properties", () => {
    expect(releaseIdentityProblems({ identity: null }).join()).toMatch(/identity\.properties is missing/)
  })

  it("refuses the placeholder package and host", () => {
    const problems = releaseIdentityProblems({
      identity: { applicationId: "com.example.qarid", appLinkHost: "qarid.example.com" },
    })
    expect(problems).toHaveLength(2)
    expect(problems.join()).toMatch(/com\.example\.qarid/)
    expect(problems.join()).toMatch(/qarid\.example\.com/)
  })

  it("refuses a placeholder or mismatched QARID_APP_ID", () => {
    expect(releaseIdentityProblems({ identity: REAL, envAppId: "com.example.qarid" })).toHaveLength(1)
    expect(releaseIdentityProblems({ identity: REAL, envAppId: "org.other.qarid" }).join()).toMatch(/differs/)
  })

  it("refuses a sync made without QARID_APP_ID", () => {
    expect(releaseIdentityProblems({ identity: REAL, syncedAppId: "com.example.qarid" }).join()).toMatch(
      /cap sync with QARID_APP_ID/,
    )
    expect(releaseIdentityProblems({ identity: REAL, syncedAppId: "" })).toHaveLength(1)
  })
})

describe("helpers", () => {
  it("treats com.example and its children as placeholders", () => {
    expect(isPlaceholderAppId("com.example")).toBe(true)
    expect(isPlaceholderAppId("com.example.qarid")).toBe(true)
    expect(isPlaceholderAppId(undefined)).toBe(true)
    expect(isPlaceholderAppId("com.examples.qarid")).toBe(false)
  })

  it("parses the example file", () => {
    const text = fs.readFileSync(path.join(import.meta.dirname,"..", "android", "identity.properties.example"), "utf8")
    expect(parseProperties(text)).toEqual({ applicationId: "com.example.qarid", appLinkHost: "qarid.example.com" })
  })
})

describe("checkCheckout", () => {
  let dir = ""
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  const tree = (identity: string | null, synced?: string) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qarid-identity-"))
    const assets = path.join(dir, "android", "app", "src", "main", "assets")
    fs.mkdirSync(assets, { recursive: true })
    if (identity !== null) fs.writeFileSync(path.join(dir, "android", "identity.properties"), identity)
    if (synced !== undefined) fs.writeFileSync(path.join(assets, "capacitor.config.json"), JSON.stringify({ appId: synced }))
    return dir
  }

  it("passes a configured checkout", () => {
    const root = tree("applicationId=org.acme.qarid\nappLinkHost=qarid.acme.org\n", "org.acme.qarid")
    expect(checkCheckout(root, { QARID_APP_ID: "org.acme.qarid" }, true)).toEqual([])
  })

  it("fails a fresh clone", () => {
    expect(checkCheckout(tree(null, "com.example.qarid"), {}, true)).toHaveLength(2)
  })
})
