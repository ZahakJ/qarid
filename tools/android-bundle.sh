#!/usr/bin/env bash
# Release AAB for Google Play, or with QARID_ARTIFACT=apk the signed APK
# attached to a GitHub release. See docs/PLAY.md.
#
#   VITE_API_BASE=https://your.host QARID_APP_ID=com.your.package tools/android-bundle.sh
#   QARID_ARTIFACT=apk VITE_API_BASE=… QARID_APP_ID=… tools/android-bundle.sh
#
# The web shell is built into app-web/ (gitignored), never into dist/, so a
# server running from this checkout keeps its assets. Signing reads
# android/keystore.properties, else -Pqarid.* gradle properties, else the
# QARID_STORE_FILE / QARID_STORE_PASSWORD / QARID_KEY_ALIAS / QARID_KEY_PASSWORD
# environment. Nothing here prints a secret.
#
# The identity comes from android/identity.properties (see
# identity.properties.example). The script refuses to build without it, under
# the com.example placeholder, or when QARID_APP_ID disagrees with it; the
# v2.1.2 and v2.1.3 APKs were built without it and shipped as com.example.qarid.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VITE_API_BASE:?set VITE_API_BASE to the deployment the app talks to}"
: "${QARID_APP_ID:?set QARID_APP_ID to the package id (android/identity.properties applicationId)}"
: "${JAVA_HOME:?set JAVA_HOME to a JDK 21}"
: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"
artifact=${QARID_ARTIFACT:-aab}
case "$artifact" in aab | apk) ;; *) echo "QARID_ARTIFACT must be aab or apk" >&2; exit 1 ;; esac

node tools/android-identity.ts

npx tsc -p tsconfig.json
npx vite build --outDir ../app-web --emptyOutDir
QARID_WEB_DIR=app-web npx cap sync android
node tools/android-identity.ts --synced

host=${VITE_API_BASE#https://}
host=${host#http://}
host=${host%%/*}

if [ "$artifact" = aab ]; then
  (cd android && ./gradlew --no-daemon bundleRelease "$@")
  out=android/app/build/outputs/bundle/release/app-release.aab
  # Count rather than `grep -q`: an early exit would SIGPIPE unzip under pipefail.
  if [ "$(unzip -p "$out" 'base/assets/public/assets/*.js' | grep -c "$host")" -eq 0 ]; then
    echo "the bundle does not name $host — VITE_API_BASE did not reach the build" >&2
    exit 1
  fi
  # The bundle's manifest is protobuf; the package id is in it as plain bytes.
  if [ "$(unzip -p "$out" base/manifest/AndroidManifest.xml | grep -ac "$QARID_APP_ID")" -eq 0 ]; then
    echo "the bundle's manifest does not name $QARID_APP_ID" >&2
    exit 1
  fi
  if [ "$("$JAVA_HOME/bin/jarsigner" -verify "$out" | grep -c "jar verified")" -gt 0 ]; then
    echo "signed: $out"
  else
    echo "UNSIGNED: $out — Play refuses it; configure signing (docs/PLAY.md)" >&2
    exit 1
  fi
else
  (cd android && ./gradlew --no-daemon assembleRelease "$@")
  out=android/app/build/outputs/apk/release/app-release.apk
  if [ ! -f "$out" ]; then
    echo "no signed APK at $out — configure signing (docs/PLAY.md)" >&2
    exit 1
  fi
  if [ "$(unzip -p "$out" 'assets/public/assets/*.js' | grep -c "$host")" -eq 0 ]; then
    echo "the APK does not name $host — VITE_API_BASE did not reach the build" >&2
    exit 1
  fi
  tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)
  package=$("$tools/aapt2" dump packagename "$out")
  if [ "$package" != "$QARID_APP_ID" ]; then
    echo "the APK is $package, not $QARID_APP_ID" >&2
    exit 1
  fi
  "$tools/apksigner" verify --print-certs "$out" | grep -E 'SHA-256'
  echo "signed: $out ($package)"
fi
grep -E '^version(Code|Name)=' android/version.properties
