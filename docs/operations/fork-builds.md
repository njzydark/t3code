# Personal Fork Builds

The fork keeps the upstream package names, application names, bundle IDs, and
protocol schemes. These builds are replacements, not side-by-side installations
of the official applications. Matching IDs alone do not allow upgrading an app
signed with a different key. Back up application data before replacing an install.

## Branches

- `main` tracks the upstream baseline without fork-only commits.
- `codex/self-hosted-relay` owns the relay feature, tests, and user guidance.
- `codex/build` integrates selected features and owns the fork build workflows.

Set the fork's GitHub default branch to `codex/build` so the manual workflows are
listed in Actions. This does not change the upstream repository or the local
`main` branch. Keep unrelated fork build commits out of upstream pull requests.
Upstream feature acceptance still requires the contribution policy's approval.

To update the baseline, start with a clean working tree:

```sh
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch codex/build
git merge main
# Resolve conflicts, run the relevant checks, then push.
git push origin codex/build
```

Create prospective upstream features from `main`, not `codex/build`, and merge
them into `codex/build` for personal testing. Fixes to an integrated feature go
back on its feature branch and are merged again. Use merge commits on the
published integration branch rather than rewriting its history.

## Run Builds

Fork workflows start manually from `codex/build` and use GitHub-hosted runners.
The three build workflows can also be called by **Fork Release**. They do not
publish to npm, submit to app stores, deploy to a cluster, or use the upstream's
signing, Expo, or Cloudflare credentials.

Inherited upstream workflows are disabled in this fork's Actions settings because
they use maintainer runners and services. Their files stay in the repository.
Checks for a pull request submitted upstream still run in the upstream repository.
Re-enable an inherited workflow only after configuring its required services.

In GitHub, open **Actions**, choose a workflow, and select **Run workflow** with
the `codex/build` branch. Download results under that run's **Artifacts**.
Checksums and build provenance accompany the deliverables. Internal JS bundles
are intermediate artifacts, not installable applications.

### Publish a Fork Release

Run **Fork Release** on `codex/build`. Choose the desktop/CLI/web target and
mobile platforms, whether to include Relay archives, and optionally publish the
Relay images to GHCR. The defaults include all currently supported targets;
Windows and additional architectures are still not supported. Add user-facing
changes in `notes`, or edit them in the resulting draft.

One dispatch pins every build to the caller's commit, even if the branch moves
while macOS runners are queued. Version planning uses **Asia/Shanghai** dates
and the next sequence among existing `fork-YYYYMMDD.N` tags. For the first
release on November 4, 2026, based on upstream `0.1.6`:

| Component           | Version                               |
| ------------------- | ------------------------------------- |
| Release tag         | `fork-20261104.1`                     |
| Desktop / CLI / Web | `0.1.6-fork.20261104.1`               |
| Mobile app version  | `2026.11.4`                           |
| Android versionCode | `2026110401` (`YYYYMMDDNN`)           |
| iOS bundle build    | `2611.4.1` (`YYMM.D.N`)               |
| Relay images        | `0.1.6-fork.20261104.1-core` / `-web` |

The iOS build uses at most 4/2/2 digits instead of Android's ten-digit integer.
App versions have three integers, without leading zeros. The sequence increases
for additional releases on the same date and resets on the next date. There is
a limit of 99 releases per day, and the numeric scheme supports 2000-2099.
Do not delete or move release tags: they record shipped versions and allocate
the next date sequence. Use this release workflow for date-versioned upgrades;
switching back to lower standalone mobile build numbers can prevent upgrades.

All selected builds must succeed before a draft is created. The release job
verifies their source commit, versions, and checksums, then attaches installable
assets and build metadata with a combined `SHA256SUMS.txt` and
`fork-release.json`. Intermediate JS bundles are excluded. The tag points at the
exact built commit, not the latest branch tip. Rerunning a failed job can refresh
an existing **draft**, preserving edits to its notes; a published release or a
tag pointing elsewhere is never overwritten.

Open the draft in **Releases**, review the generated fork-commit list and
upstream baseline, record upgrade/compatibility notes and actual device testing,
then publish it. Release assets are separate from expiring Actions artifacts.
This does not enable automatic app updates or deploy a new image to Kubernetes.
If GHCR publishing is enabled, image publication happens in its build workflow
and can succeed even if another platform later fails; rolling tags are therefore
not a release-success signal. Use versioned image tags or digests for deployments.

Release jobs are serialized to avoid allocating the same date sequence. If an
entire run fails before creating its tag, the next dispatch may reuse that
unpublished sequence. Failed builds leave diagnostic Actions artifacts, not a
partially populated official release. A failure during asset upload can leave
an incomplete draft: rerun the failed job before publishing it.

### Desktop, CLI, and Web

**Fork desktop, CLI and web builds** supports:

- macOS arm64 desktop DMG, without Developer ID signing or notarization.
- Linux x64 desktop AppImage and a self-contained CLI archive.
- Linux x64 CLI alone, built and smoke-tested on Linux, without host Node.js.
- A static web archive without source maps.

Choose `all` or one target. The default version appends the workflow run and
attempt to the upstream version; an explicit version must be valid SemVer.
The application name and package identities are unchanged. Official desktop
automatic updates are disabled in the packaged application. Installation of a
new fork build is manual. Unsigned macOS applications may require the operating
system's explicit approval to open.

The static web app is a client, not a Linux host/server. Serve it over HTTPS and
connect with a pairing link. For a relay with hosted web, use the relay `web`
image instead. No `VITE_HTTP_URL` or `VITE_WS_URL` is baked into these builds.

Windows and additional CPU architectures are not included in this initial fork
workflow. In particular, a working Windows build also needs its matching Linux
CLI for WSL; do not replace that requirement with a cross-platform ZIP.

### iOS and Android

**Fork mobile self-use** builds an unsigned iOS device IPA or an Android release
APK, or both. Production package IDs are preserved. Expo OTA updates are disabled
in the native build, and JavaScript is embedded; neither Metro nor an Expo
account is needed to run the installed application.

The iOS IPA needs re-signing with your own installation tool. Available
capabilities and extensions depend on the profile used for re-signing; an
unsigned archive does not guarantee every entitlement is available to a free
Apple account. The workflow pins Xcode and the device SDK and fails explicitly
if the runner no longer supplies them. See
[mobile build details](../../scripts/fork/mobile.md).

For Android updates that preserve app data, configure all four repository
Actions secrets:

- `ANDROID_KEYSTORE_BASE64`: base64 of your private JKS keystore.
- `ANDROID_KEYSTORE_PASSWORD`: keystore passphrase.
- `ANDROID_KEY_ALIAS`: signing key alias.
- `ANDROID_KEY_PASSWORD`: signing key passphrase.

Keep an offline backup of that key and its passphrases. Without these secrets,
the workflow uses a new temporary debug key and labels the result accordingly;
such builds cannot upgrade an existing installation signed by a previous run.
Build numbers must increase for normal updates; a rerun of the same workflow
uses the same default number, so provide a larger explicit number if needed.
For standalone date builds, supply `version` (for example `2026.11.4`), Android
`build_number` (`2026110401`), and `ios_build_number` (`2611.4.1`). These optional
inputs are filled automatically by **Fork Release**.

### Relay Docker Images

**Fork Relay Images** builds and starts both Linux amd64 images before exporting
them as compressed Docker archives:

- `core`: Rust relay only.
- `web`: Rust relay plus the matching hosted web app, without source maps.

No registry is required. Download an archive and import it on the Docker host:

```sh
gzip -dc t3-selfhosted-relay-linux-amd64-web.tar.gz | docker load
```

For K3s, import it into containerd on every eligible node, or pin the deployment
to a node with the image. A local imported image needs a matching pull policy;
it is not available from a registry merely because its name begins with `ghcr.io`.

The optional `publish` input uploads the verified images to this fork's GHCR.
For `njzydark/t3code`, the rolling tags are:

```text
ghcr.io/njzydark/t3code/selfhosted-relay:core
ghcr.io/njzydark/t3code/selfhosted-relay:web
```

Versioned tags additionally end in `-core` and `-web`. The default version is a
commit SHA prefix. Only the publishing job receives `packages: write`; image
builds do not need registry credentials. A newly published GHCR package can be
private: configure package visibility or Kubernetes image-pull credentials
before relying on cluster pulls.

Registration tokens are runtime secrets. Never set them as workflow inputs,
include them in artifacts, or bake them into images. Follow the
[self-hosted relay guide](../user/self-hosted-relay.md) to configure a host and
create device pairing links.
