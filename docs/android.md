# Android

The app is a Capacitor shell around the same client. It talks to a deployment
named at build time.

```sh
cp android/identity.properties.example android/identity.properties   # package id, App-Links host
VITE_API_BASE=https://your.host npm run build
QARID_APP_ID=com.your.package npx cap sync android
cd android && ./gradlew assembleDebug        # app/build/outputs/apk/debug/
```

Release: `android/keystore.properties` with `storeFile`, `storePassword`,
`keyAlias` and `keyPassword`, then `./gradlew bundleRelease`. Without it the
release is unsigned. `versionCode` in `android/version.properties` goes up with
every release.

App Links: set `ANDROID_PACKAGE` and `ANDROID_CERT_SHA256` on the server so
`/.well-known/assetlinks.json` names the app and its signing certificate.
