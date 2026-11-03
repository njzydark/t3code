#!/usr/bin/env python3
"""Generated-native adjustments and artifact checks for the fork-only CI build."""

import json
from pathlib import Path
import plistlib
import re
import struct
import sys
import tomllib
import xml.etree.ElementTree as ET
import zipfile


APP_ID = "com.t3tools.t3code"
ANDROID_NS = "{http://schemas.android.com/apk/res/android}"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_config(config):
    require(config["name"] == "T3 Code", "Production app name must remain T3 Code")
    require(config["ios"]["bundleIdentifier"] == APP_ID, "iOS bundle ID changed")
    require(config["android"]["package"] == APP_ID, "Android package changed")
    require(config["extra"]["appVariant"] == "production", "Production variant required")
    require(config["updates"]["enabled"] is False, "Official Expo OTA must be disabled")
    require(config["runtimeVersion"] == {"policy": "appVersion"}, "appVersion policy required")


def prepare_ios(native, build_number):
    expo_files = list(native.glob("*/Supporting/Expo.plist"))
    require(expo_files, "Generated iOS Expo.plist not found")
    for path in expo_files:
        config = plistlib.loads(path.read_bytes())
        require(config.get("EXUpdatesEnabled") is False, "Native iOS OTA is not disabled")
    updated = []
    for path in native.rglob("*.plist"):
        config = plistlib.loads(path.read_bytes())
        if "CFBundleVersion" in config:
            config["CFBundleVersion"] = build_number
            path.write_bytes(plistlib.dumps(config, sort_keys=False))
            updated.append(path)
    require(updated, "No generated iOS bundle versions found")


def prepare_android(native, build_number):
    manifest = ET.parse(native / "app/src/main/AndroidManifest.xml")
    updates = manifest.find(f".//meta-data[@{ANDROID_NS}name='expo.modules.updates.ENABLED']")
    require(updates is not None, "Generated Android Expo Updates metadata missing")
    require(updates.get(ANDROID_NS + "value") == "false", "Native Android OTA is not disabled")
    path = native / "app/build.gradle"
    source = path.read_text()
    application_ids = re.findall(
        r"""(?m)^\s*applicationId\s*(?:=\s*)?(['"])([^'"\r\n]+)\1\s*$""", source
    )
    require([value for _, value in application_ids] == [APP_ID], "Generated Android package changed")
    source, count = re.subn(r"(?m)^(\s*versionCode\s+)\d+\s*$", rf"\g<1>{build_number}", source)
    require(count == 1, "Expected exactly one generated Android versionCode")
    marker = "    signingConfigs {"
    require(source.count(marker) == 1, "Expo signingConfigs template changed")
    source = source.replace(marker, marker + """
        forkSelfUse {
            storeFile file(System.getenv("FORK_ANDROID_KEYSTORE"))
            storePassword System.getenv("FORK_ANDROID_STORE_PASSWORD")
            keyAlias System.getenv("FORK_ANDROID_KEY_ALIAS")
            keyPassword System.getenv("FORK_ANDROID_KEY_PASSWORD")
        }""")
    source, count = re.subn(
        r"signingConfig signingConfigs\.debug\b",
        "signingConfig signingConfigs.forkSelfUse",
        source,
    )
    require(count == 2, "Expo debug/release signing template changed; review instead of silently using a debug key")
    path.write_text(source)


def android_sdk_packages(catalog):
    versions = tomllib.loads(catalog.read_text())["versions"]
    compile_sdk = str(versions["compileSdk"])
    # Google's base platform package names include the minor version starting at API 37.
    if compile_sdk.isdecimal() and int(compile_sdk) >= 37:
        compile_sdk += ".0"
    return [
        f"platforms;android-{compile_sdk}",
        f"build-tools;{versions['buildTools']}",
        f"ndk;{versions['ndkVersion']}",
    ]


def verify_zip(archive):
    require(archive.testzip() is None, "ZIP CRC/integrity check failed")
    names = archive.namelist()
    require(len(set(names)) == len(names), "Archive contains duplicate paths")
    require(all(not n.startswith("/") and ".." not in n.split("/") for n in names), "Unsafe archive paths")


def verify_ipa(path, build_number):
    with zipfile.ZipFile(path) as archive:
        verify_zip(archive)
        names = archive.namelist()
        roots = [name for name in names if re.fullmatch(r"Payload/[^/]+\.app/Info.plist", name)]
        require(len(roots) == 1, "IPA must contain exactly one Payload/*.app")
        root = roots[0].removesuffix("Info.plist")
        info = plistlib.loads(archive.read(roots[0]))
        require(info["CFBundleIdentifier"] == APP_ID, "IPA bundle ID changed")
        require(info.get("CFBundleDisplayName") == "T3 Code", "IPA display name changed")
        require(info["CFBundleVersion"] == build_number, "IPA build number mismatch")
        require(info["CFBundleSupportedPlatforms"] == ["iPhoneOS"], "IPA is not an iOS device build")
        executable = archive.read(root + info["CFBundleExecutable"])
        require(len(executable) >= 32, "IPA executable missing or empty")
        require(struct.unpack_from("<II", executable) == (0xFEEDFACF, 0x0100000C), "Expected an arm64 Mach-O device executable")
        require(archive.getinfo(root + "main.jsbundle").file_size > 0, "IPA bundled JavaScript missing or empty")
        require(not any(n.startswith(root + "_CodeSignature/") or n.endswith("embedded.mobileprovision") for n in names), "IPA unexpectedly signed or provisioned")
        expo = plistlib.loads(archive.read(root + "Expo.plist"))
        require(expo.get("EXUpdatesEnabled") is False, "Packaged IPA enables Expo OTA")
        for name in names:
            if re.fullmatch(re.escape(root) + r"PlugIns/[^/]+\.appex/Info.plist", name):
                extension = plistlib.loads(archive.read(name))
                require(extension["CFBundleIdentifier"].startswith(APP_ID + "."), "Extension bundle ID changed")
                require(extension["CFBundleVersion"] == build_number, "Extension build number mismatch")


def verify_apk(path):
    with zipfile.ZipFile(path) as archive:
        verify_zip(archive)
        for name in ["AndroidManifest.xml", "classes.dex", "assets/index.android.bundle"]:
            require(archive.getinfo(name).file_size > 0, f"APK missing or empty {name}")
        require(any(name.startswith("lib/arm64-v8a/") and name.endswith(".so") for name in archive.namelist()), "APK lacks arm64 native libraries")


def main():
    command, raw_path, *args = sys.argv[1:]
    path = Path(raw_path)
    if command == "config":
        check_config(json.loads(path.read_text()))
    elif command == "prepare-ios":
        prepare_ios(path, args[0])
    elif command == "prepare-android":
        prepare_android(path, args[0])
    elif command == "android-sdk":
        print("\n".join(android_sdk_packages(path)))
    elif command == "ipa":
        verify_ipa(path, args[0])
    elif command == "apk":
        verify_apk(path)
    else:
        raise ValueError(f"Unknown mobile helper command: {command}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        sys.exit(f"Mobile build validation failed: {error}")
