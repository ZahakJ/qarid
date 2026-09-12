/**
 * Keep the screen awake during a live duel turn (docs/roadmap-mobile.md §M1).
 * A مساجلة turn is read, thought about, and typed — long enough for the display
 * to sleep — so the play view asks to stay awake while it is mounted and lets
 * the screen sleep again when it leaves. No-op on the web.
 */

import { isNative } from "./native.ts"

export async function keepAwake(): Promise<void> {
  if (!isNative) return
  try {
    const { KeepAwake } = await import("@capacitor-community/keep-awake")
    await KeepAwake.keepAwake()
  } catch {
    /* the plugin is a nicety; a turn plays fine without it */
  }
}

export async function allowSleep(): Promise<void> {
  if (!isNative) return
  try {
    const { KeepAwake } = await import("@capacitor-community/keep-awake")
    await KeepAwake.allowSleep()
  } catch {
    /* best effort */
  }
}
