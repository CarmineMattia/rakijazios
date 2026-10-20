#!/usr/bin/env bash
# Build the Rakijazios TWA debug APK (android/twa). Needs JDK 17, Gradle 8.14+
# and an Android SDK with platform 36 (ANDROID_HOME). Used by
# .github/workflows/android.yml; also runs on any Linux box.
#
#   scripts/android-twa-build.sh                      # placeholder host
#   RAKIJAZIOS_TWA_HOST=rakijazios.<domain> scripts/android-twa-build.sh
#
# Output: android/twa/app/build/outputs/apk/debug/app-debug.apk
# Debug builds are signed with the machine's own ~/.android/debug.keystore,
# never with a key from this repo.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:?set ANDROID_HOME to an Android SDK (platform 36, build-tools 36)}"
command -v java >/dev/null || { echo "java (JDK 17) not found" >&2; exit 1; }
GRADLE="${GRADLE:-gradle}"
"$GRADLE" --no-daemon -p android/twa assembleDebug "$@"
APK=android/twa/app/build/outputs/apk/debug/app-debug.apk
test -s "$APK"
echo "APK: $APK"
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
"$BT/apksigner" verify --print-certs "$APK" | grep -i 'SHA-256' || true
