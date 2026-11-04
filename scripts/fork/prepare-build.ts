/* oxlint-disable t3code/no-global-process-runtime -- Native packaging runs before the application runtime exists. */
// @effect-diagnostics nodeBuiltinImport:off -- Fork build bootstrap runs before the application runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

export const repoRoot = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
export const targets = [
  "all",
  "desktop-all",
  "desktop-macos-arm64",
  "desktop-linux-x64",
  "cli-linux-x64",
  "web",
];

export function validateVersion(version: string) {
  const numeric = "(?:0|[1-9][0-9]*)";
  const identifier = `(?:${numeric}|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)`;
  const semver = new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  );
  if (!semver.test(version)) throw new Error(`Invalid SemVer: ${version}`);
  // The upstream builder changes names and icons for this reserved version pattern.
  if (/-nightly\.\d{8}\.\d+$/.test(version)) {
    throw new Error("Use a fork prerelease instead of the reserved nightly branding pattern.");
  }
  return version;
}

export function buildPlan(
  target: string,
  version: string,
  appVersion: string,
  run = "0",
  attempt = "1",
) {
  if (!targets.includes(target))
    throw new Error(`Unsupported target: ${target}. Windows is not supported.`);
  if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt))
    throw new Error("Invalid run number or attempt.");
  const resolvedVersion = validateVersion(
    version.trim() || `${appVersion.split(/[+-]/)[0]}-fork.${run}.${attempt}`,
  );
  const desktop = [
    {
      target: "desktop-macos-arm64",
      runner: "macos-26",
      platform: "mac",
      arch: "arm64",
      format: "dmg",
      rust: "aarch64-apple-darwin",
    },
    {
      target: "desktop-linux-x64",
      runner: "ubuntu-24.04",
      platform: "linux",
      arch: "x64",
      format: "AppImage",
      rust: "x86_64-unknown-linux-gnu",
    },
  ].filter((entry) => target === "all" || target === "desktop-all" || target === entry.target);
  return {
    version: resolvedVersion,
    desktop,
    cli: target === "all" || target === "cli-linux-x64" || target === "desktop-linux-x64",
    web: target === "all" || target === "web",
    bundle: target !== "web",
  };
}

export function run(command: string, args: string[], env = process.env) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

export async function writeProvenance(directory: string, target: string, version: string) {
  const paths = (await NodeFSP.readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.join(entry.parentPath, entry.name))
    .sort();
  if (paths.length === 0) throw new Error(`No artifacts in ${directory}`);
  const files = await Promise.all(
    paths.map(async (path) => ({
      name: NodePath.relative(directory, path).replaceAll("\\", "/"),
      sha256: NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(path))
        .digest("hex"),
    })),
  );
  const name = `fork-${target}-provenance.json`;
  const manifest = `${JSON.stringify(
    {
      target,
      version,
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      commit: process.env.GITHUB_SHA,
      run: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      signed: false,
      autoUpdate: false,
      files,
    },
    null,
    2,
  )}\n`;
  await NodeFSP.writeFile(NodePath.join(directory, name), manifest);
  const manifestHash = NodeCrypto.createHash("sha256").update(manifest).digest("hex");
  await NodeFSP.writeFile(
    NodePath.join(directory, `fork-${target}-SHA256SUMS.txt`),
    [...files, { name, sha256: manifestHash }]
      .map((file) => `${file.sha256}  ${file.name}\n`)
      .join(""),
  );
}

if (import.meta.main) {
  const event = JSON.parse(NodeFS.readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
  if (
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== "refs/heads/codex/build" ||
    event.repository?.fork !== true
  ) {
    throw new Error("Fork builds require workflow_dispatch on a fork's codex/build branch.");
  }
  const appVersion = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/desktop/package.json"), "utf8"),
  ).version;
  const plan = buildPlan(
    process.env.FORK_TARGET || "all",
    process.env.FORK_VERSION || "",
    appVersion,
    process.env.GITHUB_RUN_NUMBER,
    process.env.GITHUB_RUN_ATTEMPT,
  );
  const origin = process.env.FORK_WEB_ORIGIN?.trim();
  if (origin) {
    const url = new URL(origin);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin) {
      throw new Error("web_origin must be an HTTP(S) origin without a path or trailing slash.");
    }
  }
  NodeFS.appendFileSync(
    process.env.GITHUB_OUTPUT!,
    Object.entries({
      version: plan.version,
      desktop: JSON.stringify({ include: plan.desktop }),
      has_desktop: plan.desktop.length > 0,
      cli: plan.cli,
      web: plan.web,
      bundle: plan.bundle,
    })
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
