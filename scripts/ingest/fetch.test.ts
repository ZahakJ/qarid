/**
 * `fetch.test.ts` — the pinning, without the 277 MB.
 *
 * Nothing here touches the network: `allowDownload:false` is exactly the switch
 * that turns "download the shard" into "throw", and the real shards in
 * `data/raw/` are only read when they happen to be present (they are on the
 * build box, they are not in CI, and the suite must be green either way).
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { SOURCE_DATASET, SOURCE_REVISION } from "../../shared/constants.ts"
import { fetchSources, PINNED_FILES, sha256OfFile, sourceUrl } from "./fetch.ts"

const RAW_DIR = path.resolve(import.meta.dirname, "..", "..", "data", "raw")
const SCRATCH = path.resolve(import.meta.dirname, "..", "..", "data", "test-fetch")

describe("PINNED_FILES", () => {
  it("pins both shards by name, byte length and sha256 (design-server.md §0)", () => {
    expect(PINNED_FILES).toHaveLength(2)
    expect(PINNED_FILES.map((f) => f.name)).toEqual([
      "train-00000-of-00002.parquet",
      "train-00001-of-00002.parquet",
    ])
    expect(PINNED_FILES[0]!.bytes).toBe(126_379_298)
    expect(PINNED_FILES[1]!.bytes).toBe(150_989_177)
    for (const f of PINNED_FILES) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("sourceUrl", () => {
  it("resolves against a pinned revision, never `main`", () => {
    const url = sourceUrl(PINNED_FILES[0]!)
    expect(url).toBe(
      `https://huggingface.co/datasets/${SOURCE_DATASET}/resolve/${SOURCE_REVISION}/data/train-00000-of-00002.parquet`,
    )
    expect(url).not.toContain("/main/")
  })
})

describe("sha256OfFile", () => {
  it("streams the digest", async () => {
    fs.mkdirSync(SCRATCH, { recursive: true })
    const f = path.join(SCRATCH, "probe.bin")
    fs.writeFileSync(f, "قريض")
    try {
      expect(await sha256OfFile(f)).toBe(createHash("sha256").update("قريض").digest("hex"))
    } finally {
      fs.rmSync(SCRATCH, { recursive: true, force: true })
    }
  })
})

describe("fetchSources", () => {
  it("refuses to invent a shard when downloads are disabled", async () => {
    fs.mkdirSync(SCRATCH, { recursive: true })
    try {
      await expect(fetchSources({ dir: SCRATCH, allowDownload: false, log: false })).rejects.toThrow(
        /missing or does not match/,
      )
    } finally {
      fs.rmSync(SCRATCH, { recursive: true, force: true })
    }
  })

  const havePinned = PINNED_FILES.every((f) => fs.existsSync(path.join(RAW_DIR, f.name)))

  it.runIf(havePinned)(
    "verifies the shards already on disk and skips the download",
    async () => {
      const results = await fetchSources({ dir: RAW_DIR, allowDownload: false, log: false })
      expect(results).toHaveLength(2)
      for (const r of results) {
        expect(r.outcome).toBe("verified")
        expect(r.sha256).toBe(r.file.sha256)
        expect(fs.statSync(r.path).size).toBe(r.file.bytes)
      }
    },
    120_000,
  )
})
