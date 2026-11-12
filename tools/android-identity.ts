/**
 * The app's identity, checked before a release is built.
 *
 * The public checkout carries placeholders (`com.example.qarid`,
 * `qarid.example.com`) so it names nobody. They are fine for a debug build and
 * wrong for anything shipped: an APK built under `com.example.qarid` installs
 * beside the real app as a second app instead of updating it, which is what
 * the v2.1.2 and v2.1.3 Android builds did. The real values live in
 * `android/identity.properties` (gitignored; see identity.properties.example).
 *
 *   node tools/android-identity.ts            # before the build
 *   node tools/android-identity.ts --synced   # after `npx cap sync android`
 *
 * Exits 1 with one line per problem. android/app/build.gradle makes the same
 * check on every release variant, so a bare `./gradlew assembleRelease` fails
 * too.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const PLACEHOLDER_APP_ID = "com.example.qarid"
export const PLACEHOLDER_LINK_HOST = "qarid.example.com"

/** `com.example` and anything under it is reserved for examples. */
export function isPlaceholderAppId(id: string | undefined): boolean {
  return !id || id === "com.example" || id.startsWith("com.example.")
}

export function isPlaceholderHost(host: string | undefined): boolean {
  return !host || host === "example.com" || host.endsWith(".example.com")
}

/** Java `.properties`, the subset these files use: `key=value`, `#` comments. */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith("!")) continue
    const at = line.search(/[=:]/)
    if (at < 0) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

export type IdentityInputs = {
  /** android/identity.properties, or null when the file is absent. */
  identity: Record<string, string> | null
  /** QARID_APP_ID, which capacitor.config.ts reads. */
  envAppId?: string | undefined
  /** appId of the synced android/app/src/main/assets/capacitor.config.json. */
  syncedAppId?: string | undefined
}

/** Everything that makes these inputs unfit for a release; empty when fit. */
export function releaseIdentityProblems({ identity, envAppId, syncedAppId }: IdentityInputs): string[] {
  const problems: string[] = []
  const appId = identity?.applicationId
  if (!identity) {
    problems.push(
      "android/identity.properties is missing: a release would be built as " +
        `${PLACEHOLDER_APP_ID} (copy identity.properties.example and fill it in)`,
    )
  } else if (isPlaceholderAppId(appId)) {
    problems.push(`applicationId is the placeholder ${appId || "(empty)"} in android/identity.properties`)
  }
  if (identity && isPlaceholderHost(identity.appLinkHost)) {
    problems.push(`appLinkHost is the placeholder ${identity.appLinkHost || "(empty)"} in android/identity.properties`)
  }
  if (envAppId !== undefined && envAppId !== "") {
    if (isPlaceholderAppId(envAppId)) problems.push(`QARID_APP_ID is the placeholder ${envAppId}`)
    else if (appId && envAppId !== appId) {
      problems.push(`QARID_APP_ID (${envAppId}) differs from identity.properties applicationId (${appId})`)
    }
  }
  if (syncedAppId !== undefined) {
    if (isPlaceholderAppId(syncedAppId)) {
      problems.push(`the synced capacitor.config.json has appId ${syncedAppId}: run cap sync with QARID_APP_ID set`)
    } else if (appId && syncedAppId !== appId) {
      problems.push(`the synced capacitor.config.json has appId ${syncedAppId}, applicationId is ${appId}`)
    }
  }
  return problems
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

/** Reads the real files under `root` (the repository). */
export function checkCheckout(root: string, env: NodeJS.ProcessEnv, synced: boolean): string[] {
  const identityText = readIfExists(path.join(root, "android", "identity.properties"))
  let syncedAppId: string | undefined
  if (synced) {
    const json = readIfExists(path.join(root, "android", "app", "src", "main", "assets", "capacitor.config.json"))
    syncedAppId = json ? String((JSON.parse(json) as { appId?: unknown }).appId ?? "") : ""
  }
  return releaseIdentityProblems({
    identity: identityText === null ? null : parseProperties(identityText),
    envAppId: env.QARID_APP_ID,
    syncedAppId,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const problems = checkCheckout(root, process.env, process.argv.includes("--synced"))
  for (const p of problems) console.error(`release identity: ${p}`)
  process.exit(problems.length ? 1 : 0)
}
