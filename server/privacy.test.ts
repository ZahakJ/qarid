import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { renderPrivacy } from "./privacy.ts"

const html = fs.readFileSync(path.join(import.meta.dirname, "..", "client", "public", "privacy.html"), "utf8")

describe("/privacy page", () => {
  it("fills the contact line, escaped", () => {
    const out = renderPrivacy(html, ' a&b@<x>.org ')
    expect(out).toContain("a&amp;b@&lt;x&gt;.org")
    expect(out).not.toContain("{{contact}}")
  })

  it("drops the contact line when unset", () => {
    for (const contact of [undefined, "", "  "]) {
      const out = renderPrivacy(html, contact)
      expect(out).not.toContain("{{contact}}")
      expect(out).not.toContain("data-contact")
    }
  })

  it("carries no placeholder and only Western digits", () => {
    const text = renderPrivacy(html, "x@y.z")
    expect(text).not.toMatch(/[٠-٩۰-۹]/)
    expect(text).not.toMatch(/MATCH_RETENTION|OWNER|TODO/)
  })
})
