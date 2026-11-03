/* oxlint-disable t3code/no-global-process-runtime -- Native packaging runs before the application runtime exists. */
// @effect-diagnostics nodeBuiltinImport:off -- Packaging modifies only generated build output.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { repoRoot, run, validateVersion, writeProvenance } from "./prepare-build.ts";

export const updaterGuard = 'process.env.T3CODE_DISABLE_AUTO_UPDATE = "true";\n';

export function disableBundledUpdater(boot: string) {
  if (!/require\(["']\.\/main\.cjs["']\)/.test(boot)) {
    throw new Error("Electron bootstrap changed; refusing to package without the updater guard.");
  }
  return boot.startsWith(updaterGuard) ? boot : `${updaterGuard}${boot}`;
}

export function packagingEnvironment(env: NodeJS.ProcessEnv) {
  return {
    ...env,
    GITHUB_REPOSITORY: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    T3CODE_DESKTOP_UPDATE_REPOSITORY: "",
    T3CODE_DESKTOP_MOCK_UPDATES: "false",
    T3CODE_DESKTOP_SIGNED: "false",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
}

if (import.meta.main) {
  const [platform, arch, rawVersion] = process.argv.slice(2);
  if (
    !(
      (platform === "mac" && process.platform === "darwin" && arch === "arm64") ||
      (platform === "linux" && process.platform === "linux" && arch === "x64")
    ) ||
    arch !== process.arch
  ) {
    throw new Error("Only native macOS arm64 and Linux x64 desktop builds are supported.");
  }
  const version = validateVersion(rawVersion ?? "");
  const bootPath = NodePath.join(repoRoot, "apps/desktop/dist-electron/boot.cjs");
  await NodeFSP.writeFile(
    bootPath,
    disableBundledUpdater(await NodeFSP.readFile(bootPath, "utf8")),
  );
  const target = `desktop-${platform === "mac" ? "macos" : platform}-${arch}`;
  const output = NodePath.join(repoRoot, "release-fork", target);
  run(
    process.execPath,
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      platform,
      "--target",
      platform === "mac" ? "dmg" : "AppImage",
      "--arch",
      arch,
      "--build-version",
      version,
      "--skip-build",
      "--output-dir",
      output,
    ],
    packagingEnvironment(process.env),
  );
  for (const entry of await NodeFSP.readdir(output)) {
    if (!/\.(?:dmg|zip|AppImage)$/.test(entry))
      await NodeFSP.rm(NodePath.join(output, entry), { recursive: true });
  }
  await writeProvenance(output, target, version);
}
