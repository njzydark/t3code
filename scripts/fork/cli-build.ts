/* oxlint-disable t3code/no-global-process-runtime -- Native packaging runs before the application runtime exists. */
// @effect-diagnostics nodeBuiltinImport:off -- Native CLI packaging invokes the existing release scripts.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { repoRoot, run, validateVersion, writeProvenance } from "./prepare-build.ts";

if (import.meta.main) {
  const version = validateVersion(process.argv[2] ?? "");
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Only native Linux x64 standalone CLI builds are supported.");
  }
  const output = NodePath.join(repoRoot, "release-fork/cli-linux-x64");
  const rustTarget = "x86_64-unknown-linux-gnu";
  run("cargo", [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "native/resource-monitor/Cargo.toml",
    "--target",
    rustTarget,
  ]);
  const monitor = NodePath.join(repoRoot, "apps/server/dist/resource-monitor/linux-x64");
  await NodeFSP.mkdir(monitor, { recursive: true });
  await NodeFSP.cp(
    NodePath.join(
      repoRoot,
      `native/resource-monitor/target/${rustTarget}/release/t3-resource-monitor`,
    ),
    NodePath.join(monitor, "t3-resource-monitor"),
  );
  run(process.execPath, ["apps/server/scripts/cli.ts", "build-exe", "--verbose"]);
  run(process.execPath, [
    "scripts/build-cli-archive.ts",
    "--platform",
    "linux",
    "--arch",
    "x64",
    "--version",
    version,
    "--output-dir",
    output,
  ]);
  run(process.execPath, [
    "scripts/smoke-cli-archive.ts",
    "--archive",
    NodePath.join(output, `t3-${version}-linux-x64.tar.gz`),
    "--expect-version",
    version,
  ]);
  await writeProvenance(output, "cli-linux-x64", version);
}
