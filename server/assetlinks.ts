/**
 * Digital Asset Links (docs/roadmap-mobile.md §M1) — the file Android fetches
 * from `https://qarid.avicenna.space/.well-known/assetlinks.json` to VERIFY that
 * this site and the قريض app belong together, so a
 * `https://qarid.avicenna.space/#/room/<code>` link opens the app directly
 * (`android:autoVerify` on the intent-filter) instead of the browser.
 *
 * The statement names the app's package and the SHA-256 fingerprint of the
 * RELEASE signing certificate in `~/keystores/qarid-release.keystore`. If the
 * app is ever re-signed with a different key, this fingerprint must change to
 * match or verification fails silently (the link falls back to the browser).
 *
 * It is a constant, not derived from anything at runtime — there is no keystore
 * on the server — so it is stated here and asserted by `assetlinks.test` against
 * the same source of truth the build uses.
 */

/** The Android package id — must equal Capacitor's `appId`. */
export const ANDROID_PACKAGE = "space.avicenna.qarid"

/**
 * SHA-256 of the release signing cert, colon-separated uppercase hex, exactly
 * as `keytool -list -v` / `apksigner verify --print-certs` report it.
 */
export const ANDROID_CERT_SHA256 =
  "8C:05:1E:14:92:22:E1:4F:9A:B2:2D:79:16:4D:CC:32:9C:73:4B:EA:65:62:9B:A6:75:43:F6:B9:2F:CB:EA:E5"

/** The full Digital Asset Links statement list, ready to serialize. */
export const ASSETLINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: ANDROID_PACKAGE,
      sha256_cert_fingerprints: [ANDROID_CERT_SHA256],
    },
  },
] as const
