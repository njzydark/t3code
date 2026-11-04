#!/usr/bin/env python3
"""Plan dated fork releases and verify build outputs before creating a draft."""

from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from zoneinfo import ZoneInfo


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def release_plan(day, app_version, tags, target, mobile, relay):
    require(2000 <= day.year <= 2099, "Date build numbers support years 2000 through 2099")
    require(re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?", app_version),
            "Invalid upstream app version")
    require(target in ["all", "desktop-all", "desktop-macos-arm64", "desktop-linux-x64", "cli-linux-x64", "web", "none"],
            "Unsupported desktop/CLI/web target")
    require(mobile in ["none", "ios", "android", "all"], "Unsupported mobile target")
    dated_tags = []
    for tag in tags:
        match = re.fullmatch(r"fork-(\d{8})\.([1-9][0-9]?)", tag)
        if match:
            dated_tags.append((match[1], int(match[2]), tag))
    dated_tags.sort()
    stamp = day.strftime("%Y%m%d")
    require(not dated_tags or dated_tags[-1][0] <= stamp,
            "Refusing a release older than an existing date tag")
    revision = max((number for date, number, _ in dated_tags if date == stamp), default=0) + 1
    require(revision <= 99, "At most 99 releases per Shanghai calendar day")
    version = f"{app_version.split('-')[0].split('+')[0]}-fork.{stamp}.{revision}"
    android_build = f"{stamp}{revision:02}"
    ios_build = f"{day.year % 100 * 100 + day.month}.{day.day}.{revision}"
    artifacts = []
    if target in ["all", "desktop-all", "desktop-macos-arm64"]:
        artifacts.append(f"fork-desktop-macos-arm64-{version}")
    if target in ["all", "desktop-all", "desktop-linux-x64"]:
        artifacts.append(f"fork-desktop-linux-x64-{version}")
    if target in ["all", "desktop-linux-x64", "cli-linux-x64"]:
        artifacts.append(f"fork-cli-linux-x64-{version}")
    if target in ["all", "web"]:
        artifacts.append(f"fork-web-{version}")
    if mobile in ["ios", "all"]:
        artifacts.append(f"t3-code-ios-self-use-{ios_build}")
    if mobile in ["android", "all"]:
        artifacts.append(f"t3-code-android-self-use-{android_build}")
    if relay:
        artifacts.extend(["relay-linux-amd64-core", "relay-linux-amd64-web"])
    require(artifacts, "Select at least one component to release")
    return {
        "tag": f"fork-{stamp}.{revision}",
        "version": version,
        "mobile_version": f"{day.year}.{day.month}.{day.day}",
        "android_build": android_build,
        "ios_build": ios_build,
        "previous_tag": dated_tags[-1][2] if dated_tags else "",
        "artifacts": artifacts,
        "target": target,
        "mobile": mobile,
        "relay": relay,
    }


def make_plan():
    plan = release_plan(
        datetime.now(ZoneInfo("Asia/Shanghai")).date(),
        json.loads(Path("apps/desktop/package.json").read_text())["version"],
        git("tag", "--list", "fork-*").splitlines(),
        os.environ["RELEASE_TARGET"],
        os.environ["RELEASE_MOBILE"],
        os.environ["RELEASE_RELAY"] == "true",
    )
    source = git("rev-parse", "HEAD")
    require(source == os.environ["GITHUB_SHA"], "Release source differs from the workflow SHA")
    previous = plan["previous_tag"]
    baseline = git("merge-base", "refs/remotes/origin/main", source)
    if previous:
        previous_baseline = git("merge-base", "refs/remotes/origin/main", previous)
        subprocess.run(["git", "merge-base", "--is-ancestor", previous_baseline, baseline], check=True)
    repository = os.environ["GITHUB_REPOSITORY"]
    server = os.environ["GITHUB_SERVER_URL"]
    image = f"ghcr.io/{repository.lower()}/selfhosted-relay:{plan['version']}"
    plan.update({
        "commit": source,
        "upstream_base": baseline,
        "repository": repository,
        "run": f"{server}/{repository}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
        "relay_images": [f"{image}-core", f"{image}-web"] if plan["relay"] else [],
        "relay_published": plan["relay"] and os.environ["RELEASE_PUBLISH_RELAY"] == "true",
    })
    log_args = ["log", "--no-merges", "--format=- %h %s"]
    if previous:
        log_args.extend(["--cherry-pick", "--right-only", f"{previous}...{source}"])
    else:
        log_args.append(source)
    log_args.extend(["--not", baseline])
    changes = git(*log_args) or "- No additional fork commits."
    notes = os.environ.get("RELEASE_NOTES", "").strip()
    builds = []
    installation = []
    for prefix, label in [
        ("fork-desktop-macos-arm64-", "Desktop macOS arm64"),
        ("fork-desktop-linux-x64-", "Desktop Linux x64"),
        ("fork-cli-linux-x64-", "CLI Linux x64"),
        ("fork-web-", "Static web"),
    ]:
        if any(name.startswith(prefix) for name in plan["artifacts"]):
            builds.append(f"- {label}: `{plan['version']}`.")
    has_desktop = any(name.startswith("fork-desktop-") for name in plan["artifacts"])
    if has_desktop:
        installation.append("- Desktop application names and package IDs are unchanged; official automatic updates are disabled.")
    if any(name.startswith("fork-desktop-macos-") for name in plan["artifacts"]):
        installation.append(
            "- The macOS build has no Developer ID signing or notarization. Copy the app to `/Applications` first. "
            "If macOS blocks opening it, only for a download you trust (check `SHA256SUMS.txt`), "
            "remove its quarantine attribute and reopen it:\n\n"
            "  ```bash\n"
            '  xattr -dr com.apple.quarantine "/Applications/T3 Code (Beta).app/"\n'
            "  ```\n\n"
            "  Adjust the path if installed elsewhere. This removes the download quarantine flag, "
            "not the code signature; do not disable Gatekeeper globally."
        )
    if plan["mobile"] in ["ios", "all"]:
        builds.append(f"- iOS: `{plan['mobile_version']}`; bundle build: `{plan['ios_build']}`.")
        installation.append("- The iOS IPA is unsigned; re-sign it, including embedded extensions/frameworks, before installing.")
    if plan["mobile"] in ["android", "all"]:
        builds.append(f"- Android: `{plan['mobile_version']}`; versionCode: `{plan['android_build']}`.")
        installation.append("- Android upgrades require the same signing key. Check the APK build/signature metadata.")
    if plan["mobile"] != "none":
        installation.append("- Mobile application names and package IDs are unchanged; official Expo OTA updates are disabled.")
    if plan["target"] in ["all", "cli-linux-x64", "desktop-linux-x64"]:
        installation.append("- The CLI archive includes the host server and does not require a separate Node.js installation.")
    if plan["target"] in ["all", "web"]:
        installation.append("- Serve the static web client over HTTPS; it connects to an existing host and does not run a host server.")
    if plan["relay"]:
        builds.append(f"- Relay Linux amd64: `{plan['version']}-core` / `{plan['version']}-web`.")
        installation.append("- Relay Docker archives are attached. Import them on your host, or pull the versioned images if published to GHCR.")
        installation.append("- Publishing this release does not deploy the images to your cluster.")
    installation.append("- Only the listed components are updated. Other components remain on their previous releases.")
    installation.append("- Review compatibility, configuration changes, and the components actually tested before publishing.")
    body = f"""## Upstream baseline

- Upstream version: `{plan['version'].split('-')[0]}`
- Upstream commit: https://github.com/pingdotgg/t3code/commit/{baseline}

## Fork changes

{notes or 'Review the included commits and describe user-facing changes before publishing.'}

<details>
<summary>Source changes across all components (review relevance to this release)</summary>

{changes}

</details>

## Builds

{chr(10).join(builds)}
- Source: {server}/{repository}/commit/{source}
- Build run: {plan['run']}
- Assets are checked against this source commit and include SHA-256 checksums.

## Installation and upgrade

{chr(10).join(installation)}
"""
    if plan["relay"]:
        body += "\n## Relay images\n\n"
        body += "\n".join(f"- `{name}`" for name in plan["relay_images"]) + "\n"
        body += ("\nImages were published to GHCR.\n" if plan["relay_published"] else
                 "\nImages are attached as Docker archives; GHCR publishing was not requested.\n")
        body += f"\n[Relay image setup and usage]({server}/{repository}/blob/{source}/infra/selfhosted-relay/README.md).\n"
    if previous:
        body += f"\nFull comparison: {server}/{repository}/compare/{previous}...{plan['tag']}\n"
    output = Path("release-plan")
    output.mkdir()
    (output / "fork-release.json").write_text(json.dumps(plan, indent=2) + "\n")
    (output / "release-notes.md").write_text(body)
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        for key in ["tag", "version", "mobile_version", "android_build", "ios_build"]:
            stream.write(f"{key}={plan[key]}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write(body)


def verify_artifact(directory, plan):
    files = list(directory.iterdir())
    require(files and all(path.is_file() and not path.is_symlink() for path in files),
            f"Missing or nested artifact files: {directory.name}")
    checksums = [path for path in files if "SHA256SUMS" in path.name or path.suffix == ".sha256"]
    require(checksums, f"Missing checksums: {directory.name}")
    checked = set()
    for manifest in checksums:
        for line in manifest.read_text().splitlines():
            match = re.fullmatch(r"([0-9a-f]{64})  ([^/\\]+)", line)
            require(match and match[2] not in [".", ".."], "Invalid checksum entry")
            path = directory / match[2]
            with path.open("rb") as stream:
                require(hashlib.file_digest(stream, "sha256").hexdigest() == match[1],
                        f"Checksum mismatch: {path.name}")
            checked.add(path.name)
    require(any(path.suffix in [".gz", ".ipa", ".apk", ".dmg", ".AppImage"] for path in files),
            f"Missing installable asset: {directory.name}")
    metadata = [path for path in files if path.name.endswith(("provenance.json", "build.txt"))]
    require(metadata, f"Missing source provenance: {directory.name}")
    for path in metadata:
        if path.suffix == ".json":
            data = json.loads(path.read_text())
            require(data["commit"] == plan["commit"], f"Source mismatch: {path.name}")
            require(data["repository"] == plan["repository"], f"Repository mismatch: {path.name}")
            if "appVersion" in data:
                platform = data["platform"]
                expected = plan["ios_build"] if platform == "ios" else plan["android_build"]
                require(data["appVersion"] == plan["mobile_version"] and data["buildNumber"] == expected,
                        f"Mobile version mismatch: {path.name}")
            else:
                require(data["version"] == plan["version"], f"Version mismatch: {path.name}")
        elif path.name.startswith("relay-"):
            data = dict(line.split("=", 1) for line in path.read_text().splitlines())
            require(data["commit"] == plan["commit"], f"Source mismatch: {path.name}")
            require(data["image"] in plan["relay_images"], f"Image version mismatch: {path.name}")
    for path in files:
        if path.suffix in [".gz", ".ipa", ".apk", ".dmg", ".AppImage"]:
            require(path.name in checked, f"Unchecked installable asset: {path.name}")
    return files


def assemble(downloads, output):
    plan_path = downloads / "fork-release-plan/fork-release.json"
    plan = json.loads(plan_path.read_text())
    require(plan["commit"] == os.environ["GITHUB_SHA"], "Downloaded plan has a different source")
    require(plan["repository"] == os.environ["GITHUB_REPOSITORY"], "Downloaded plan has a different repository")
    output.mkdir()
    for name in plan["artifacts"]:
        for path in verify_artifact(downloads / name, plan):
            destination = output / path.name
            require(not destination.exists(), f"Duplicate release asset: {path.name}")
            shutil.copyfile(path, destination)
    shutil.copyfile(plan_path, output / plan_path.name)
    with (output / "SHA256SUMS.txt").open("w") as manifest:
        for path in sorted(output.iterdir()):
            if path.name != manifest.name:
                with path.open("rb") as stream:
                    manifest.write(f"{hashlib.file_digest(stream, 'sha256').hexdigest()}  {path.name}\n")


def gh_api(endpoint, *args, optional=False):
    result = subprocess.run(["gh", "api", endpoint, *args], text=True, capture_output=True)
    if optional and result.returncode and "(HTTP 404)" in result.stderr:
        return None
    require(result.returncode == 0, result.stderr)
    return json.loads(result.stdout)


def draft():
    plan = json.loads(Path("release-assets/fork-release.json").read_text())
    tag = os.environ["RELEASE_TAG"]
    require(plan["tag"] == tag and plan["commit"] == os.environ["GITHUB_SHA"],
            "Draft release does not match the verified plan")
    endpoint = f"repos/{os.environ['GITHUB_REPOSITORY']}"
    existing = gh_api(f"{endpoint}/releases/tags/{tag}", optional=True)
    require(existing is None or existing["draft"], "Refusing to modify a published release")
    reference = gh_api(f"{endpoint}/git/ref/tags/{tag}", optional=True)
    if reference is None:
        reference = gh_api(f"{endpoint}/git/refs", "--method", "POST",
                           "-f", f"ref=refs/tags/{tag}", "-f", f"sha={plan['commit']}")
    require(reference["object"]["type"] == "commit" and reference["object"]["sha"] == plan["commit"],
            "Release tag already points to a different commit")
    if existing is None:
        subprocess.run([
            "gh", "release", "create", tag, "--draft", "--verify-tag",
            "--target", plan["commit"], "--title", f"T3 Code {plan['version']}",
            "--notes-file", "downloaded/fork-release-plan/release-notes.md",
        ], check=True)
    subprocess.run(["gh", "release", "upload", tag, "--clobber",
                    *map(str, sorted(Path("release-assets").iterdir()))], check=True)
    url = subprocess.check_output(["gh", "release", "view", tag, "--json", "url", "--jq", ".url"],
                                  text=True).strip()
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write(f"\nDraft release: {url}\n\nReview the notes and publish it from GitHub Releases.\n")
    print(f"Draft release ready: {url}")


if __name__ == "__main__":
    if sys.argv[1] == "plan":
        make_plan()
    elif sys.argv[1] == "assemble":
        assemble(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == "draft":
        draft()
    else:
        sys.exit("Usage: release.py plan | assemble DOWNLOADS OUTPUT | draft")
