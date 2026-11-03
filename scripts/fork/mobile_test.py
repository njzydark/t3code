#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import plistlib
import struct
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location("mobile_native", Path(__file__).with_name("mobile-native.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class MobileBuildTests(unittest.TestCase):
    def test_config_rejects_ota_variant_and_identity_drift(self):
        config = {
            "name": "T3 Code", "ios": {"bundleIdentifier": native.APP_ID},
            "android": {"package": native.APP_ID}, "extra": {"appVariant": "production"},
            "updates": {"enabled": False}, "runtimeVersion": {"policy": "appVersion"},
        }
        native.check_config(config)
        for section, key, value in [
            ("updates", "enabled", True), ("ios", "bundleIdentifier", "com.example.fork"),
            ("android", "package", "com.example.fork"), ("extra", "appVariant", "development"),
            ("runtimeVersion", "policy", "fingerprint"),
        ]:
            with self.subTest(section=section):
                previous = config[section][key]
                config[section][key] = value
                with self.assertRaises(ValueError):
                    native.check_config(config)
                config[section][key] = previous

    def test_generated_android_signing_and_version_are_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "app/src/main/AndroidManifest.xml"
            manifest.parent.mkdir(parents=True)
            manifest.write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application>
              <meta-data android:name="expo.modules.updates.ENABLED" android:value="false" />
              </application></manifest>''')
            gradle = root / "app/build.gradle"
            source = '''android {
    defaultConfig {
        applicationId "com.t3tools.t3code"
        versionCode 1
    }
    signingConfigs {
        debug { }
    }
    buildTypes {
        debug { signingConfig signingConfigs.debug }
        release { signingConfig signingConfigs.debug }
    }
}
'''
            for declaration in [
                'applicationId "com.t3tools.t3code"',
                "applicationId 'com.t3tools.t3code'",
                "applicationId = 'com.t3tools.t3code'",
            ]:
                with self.subTest(declaration=declaration):
                    gradle.write_text(source.replace('applicationId "com.t3tools.t3code"', declaration))
                    native.prepare_android(root, "123")
                    actual = gradle.read_text()
                    self.assertIn("versionCode 123", actual)
                    self.assertEqual(actual.count("signingConfig signingConfigs.forkSelfUse"), 2)
                    self.assertIn('System.getenv("FORK_ANDROID_KEYSTORE")', actual)
            for invalid in [
                source.replace("com.t3tools.t3code", "com.example.other"),
                source.replace('applicationId "com.t3tools.t3code"', 'applicationId "com.t3tools.t3code"\n        applicationId "com.example.other"'),
            ]:
                gradle.write_text(invalid)
                with self.assertRaisesRegex(ValueError, "package changed"):
                    native.prepare_android(root, "123")
            gradle.write_text(source.replace("signingConfigs {", "signingConfigs{"))
            with self.assertRaisesRegex(ValueError, "template changed"):
                native.prepare_android(root, "123")
            self.assertEqual(gradle.read_text(), source.replace("signingConfigs {", "signingConfigs{"))
            manifest.write_text(manifest.read_text().replace('value="false"', 'value="true"'))
            with self.assertRaisesRegex(ValueError, "OTA"):
                native.prepare_android(root, "123")

    def test_ios_versions_include_extensions_and_require_disabled_native_ota(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expo = root / "T3Code/Supporting/Expo.plist"
            expo.parent.mkdir(parents=True)
            expo.write_bytes(plistlib.dumps({"EXUpdatesEnabled": False}))
            for name in ["T3Code", "Sharing", "Widgets"]:
                path = root / name / "Info.plist"
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(plistlib.dumps({"CFBundleVersion": "1"}))
            native.prepare_ios(root, "42")
            for path in root.glob("*/Info.plist"):
                self.assertEqual(plistlib.loads(path.read_bytes())["CFBundleVersion"], "42")
            expo.write_bytes(plistlib.dumps({"EXUpdatesEnabled": True}))
            with self.assertRaisesRegex(ValueError, "OTA"):
                native.prepare_ios(root, "43")

    def test_ipa_rejects_simulator_missing_js_signatures_and_extension_version_drift(self):
        root = "Payload/T3Code.app/"
        info = {
            "CFBundleIdentifier": native.APP_ID, "CFBundleDisplayName": "T3 Code",
            "CFBundleVersion": "42", "CFBundleSupportedPlatforms": ["iPhoneOS"],
            "CFBundleExecutable": "T3Code",
        }
        files = {
            root + "Info.plist": plistlib.dumps(info),
            root + "T3Code": struct.pack("<II", 0xFEEDFACF, 0x0100000C) + bytes(24),
            root + "main.jsbundle": b"bundled JavaScript",
            root + "Expo.plist": plistlib.dumps({"EXUpdatesEnabled": False}),
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "device.ipa"
            for issue in [None, "simulator", "missing-js", "signature", "extension-version", "ota"]:
                with self.subTest(issue=issue):
                    contents = dict(files)
                    if issue == "simulator":
                        contents[root + "Info.plist"] = plistlib.dumps({**info, "CFBundleSupportedPlatforms": ["iPhoneSimulator"]})
                    elif issue == "missing-js":
                        del contents[root + "main.jsbundle"]
                    elif issue == "signature":
                        contents[root + "_CodeSignature/CodeResources"] = b"signed"
                    elif issue == "extension-version":
                        contents[root + "PlugIns/Widgets.appex/Info.plist"] = plistlib.dumps({"CFBundleIdentifier": native.APP_ID + ".widgets", "CFBundleVersion": "1"})
                    elif issue == "ota":
                        contents[root + "Expo.plist"] = plistlib.dumps({"EXUpdatesEnabled": True})
                    with zipfile.ZipFile(path, "w") as archive:
                        for name, data in contents.items():
                            archive.writestr(name, data)
                    if issue is None:
                        native.verify_ipa(path, "42")
                    else:
                        with self.assertRaises((ValueError, KeyError)):
                            native.verify_ipa(path, "42")

    def test_apk_requires_embedded_js_and_arm64_libraries_and_valid_crc(self):
        files = {"AndroidManifest.xml": b"manifest", "classes.dex": b"dex", "assets/index.android.bundle": b"bundle", "lib/arm64-v8a/libreactnative.so": b"native"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.apk"
            for missing in [None, "assets/index.android.bundle", "lib/arm64-v8a/libreactnative.so"]:
                with self.subTest(missing=missing):
                    with zipfile.ZipFile(path, "w") as archive:
                        for name, data in files.items():
                            if name != missing:
                                archive.writestr(name, data)
                    if missing is None:
                        native.verify_apk(path)
                    else:
                        with self.assertRaises((ValueError, KeyError)):
                            native.verify_apk(path)
            with zipfile.ZipFile(path, "w") as archive:
                for name, data in files.items():
                    archive.writestr(name, data)
            path.write_bytes(path.read_bytes().replace(b"bundlePK", b"brokenPK", 1))
            with self.assertRaisesRegex(ValueError, "CRC"):
                native.verify_apk(path)


if __name__ == "__main__":
    unittest.main()
