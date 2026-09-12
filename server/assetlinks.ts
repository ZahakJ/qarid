/**
 * Digital Asset Links (docs/roadmap-mobile.md §M1) — the file Android fetches
 * from `https://qarid.example.com/.well-known/assetlinks.json` to VERIFY that
 * this site and the قريض app belong together, so a
 * `https://qarid.example.com/#/room/<code>` link opens the app directly
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

/**
 * Your app's identity, both from the environment because both are specific to
 * whoever builds and signs the APK — neither belongs in a public checkout.
 *
 *   ANDROID_PACKAGE    the Capacitor `appId`, e.g. com.example.qarid
 *   ANDROID_CERT_SHA256  SHA-256 of the RELEASE signing certificate,
 *                        colon-separated uppercase hex, exactly as
 *                        `apksigner verify --print-certs` (or `keytool -list
 *                        -v`) prints it
 *
 * Left unset, the statement still serializes — with the placeholders below —
 * and Android simply fails to verify the link, falling back to the browser.
 * That is the correct behaviour for a checkout that has no app: a wrong
 * fingerprint and a missing one both mean "not my app", and neither is worth
 * refusing to boot over.
 */
export const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE ?? "com.example.qarid"

export const ANDROID_CERT_SHA256 =
  process.env.ANDROID_CERT_SHA256 ?? "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00"

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
