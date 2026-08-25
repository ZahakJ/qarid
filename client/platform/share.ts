/**
 * Native share sheet (docs/roadmap-mobile.md §M1).
 *
 * The web app already reaches the OS share sheet through `navigator.share`, but
 * a Capacitor WebView does not expose file sharing through the Web Share API,
 * so these helpers route through `@capacitor/share` instead. An image is first
 * written to the app's cache directory (Share can only take a `file://` URI,
 * not a blob) and handed over by URI; text goes straight through.
 *
 * Both return `false` on the web or on any failure, so the caller falls back to
 * its existing clipboard / download / `navigator.share` path unchanged.
 */

import { isNative } from "./native.ts"

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!)
  return btoa(binary)
}

/** Share a PNG (or any) blob through the native sheet. `false` → not handled. */
export async function nativeShareFile(blob: Blob, filename: string, title = "قريض"): Promise<boolean> {
  if (!isNative) return false
  try {
    const { Filesystem, Directory } = await import("@capacitor/filesystem")
    const { Share } = await import("@capacitor/share")
    const data = await blobToBase64(blob)
    await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache })
    const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache })
    await Share.share({ title, files: [uri] })
    return true
  } catch {
    return false
  }
}

/** Share plain text (the daily block) through the native sheet. */
export async function nativeShareText(text: string, title = "قريض"): Promise<boolean> {
  if (!isNative) return false
  try {
    const { Share } = await import("@capacitor/share")
    await Share.share({ title, text })
    return true
  } catch {
    return false
  }
}
