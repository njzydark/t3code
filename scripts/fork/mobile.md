# Fork-only mobile builds

Run **Fork mobile self-use** (`.github/workflows/fork-mobile.yml`) manually on
`codex/build` in a fork. Other branches and the upstream repository are skipped.
Select `ios`, `android`, or `all`. The optional Android build number is a positive
integer up to 2100000000, without leading zeros; empty uses `github.run_number`.
An optional `ios_build_number` overrides it on iOS and accepts up to three
components with at most 4/2/2 digits. Without an override, the shared build number
must also fit the iOS format. `version` optionally sets the three-integer mobile
app version, including the iOS extensions. Increase build numbers for upgrades;
re-running a job reuses its build number.

**Fork Release** calls this same workflow with dated versions. For example,
November 4, 2026's first release uses app version `2026.11.4`, Android build
`2026110401`, and iOS build `2611.4.1`. See
[fork releases](../../docs/operations/fork-builds.md#publish-a-fork-release).

The mobile workflow only reads repository contents and uploads seven-day Actions
artifacts; the release caller separately attaches these to a draft. The mobile
workflow does not create releases, push, use EAS, contact Expo account
services, or require an Expo account/token. Dependency downloads still require
network access. Enable Actions in the fork first; manual dispatch also requires
GitHub to recognize this workflow from the repository's default branch.

## Identity and updates

Both platforms use the production variant: **T3 Code**, `com.t3tools.t3code`.
The iOS extension IDs also remain upstream IDs. No application config source or
Metro configuration is patched. The scripts use the installed Expo prebuild
template, CocoaPods/Xcode, and the generated Gradle wrapper, like the existing
native build routines. Only generated native files receive signing/build-number
adjustments. The CI-only script refuses tracked native directories.

`T3CODE_MOBILE_UPDATES_ENABLED=0` disables official Expo OTA updates in config
and generated native settings. `MOBILE_VERSION_POLICY=appVersion` avoids the
official fingerprint/OTA channel. JavaScript is bundled in each Release binary;
no Metro server is needed. Updating means building and installing another binary.

These builds cannot coexist with another installation using the same package
identity. They cannot upgrade an official Android installation signed by its
publisher. Back up anything needed before uninstalling an existing app.

## iOS: unsigned device IPA

The standard GitHub `macos-26` runner is pinned to
`/Applications/Xcode_26.6.app/Contents/Developer`, Xcode 26.6 / device SDK 26.5.
This matches the previously working local toolchain. Availability was checked
against the [ARM64 runner image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md#xcode).
The upstream EAS configuration currently requests a newer image; this workflow
does not use EAS. Newer SDK-only code guarded in native sources stays guarded.
The build fails if the pinned toolchain disappears, SDK versions change, or
installed React Native requires newer Xcode. Do not lower native deployment
targets or remove SDK guards to make CI green. The app config currently requires
iOS 18.0; linked modules can impose a higher effective minimum. CocoaPods and
Xcode also enforce native dependency requirements.

This is an **arm64 device** Release build, not a simulator app. All signing and
provisioning are disabled with Xcode build flags, including the official
development team. The `.app` is placed under `Payload/` and zipped directly;
there is no App Store export or Apple certificate/provisioning secret.

**An unsigned IPA is not directly installable.** Use your own signing tool and
identity to re-sign it (including nested frameworks/extensions) and provision
your device. The artifact preserves production app groups, Apple sign-in,
associated domains, keychain, notifications, widgets and sharing extensions.
Those entitlements/IDs are not granted to your account by building this code.
Free/Personal Team signing may need unsupported extensions/capabilities removed
and IDs rewritten by your signing tool. Signing limitations, APNs, and any
account/service configuration are outside this build workflow. No promise is
made that all production capabilities work after self-signing.

Verification checks ZIP CRCs, the production identity/build number, device
platform, arm64 Mach-O executable, nonempty `main.jsbundle`, disabled native OTA,
matching extension versions, and absence of an app signature/provisioning profile.

## Android: signed Release APK

The standard `ubuntu-24.04` runner uses Temurin JDK 17 and the generated Gradle
wrapper. SDK platform/build tools/NDK come from the installed React Native
version catalog; `sdkmanager` installs them rather than assuming the image has
the required SDK. CMake is 3.22.1. Native architectures are arm64-v8a and x86_64.
Unavailable SDK packages and incompatible JDK/Gradle/native dependencies fail
the job rather than lowering minimum requirements.

For repeatable upgrade signing, configure **all four** repository Actions secrets:

| Secret                      | Format                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | Base64 of the binary JKS or PKCS12 keystore; whitespace/newlines accepted |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore passphrase                                                       |
| `ANDROID_KEY_ALIAS`         | Existing private-key alias in that keystore                               |
| `ANDROID_KEY_PASSWORD`      | Private-key passphrase (usually the store passphrase for PKCS12)          |

Generate and back up a private keystore outside the repository, then store it
through GitHub's secret UI or `gh secret set`. Do not commit the keystore or
passwords. CI decodes it to a temporary file, reads passwords through environment
variables, never uploads the key, and deletes the temporary directory on exit.
Use the same key/alias for every future build; keep an independent secure backup.

With **no secrets**, CI explicitly generates a **fresh debug signing key for that
run**, but still builds a non-debuggable, bundled **Release** APK. This key is not
stable or retained: a subsequent run cannot upgrade that installation. Removing
the app to install a new key loses local app data. Partial secrets fail; they do
not silently fall back to debug signing.

Verification checks ZIP CRCs, embedded JS and arm64 libraries, `apksigner`
signature verification/certificate fingerprint, 16 KiB ZIP alignment, and
`aapt` production package/name/version and non-debuggable status. Push/account
services requiring upstream Firebase/OAuth configuration are not provisioned.

## Artifacts and local checks

Each IPA/APK has its own `<artifact>.sha256`, `<artifact>.provenance.json`, and
`<artifact>.build.txt`. Android also has `<artifact>.signature.txt` containing
public certificate details. Provenance includes the actual checked-out commit,
workflow/run/attempt, build policy, runner image and toolchain versions. It is
plain build metadata, **not** a signed supply-chain attestation. Never upload
the native build directory, credentials, or temporary config as an artifact.

Run focused helper tests with `python3 -B scripts/fork/mobile_test.py` and shell
syntax checks with `bash -n scripts/fork/mobile-build.sh`. Native builds must run
on the disposable Actions workers; the build script deliberately refuses local
execution. A passing helper test is not evidence of a completed native build or
successful device installation.
