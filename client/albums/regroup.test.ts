/**
 * Re-seating a restored قصيدة. The shelf's order is the one thing in a ديوان
 * the reader made by hand, so the rule under test is that restoring a قصيدة
 * disturbs NOTHING else — not the other rows' order, not their neighbours.
 */
import { describe, expect, it } from "vitest"

import { poemAnchors, regroupPoem, sameOrder } from "./regroup.ts"

describe("regroupPoem", () => {
  it("gathers a scattered قصيدة at the seat its earliest بيت held", () => {
    // x = other قصائد. The قصيدة's own أبيات are p1..p4, and the add appended
    // p2 and p4 to the end of the shelf.
    const order = ["x1", "p1", "x2", "p3", "x3", "p2", "p4"]
    expect(regroupPoem(order, ["p1", "p2", "p3", "p4"])).toEqual(["x1", "p1", "p2", "p3", "p4", "x2", "x3"])
  })

  it("puts them in the قصيدة's order, not the shelf's", () => {
    const order = ["p3", "p1", "p2"]
    expect(regroupPoem(order, ["p1", "p2", "p3"])).toEqual(["p1", "p2", "p3"])
  })

  it("leaves every other row's relative order alone", () => {
    const order = ["a", "p2", "b", "c", "p1", "d"]
    const out = regroupPoem(order, ["p1", "p2"])
    expect(out.filter((x) => !x.startsWith("p"))).toEqual(["a", "b", "c", "d"])
  })

  it("seats the block where the قصيدة already was, not at the end", () => {
    const order = ["a", "b", "p1", "c", "p2"]
    expect(regroupPoem(order, ["p1", "p2"])).toEqual(["a", "b", "p1", "p2", "c"])
  })

  it("keeps a قصيدة that opens the shelf at the top", () => {
    const order = ["p1", "a", "p2"]
    expect(regroupPoem(order, ["p1", "p2"])).toEqual(["p1", "p2", "a"])
  })

  it("never invents a row: an anchor not on the shelf is ignored", () => {
    // The add truncates at the bulk cap and the artefact may not hold every
    // بيت, so the قصيدة's order can name أبيات that never landed.
    const order = ["a", "p1"]
    expect(regroupPoem(order, ["p1", "p2-never-added"])).toEqual(["a", "p1"])
  })

  it("is a no-op when none of the قصيدة is on the shelf", () => {
    const order = ["a", "b"]
    expect(regroupPoem(order, ["p1"])).toEqual(["a", "b"])
  })

  it("handles a shelf that is one whole قصيدة", () => {
    expect(regroupPoem(["p2", "p1"], ["p1", "p2"])).toEqual(["p1", "p2"])
  })

  it("loses nothing and duplicates nothing, whatever the arrangement", () => {
    const order = ["x1", "p1", "x2", "p3", "x3", "p2", "p4", "x4"]
    const out = regroupPoem(order, ["p1", "p2", "p3", "p4"])
    expect(out).toHaveLength(order.length)
    expect([...out].sort()).toEqual([...order].sort())
  })
})

describe("sameOrder", () => {
  it("spots an arrangement that did not move, so no request is sent", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true)
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false)
    expect(sameOrder(["a"], ["a", "b"])).toBe(false)
  })
})

describe("poemAnchors", () => {
  const shelf = [
    { hFull: "a", bait: { poem: { id: "788" } } },
    { hFull: "b", bait: { poem: { id: "790" } } },
    { hFull: "c", bait: { poem: { id: "788" } } },
    { hFull: "d", bait: null },
  ]

  it("takes only the قصيدة asked for", () => {
    // «أزِل القصيدة كلها» is built on this: one wrong id and it prunes a
    // قصيدة the reader never named.
    expect(poemAnchors(shelf, "788")).toEqual(["a", "c"])
    expect(poemAnchors(shelf, "790")).toEqual(["b"])
  })

  it("keeps the shelf's order", () => {
    expect(poemAnchors(shelf, "788")).toEqual(["a", "c"])
  })

  it("never sweeps up a بيت the artefact cannot resolve", () => {
    // A dead entry belongs to no nameable قصيدة, so no قصيدة-level act may
    // take it — it is still the curator's row, and only ✕ removes it.
    expect(poemAnchors(shelf, "788")).not.toContain("d")
    expect(poemAnchors(shelf, "790")).not.toContain("d")
  })

  it("is empty for a قصيدة that is not on the shelf", () => {
    expect(poemAnchors(shelf, "999")).toEqual([])
  })
})
