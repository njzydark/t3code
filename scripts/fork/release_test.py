#!/usr/bin/env python3
from contextlib import chdir
from datetime import date, datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("fork_release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_plan_uses_git_ancestry_and_excludes_upstream_and_previously_released_commits(self):
        class FrozenDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 11, 4, 1, tzinfo=tz)

        with tempfile.TemporaryDirectory() as directory, chdir(directory):
            def git(*args):
                return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()

            git("init", "-b", "main")
            git("config", "user.email", "build@example.invalid")
            git("config", "user.name", "Fork Build Test")
            package = Path("apps/desktop/package.json")
            package.parent.mkdir(parents=True)
            package.write_text('{"version":"0.1.6"}')
            git("add", ".")
            git("commit", "-m", "upstream baseline")
            baseline = git("rev-parse", "HEAD")
            git("update-ref", "refs/remotes/origin/main", baseline)
            git("commit", "--allow-empty", "-m", "previous relay feature")
            git("tag", "fork-20261103.1")
            git("commit", "--allow-empty", "-m", "fix relay reconnect")
            source = git("rev-parse", "HEAD")
            env = {
                "GITHUB_SHA": source, "GITHUB_REPOSITORY": "njzydark/t3code",
                "GITHUB_SERVER_URL": "https://github.com", "GITHUB_RUN_ID": "42",
                "GITHUB_OUTPUT": str(Path(directory) / "outputs"),
                "GITHUB_STEP_SUMMARY": str(Path(directory) / "summary"),
                "RELEASE_TARGET": "web", "RELEASE_MOBILE": "none", "RELEASE_RELAY": "false",
                "RELEASE_PUBLISH_RELAY": "false", "RELEASE_NOTES": "Reconnect no longer stalls.",
            }
            with patch.dict(os.environ, env), patch.object(release, "datetime", FrozenDateTime):
                release.make_plan()
            plan = json.loads(Path("release-plan/fork-release.json").read_text())
            self.assertEqual(plan["commit"], source)
            self.assertEqual(plan["upstream_base"], baseline)
            self.assertEqual(plan["tag"], "fork-20261104.1")
            notes = Path("release-plan/release-notes.md").read_text()
            self.assertIn("fix relay reconnect", notes)
            self.assertIn(env["RELEASE_NOTES"], notes)
            self.assertNotIn("previous relay feature", notes)
            self.assertNotIn("upstream baseline", notes)
            self.assertIn("version=0.1.6-fork.20261104.1", Path("outputs").read_text())

    def test_date_versions_increment_across_days_months_and_upstream_versions(self):
        tags = ["v0.1.6", "fork-20261102.9", "fork-20261103.1", "fork-20261103.2"]
        plan = release.release_plan(date(2026, 11, 3), "0.1.6-preview.1", tags, "all", "all", True)
        self.assertEqual(plan["tag"], "fork-20261103.3")
        self.assertEqual(plan["version"], "0.1.6-fork.20261103.3")
        self.assertEqual(plan["mobile_version"], "2026.11.3")
        self.assertEqual(plan["ios_build"], "2611.3.3")
        self.assertEqual(plan["android_build"], "2026110303")
        self.assertEqual(plan["previous_tag"], "fork-20261103.2")
        self.assertEqual(len(plan["artifacts"]), 8)
        for target, mobile, relay, expected in [
            ("none", "none", True, ["relay-linux-amd64-core", "relay-linux-amd64-web"]),
            ("none", "ios", False, ["t3-code-ios-self-use-2611.3.1"]),
            ("none", "android", False, ["t3-code-android-self-use-2026110301"]),
            ("none", "all", False, ["t3-code-ios-self-use-2611.3.1", "t3-code-android-self-use-2026110301"]),
            ("desktop-all", "none", False, ["fork-desktop-macos-arm64-0.1.6-fork.20261103.1",
                                            "fork-desktop-linux-x64-0.1.6-fork.20261103.1"]),
            ("cli-linux-x64", "none", False, ["fork-cli-linux-x64-0.1.6-fork.20261103.1"]),
        ]:
            with self.subTest(target=target, mobile=mobile, relay=relay):
                selected = release.release_plan(date(2026, 11, 3), "0.1.6", [], target, mobile, relay)
                self.assertEqual(selected["artifacts"], expected)
        with self.assertRaisesRegex(ValueError, "Select at least one"):
            release.release_plan(date(2026, 11, 3), "0.1.6", [], "none", "none", False)
        previous_ios = (2611, 3, 3)
        previous_android = int(plan["android_build"])
        for day in [date(2026, 11, 4), date(2026, 12, 1), date(2027, 1, 1)]:
            plan = release.release_plan(day, "0.2.0", tags, "web", "none", False)
            ios = tuple(map(int, plan["ios_build"].split(".")))
            self.assertGreater(ios, previous_ios)
            self.assertGreater(int(plan["android_build"]), previous_android)
            self.assertLessEqual(int(plan["android_build"]), 2100000000)
            self.assertEqual(plan["artifacts"], [f"fork-web-{plan['version']}"])
            previous_ios, previous_android = ios, int(plan["android_build"])
        for tags, day in [
            (["fork-20261104.1"], date(2026, 11, 3)),
            (["fork-20261103.99"], date(2026, 11, 3)),
            ([], date(2100, 1, 1)),
        ]:
            with self.subTest(tags=tags, day=day), self.assertRaises(ValueError):
                release.release_plan(day, "0.1.6", tags, "all", "all", True)

    def test_assembly_requires_the_selected_assets_commit_version_and_checksums(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            downloads = root / "downloaded"
            plan = release.release_plan(date(2026, 11, 3), "0.1.6", [], "web", "none", False)
            plan.update(commit="a" * 40, repository="njzydark/t3code", relay_images=[])
            plan_dir = downloads / "fork-release-plan"
            plan_dir.mkdir(parents=True)
            (plan_dir / "fork-release.json").write_text(json.dumps(plan))
            artifact_dir = downloads / plan["artifacts"][0]
            artifact_dir.mkdir()
            unselected = downloads / "t3-code-ios-self-use-2611.3.1"
            unselected.mkdir()
            (unselected / "old.ipa").write_bytes(b"unselected build")
            artifact = artifact_dir / "web.tar.gz"
            artifact.write_bytes(b"packaged web")
            provenance = artifact_dir / "fork-web-provenance.json"
            data = {"commit": plan["commit"], "repository": plan["repository"], "version": plan["version"]}
            provenance.write_text(json.dumps(data))
            sums = artifact_dir / "fork-web-SHA256SUMS.txt"

            def checksum():
                sums.write_text("".join(
                    f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
                    for path in [artifact, provenance]
                ))

            checksum()
            with patch.dict(os.environ, GITHUB_SHA=plan["commit"], GITHUB_REPOSITORY=plan["repository"]):
                output = root / "release"
                release.assemble(downloads, output)
                self.assertEqual((output / artifact.name).read_bytes(), artifact.read_bytes())
                self.assertFalse((output / "old.ipa").exists())
                self.assertIn("fork-release.json", (output / "SHA256SUMS.txt").read_text())
                for key, value in [("commit", "b" * 40), ("repository", "other/repo"), ("version", "0.1.6")]:
                    with self.subTest(key=key):
                        provenance.write_text(json.dumps({**data, key: value}))
                        checksum()
                        with self.assertRaisesRegex(ValueError, "mismatch"):
                            release.verify_artifact(artifact_dir, plan)
                provenance.write_text(json.dumps(data))
                checksum()
                artifact.write_bytes(b"corrupt download")
                with self.assertRaisesRegex(ValueError, "Checksum mismatch"):
                    release.verify_artifact(artifact_dir, plan)
                sums.write_text(f"{'0' * 64}  ../secret\n")
                with self.assertRaisesRegex(ValueError, "Invalid checksum"):
                    release.verify_artifact(artifact_dir, plan)
                plan["artifacts"].append("missing-android")
                (plan_dir / "fork-release.json").write_text(json.dumps(plan))
                checksum()
                with self.assertRaises(FileNotFoundError):
                    release.assemble(downloads, root / "missing")

    def test_mobile_and_relay_metadata_must_match_the_release_plan(self):
        plan = release.release_plan(date(2026, 11, 3), "0.1.6", [], "all", "all", True)
        plan.update(commit="a" * 40, repository="njzydark/t3code", relay_images=["ghcr.io/test:version-core"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "device.ipa"
            binary.write_bytes(b"ipa")
            (root / "device.ipa.sha256").write_text(f"{hashlib.sha256(b'ipa').hexdigest()}  device.ipa\n")
            metadata = root / "device.ipa.provenance.json"
            data = {"commit": plan["commit"], "repository": plan["repository"], "platform": "ios",
                    "appVersion": plan["mobile_version"], "buildNumber": plan["ios_build"]}
            metadata.write_text(json.dumps(data))
            release.verify_artifact(root, plan)
            for key, value in [("appVersion", "2.2.0"), ("buildNumber", "42")]:
                metadata.write_text(json.dumps({**data, key: value}))
                with self.assertRaisesRegex(ValueError, "Mobile version mismatch"):
                    release.verify_artifact(root, plan)
            metadata.unlink()
            relay = root / "relay-core-build.txt"
            relay.write_text(f"commit={plan['commit']}\nimage=ghcr.io/test:version-core\nplatform=linux/amd64\n")
            release.verify_artifact(root, plan)
            relay.write_text(f"commit={plan['commit']}\nimage=ghcr.io/test:wrong-core\n")
            with self.assertRaisesRegex(ValueError, "Image version mismatch"):
                release.verify_artifact(root, plan)

    def test_draft_refuses_published_releases_and_tags_for_other_commits(self):
        with tempfile.TemporaryDirectory() as directory, chdir(directory):
            assets = Path("release-assets")
            assets.mkdir()
            plan = {"tag": "fork-20261104.1", "commit": "a" * 40}
            (assets / "fork-release.json").write_text(json.dumps(plan))
            env = {"GITHUB_SHA": plan["commit"], "RELEASE_TAG": plan["tag"],
                   "GITHUB_REPOSITORY": "njzydark/t3code"}
            with patch.dict(os.environ, env):
                with patch.object(release, "gh_api", return_value={"draft": False}):
                    with self.assertRaisesRegex(ValueError, "published release"):
                        release.draft()
                for reference in [{"type": "commit", "sha": "b" * 40},
                                  {"type": "tag", "sha": plan["commit"]}]:
                    with self.subTest(reference=reference):
                        with patch.object(release, "gh_api", side_effect=[{"draft": True}, {"object": reference}]):
                            with self.assertRaisesRegex(ValueError, "different commit"):
                                release.draft()


if __name__ == "__main__":
    unittest.main()
