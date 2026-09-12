/**
 * The native shell shim (docs/roadmap-mobile.md §M1). These run in the WEB
 * configuration (Capacitor reports `web`, so `isNative` is false), which is
 * exactly the surface that must stay byte-for-byte unchanged: no URL rewrite,
 * no headers, no token.
 */

import { describe, expect, it } from "vitest"

import { API_BASE, isNative, nativeHeaders, resolveApiUrl, apiSocketLoc, currentToken } from "./native.ts"
import { deepLinkHash } from "./nativeInit.ts"

describe("platform shim on the web", () => {
  it("is not native, adds no base, no headers, no socket override, no token", () => {
    expect(isNative).toBe(false)
    expect(API_BASE).toBe("")
    expect(resolveApiUrl("/api/meta")).toBe("/api/meta")
    expect(nativeHeaders()).toEqual({})
    expect(apiSocketLoc()).toBeUndefined()
    expect(currentToken()).toBeNull()
  })
})

describe("deepLinkHash", () => {
  const HOST = "qarid.example.com"

  it("maps a room link to its own fragment", () => {
    expect(deepLinkHash(`https://${HOST}/#/room/BADIRU?k=abc`, HOST)).toBe("#/room/BADIRU?k=abc")
  })

  it("accepts only the configured host — there is no second, hard-coded one", () => {
    // The configured host is the ONLY host a deep link is accepted from: there
    // is no second, hard-coded production host any more, so a shell whose API
    // base is localhost refuses a link to anywhere else.
    expect(deepLinkHash("https://qarid.example.com/#/duel", HOST)).toBe("#/duel")
    expect(deepLinkHash("https://qarid.example.com/#/duel", "localhost:6760")).toBeNull()
    expect(deepLinkHash("https://elsewhere.example/#/duel", HOST)).toBeNull()
  })

  it("rejects a foreign host", () => {
    expect(deepLinkHash("https://evil.example/#/room/BADIRU", HOST)).toBeNull()
  })

  it("rejects a link with no app fragment", () => {
    expect(deepLinkHash(`https://${HOST}/poems/q123`, HOST)).toBeNull()
  })

  it("rejects a non-hash fragment", () => {
    expect(deepLinkHash(`https://${HOST}/#not-a-route`, HOST)).toBeNull()
  })

  it("does not throw on a malformed URL", () => {
    expect(deepLinkHash("not a url", HOST)).toBeNull()
  })
})
