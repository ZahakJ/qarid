# Android

The app is a Capacitor shell around the same client. It talks to a deployment
named at build time.

```sh
cp android/identity.properties.example android/identity.properties   # package id, App-Links host
VITE_API_BASE=https://your.host npm run build
npx cap sync android                         # reads applicationId from identity.properties
cd android && ./gradlew assembleDebug        # app/build/outputs/apk/debug/
```

**Identity.** `android/identity.properties` (gitignored; the keys and what
they mean are in `android/identity.properties.example`) holds `applicationId`
and `appLinkHost`. Gradle and `capacitor.config.ts` both read it; an exported
`QARID_APP_ID` must equal it. Without the file the build uses the
`com.example.qarid` / `qarid.example.com` placeholders, which only a debug
build accepts: every release variant, a build of a commit tagged `v*`, and
`tools/android-bundle.sh` fail under them, and a release also fails when the
synced `capacitor.config.json` names another id. An APK under another package
id does not update the installed app; Android installs it beside it (the
v2.1.2 and v2.1.3 APKs did this).

Release: `android/keystore.properties` with `storeFile`, `storePassword`,
`keyAlias` and `keyPassword`, then `tools/android-bundle.sh` (an AAB for Play;
`QARID_ARTIFACT=apk` for the APK attached to a GitHub release, checked with
`aapt2` for its package id). Without signing the release is unsigned.
`versionCode` in `android/version.properties` goes up with every release.

App Links: set `ANDROID_PACKAGE` and `ANDROID_CERT_SHA256` on the server so
`/.well-known/assetlinks.json` names the app and its signing certificate.
