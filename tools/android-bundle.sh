#!/usr/bin/env bash
# Release AAB for Google Play. See docs/PLAY.md.
#
#   VITE_API_BASE=https://your.host QARID_APP_ID=com.your.package tools/android-bundle.sh
#
# The web shell is built into app-web/ (gitignored), never into dist/, so a
# server running from this checkout keeps its assets. Signing reads
# android/keystore.properties, else -Pqarid.* gradle properties, else the
# QARID_STORE_FILE / QARID_STORE_PASSWORD / QARID_KEY_ALIAS / QARID_KEY_PASSWORD
# environment. Nothing here prints a secret.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VITE_API_BASE:?set VITE_API_BASE to the deployment the app talks to}"
: "${QARID_APP_ID:?set QARID_APP_ID to the package id (android/identity.properties applicationId)}"
: "${JAVA_HOME:?set JAVA_HOME to a JDK 21}"
: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"

if [ -f android/identity.properties ]; then
  id=$(sed -n 's/^applicationId=//p' android/identity.properties)
  if [ -n "$id" ] && [ "$id" != "$QARID_APP_ID" ]; then
    echo "QARID_APP_ID ($QARID_APP_ID) differs from identity.properties ($id)" >&2
    exit 1
  fi
fi

npx tsc -p tsconfig.json
npx vite build --outDir ../app-web --emptyOutDir
QARID_WEB_DIR=app-web npx cap sync android

(cd android && ./gradlew --no-daemon bundleRelease "$@")

aab=android/app/build/outputs/bundle/release/app-release.aab
host=${VITE_API_BASE#https://}
host=${host#http://}
host=${host%%/*}
if ! unzip -p "$aab" 'base/assets/public/assets/*.js' | grep -q "$host"; then
  echo "the bundle does not name $host — VITE_API_BASE did not reach the build" >&2
  exit 1
fi
if "$JAVA_HOME/bin/jarsigner" -verify "$aab" | grep -q "jar verified"; then
  echo "signed: $aab"
else
  echo "UNSIGNED: $aab — Play refuses it; configure signing (docs/PLAY.md)" >&2
  exit 1
fi
grep -E '^version(Code|Name)=' android/version.properties
