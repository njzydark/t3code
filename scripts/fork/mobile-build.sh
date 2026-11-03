#!/usr/bin/env bash
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
root="$(cd "$(dirname "$0")/../.." && pwd)"
mobile="$root/apps/mobile"
helper="$root/scripts/fork/mobile-native.py"
platform="${1:-}"
[[ "$platform" == ios || "$platform" == android ]] || fail 'Usage: mobile-build.sh ios|android'
[[ "${GITHUB_ACTIONS:-}" == true ]] || fail 'Run this script in the disposable fork-mobile workflow, not a live checkout.'
[[ "${MOBILE_BUILD_NUMBER:-}" =~ ^[1-9][0-9]{0,9}$ ]] || fail 'MOBILE_BUILD_NUMBER must be a positive integer without leading zeros.'
(( MOBILE_BUILD_NUMBER <= 2100000000 )) || fail 'MOBILE_BUILD_NUMBER exceeds Android versionCode maximum 2100000000.'
[[ -z "$(git -C "$root" ls-files "apps/mobile/$platform")" ]] || fail 'Refusing to overwrite tracked native files.'

export APP_VARIANT=production T3CODE_MOBILE_UPDATES_ENABLED=0 MOBILE_VERSION_POLICY=appVersion
export EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 EXPO_NO_GIT_STATUS=1 EXPO_OFFLINE=1 NODE_ENV=production
export T3CODE_IOS_PERSONAL_TEAM=0
unset SKIP_BUNDLING
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/fork-mobile.XXXXXX")"
trap 'rm -rf "$work"' EXIT
out="$root/artifacts/fork-mobile/$platform"
mkdir -p "$out"
cd "$mobile"

if [[ "$platform" == ios ]]; then
  [[ "$(uname -s)" == Darwin ]] || fail 'iOS device builds require macOS.'
  xcode_version="$(xcodebuild -version | awk '/^Xcode / { print $2 }')"
  sdk_version="$(xcrun --sdk iphoneos --show-sdk-version)"
  [[ "$xcode_version" == 26.6 ]] || fail "Expected Xcode 26.6, got $xcode_version. Do not silently fall back to another Xcode."
  [[ "$sdk_version" == 26.5 ]] || fail "Expected iOS device SDK 26.5, got $sdk_version. Review the toolchain pin."
  minimum_xcode="$(ruby -r "$mobile/node_modules/react-native/scripts/cocoapods/helpers.rb" -e 'puts Helpers::Constants.min_xcode_version_supported')"
  python3 - "$xcode_version" "$minimum_xcode" <<'PY'
import sys
def version(value):
    parts = [int(part) for part in value.split('.')]
    return tuple(parts + [0] * (4 - len(parts)))
if version(sys.argv[1]) < version(sys.argv[2]):
    sys.exit(f"React Native requires Xcode >= {sys.argv[2]}; update the runner/toolchain pin.")
PY
  xcodebuild -version
  xcrun --sdk iphoneos --show-sdk-version
  command -v pod >/dev/null || fail 'The selected macOS image must provide CocoaPods.'
else
  [[ "$(java -version 2>&1 | head -1)" == *'"17.'* ]] || fail 'Android builds require JDK 17.'
  [[ -d "${ANDROID_HOME:-}" ]] || fail 'ANDROID_HOME must point to the hosted runner Android SDK.'
  export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
  command -v sdkmanager >/dev/null || fail 'Android command-line tools are missing under ANDROID_HOME/cmdline-tools/latest.'
  supplied=0
  for key in ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
    [[ -z "${!key:-}" ]] || supplied=$((supplied + 1))
  done
  (( supplied == 0 || supplied == 4 )) || fail 'Provide all four Android signing secrets, or none. Refusing partial signing configuration.'
fi

vp exec expo config --type prebuild --json > "$work/config.json"
python3 "$helper" config "$work/config.json"
# Use the installed Expo template and native bundlers, without EAS or an Expo login.
[[ -f node_modules/expo/template.tgz ]] || fail 'Installed Expo native template missing; refusing a remote template fallback.'
vp exec expo prebuild --clean --platform "$platform" --no-install \
  --template "$mobile/node_modules/expo/template.tgz" --skip-dependency-update react,react-native

if [[ "$platform" == ios ]]; then
  python3 "$helper" prepare-ios "$mobile/ios" "$MOBILE_BUILD_NUMBER"
  (cd ios && pod install)
  printf 'export NODE_BINARY=%q\n' "$(command -v node)" > ios/.xcode.env.local
  xcodebuild \
    -workspace ios/T3Code.xcworkspace -scheme T3Code -configuration Release \
    -sdk iphoneos -destination 'generic/platform=iOS' \
    -derivedDataPath "$work/DerivedData" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
    DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
    CURRENT_PROJECT_VERSION="$MOBILE_BUILD_NUMBER" ARCHS=arm64 ONLY_ACTIVE_ARCH=NO build
  app="$work/DerivedData/Build/Products/Release-iphoneos/T3Code.app"
  [[ -d "$app" ]] || fail 'Xcode did not produce the production device app.'
  mkdir -p "$work/Payload"
  ditto "$app" "$work/Payload/T3Code.app"
  artifact="$out/t3-code-ios-unsigned-$MOBILE_BUILD_NUMBER.ipa"
  (cd "$work" && ditto -c -k --keepParent Payload "$artifact")
  python3 "$helper" ipa "$artifact" "$MOBILE_BUILD_NUMBER"
  signing='Unsigned iOS device IPA. Re-sign before installation, including embedded extensions/frameworks. No Apple certificate or provisioning profile was used.'
else
  python3 "$helper" prepare-android "$mobile/android" "$MOBILE_BUILD_NUMBER"
  python3 "$helper" android-sdk "$mobile/node_modules/react-native/gradle/libs.versions.toml" > "$work/sdk-packages.txt"
  mapfile -t sdk_packages < "$work/sdk-packages.txt"
  # sdkmanager may close stdin early; retain its status rather than yes's SIGPIPE.
  set +o pipefail
  license_status=0
  yes | sdkmanager --licenses > "$work/sdk-licenses.log" 2>&1 || license_status=$?
  set -o pipefail
  (( license_status == 0 )) || { cat "$work/sdk-licenses.log"; fail 'Android SDK license acceptance failed.'; }
  sdkmanager "${sdk_packages[@]}" 'cmake;3.22.1'
  build_tools="${sdk_packages[1]#build-tools;}"
  export FORK_ANDROID_KEYSTORE="$work/self-use.keystore"
  if (( supplied == 4 )); then
    python3 - <<'PY'
import base64, os
from pathlib import Path
Path(os.environ['FORK_ANDROID_KEYSTORE']).write_bytes(base64.b64decode(''.join(os.environ['ANDROID_KEYSTORE_BASE64'].split()), validate=True))
PY
    export FORK_ANDROID_STORE_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
    export FORK_ANDROID_KEY_ALIAS="$ANDROID_KEY_ALIAS"
    export FORK_ANDROID_KEY_PASSWORD="$ANDROID_KEY_PASSWORD"
    signing='Android Release APK signed with the supplied persistent keystore. Keep the same keystore and alias for future upgrades.'
  elif (( supplied == 0 )); then
    export FORK_ANDROID_STORE_PASSWORD=android FORK_ANDROID_KEY_ALIAS=androiddebugkey FORK_ANDROID_KEY_PASSWORD=android
    keytool -genkeypair -noprompt -storetype JKS -keystore "$FORK_ANDROID_KEYSTORE" \
      -storepass:env FORK_ANDROID_STORE_PASSWORD -keypass:env FORK_ANDROID_KEY_PASSWORD \
      -alias "$FORK_ANDROID_KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
      -dname 'CN=Android Debug,O=Android,C=US'
    signing='Android Release APK signed with a freshly generated debug key for this run only. NOT a stable signing identity: later runs cannot upgrade this install; uninstalling loses local app data. Set all four keystore secrets for stable updates.'
    echo "::warning::$signing"
  fi
  chmod 600 "$FORK_ANDROID_KEYSTORE"
  (cd android && ./gradlew :app:assembleRelease --no-daemon --max-workers=2 \
    -PreactNativeArchitectures=arm64-v8a,x86_64)
  artifact="$out/t3-code-android-$MOBILE_BUILD_NUMBER.apk"
  cp android/app/build/outputs/apk/release/app-release.apk "$artifact"
  python3 "$helper" apk "$artifact"
  "$ANDROID_HOME/build-tools/$build_tools/apksigner" verify --verbose --print-certs "$artifact" | tee "$artifact.signature.txt"
  "$ANDROID_HOME/build-tools/$build_tools/zipalign" -c -P 16 -v 4 "$artifact"
  "$ANDROID_HOME/build-tools/$build_tools/aapt" dump badging "$artifact" > "$work/badging.txt"
  grep -F "package: name='com.t3tools.t3code' versionCode='$MOBILE_BUILD_NUMBER'" "$work/badging.txt" >/dev/null || fail 'APK package ID or build number changed.'
  grep -F "application-label:'T3 Code'" "$work/badging.txt" >/dev/null || fail 'APK application name changed.'
  if grep -q '^application-debuggable' "$work/badging.txt"; then fail 'APK must be a non-debuggable Release build.'; fi
fi

python3 - "$artifact" "$platform" "$signing" <<'PY'
import hashlib, json, os, subprocess, sys
from pathlib import Path
artifact = Path(sys.argv[1])
with artifact.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
(artifact.parent / f'{artifact.name}.sha256').write_text(f'{digest}  {artifact.name}\n')
provenance = {
    'artifact': artifact.name,
    'sha256': digest,
    'platform': sys.argv[2],
    'signing': sys.argv[3],
    'appVariant': 'production',
    'applicationId': 'com.t3tools.t3code',
    'updatesEnabled': False,
    'runtimeVersionPolicy': 'appVersion',
    'buildNumber': os.environ['MOBILE_BUILD_NUMBER'],
    'repository': os.environ['GITHUB_REPOSITORY'],
    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'workflowRef': os.environ['GITHUB_WORKFLOW_REF'],
    'runUrl': f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
    'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
    'runnerImage': os.environ.get('ImageVersion'),
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
}
if sys.argv[2] == 'ios':
    provenance['xcode'] = subprocess.check_output(['xcodebuild', '-version'], text=True).strip()
    provenance['iphoneosSdk'] = subprocess.check_output(['xcrun', '--sdk', 'iphoneos', '--show-sdk-version'], text=True).strip()
else:
    provenance['java'] = subprocess.check_output(['java', '-version'], stderr=subprocess.STDOUT, text=True).strip()
(artifact.parent / f'{artifact.name}.provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
PY
{
  printf '%s\n\n' "$signing"
  printf 'Production variant: T3 Code / com.t3tools.t3code. Official Expo OTA disabled. Runtime policy: appVersion. Build: %s.\n' "$MOBILE_BUILD_NUMBER"
  printf 'Source: %s @ %s\n' "${GITHUB_REPOSITORY:-unknown}" "${GITHUB_SHA:-unknown}"
  printf 'See scripts/fork/mobile.md in the source checkout for installation and signing limitations.\n'
} > "$artifact.build.txt"
cat "$artifact.build.txt" >> "$GITHUB_STEP_SUMMARY"
