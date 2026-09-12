/**
 * `fetch.ts` — get the two `arbml/ashaar` shards onto disk and PROVE they are
 * the ones design-server.md §0 pinned (design-server.md §6).
 *
 * The revision, the byte sizes and the sha256 digests are all pinned. Both
 * files are already in `data/raw/`, so the normal outcome of running this is
 * "verified, skipped" — the download path exists for a fresh clone and for the
 * day someone deletes the directory, and it is idempotent: a partial download
 * lands on `<name>.part` and is only renamed into place after its digest
 * matches, so an interrupted run never leaves a plausible-looking bad shard.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"

import { SOURCE_DATASET, SOURCE_REVISION } from "../../shared/constants.ts"

export interface PinnedFile {
  name: string
  bytes: number
  sha256: string
}

/** design-server.md §0, measured — do not edit without re-measuring. */
export const PINNED_FILES: readonly PinnedFile[] = [
  {
    name: "train-00000-of-00002.parquet",
    bytes: 126_379_298,
    sha256: "75cffe4e2fb5a44855eba3ed695fbdd8931b6d9e36f22f413466ff5574d6a467",
  },
  {
    name: "train-00001-of-00002.parquet",
    bytes: 150_989_177,
    sha256: "6a5ff88137ce13653ef042d09a108b1ea6f7dfa5e221c9ec3abe92b6bd5cc04c",
  },
]

/** The HuggingFace `resolve/<revision>` url — pinned to a commit, never `main`. */
export function sourceUrl(file: PinnedFile, revision = SOURCE_REVISION): string {
  return `https://huggingface.co/datasets/${SOURCE_DATASET}/resolve/${revision}/data/${file.name}`
}

export type FetchOutcome = "verified" | "downloaded" | "repaired"

export interface FetchResult {
  file: PinnedFile
  path: string
  outcome: FetchOutcome
  sha256: string
}

export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest("hex")
}

/**
 * Verify what is on disk; download only what is missing or wrong.
 *
 * `allowDownload:false` (the default under test) turns a missing or corrupt
 * shard into a thrown error instead of 277 MB of network traffic.
 */
export async function fetchSources(options: {
  dir: string
  revision?: string
  allowDownload?: boolean
  log?: boolean
} = { dir: "data/raw" }): Promise<FetchResult[]> {
  const { dir, revision = SOURCE_REVISION, allowDownload = true, log = true } = options
  const say = (m: string) => {
    if (log) console.log(`[fetch] ${m}`)
  }
  fs.mkdirSync(dir, { recursive: true })

  const results: FetchResult[] = []
  for (const file of PINNED_FILES) {
    const dest = path.join(dir, file.name)
    let outcome: FetchOutcome = "verified"

    if (fs.existsSync(dest)) {
      const size = fs.statSync(dest).size
      const digest = await sha256OfFile(dest)
      if (size === file.bytes && digest === file.sha256) {
        say(`${file.name} — verified (${digest.slice(0, 12)}…), skipping download`)
        results.push({ file, path: dest, outcome, sha256: digest })
        continue
      }
      say(`${file.name} — MISMATCH (${size} B, ${digest.slice(0, 12)}…), refetching`)
      outcome = "repaired"
    } else {
      outcome = "downloaded"
    }

    if (!allowDownload) {
      throw new Error(
        `fetch: ${dest} is missing or does not match the pinned sha256 and downloads are disabled`,
      )
    }
    const digest = await download(sourceUrl(file, revision), dest, file, say)
    results.push({ file, path: dest, outcome, sha256: digest })
  }
  return results
}

/** `.part` + atomic rename, and the digest is checked BEFORE the rename. */
async function download(url: string, dest: string, file: PinnedFile, say: (m: string) => void): Promise<string> {
  const part = `${dest}.part`
  fs.rmSync(part, { force: true })
  say(`downloading ${file.name} (${(file.bytes / 1024 / 1024).toFixed(0)} MB) from ${url}`)

  const res = await fetch(url)
  if (!res.ok || res.body === null) {
    throw new Error(`fetch: ${url} answered ${res.status} ${res.statusText}`)
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(part))

  const size = fs.statSync(part).size
  const digest = await sha256OfFile(part)
  if (size !== file.bytes || digest !== file.sha256) {
    fs.rmSync(part, { force: true })
    throw new Error(
      `fetch: ${file.name} verification failed — got ${size} B / ${digest}, expected ${file.bytes} B / ${file.sha256}`,
    )
  }
  fs.renameSync(part, dest)
  say(`${file.name} — downloaded and verified`)
  return digest
}
