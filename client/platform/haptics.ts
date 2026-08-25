/**
 * Haptic feedback for the duel (docs/roadmap-mobile.md §M1). Each helper is a
 * no-op on the web and a single native buzz in the Capacitor shell; the plugin
 * is dynamically imported so it never weighs on the web bundle, and every call
 * is fire-and-forget — a missing vibrator must never break a turn.
 */

import { isNative } from "./native.ts"

async function impact(style: "Light" | "Medium" | "Heavy"): Promise<void> {
  if (!isNative) return
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics")
    await Haptics.impact({ style: ImpactStyle[style] })
  } catch {
    /* no vibrator, or the plugin is absent — feedback is a nicety */
  }
}

async function notify(type: "Success" | "Warning" | "Error"): Promise<void> {
  if (!isNative) return
  try {
    const { Haptics, NotificationType } = await import("@capacitor/haptics")
    await Haptics.notification({ type: NotificationType[type] })
  } catch {
    /* best effort */
  }
}

/** An accepted بيت — a satisfied success buzz. */
export function hapticAccept(): void {
  void notify("Success")
}

/** A refused answer (wrong letter, not found, near miss) — a warning buzz. */
export function hapticReject(): void {
  void notify("Warning")
}

/** The turn clock ran out — the heaviest, most final feedback. */
export function hapticTimeout(): void {
  void notify("Error")
}

/** A light tick for an ordinary tap where one helps (kept for callers). */
export function hapticTick(): void {
  void impact("Light")
}
