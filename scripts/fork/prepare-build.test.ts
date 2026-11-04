// @effect-diagnostics nodeBuiltinImport:off -- Build tests exercise generated output in an isolated scratch directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createBuildConfig } from "../build-desktop-artifact.ts";
import { disableBundledUpdater, packagingEnvironment, updaterGuard } from "./desktop-build.ts";
import { buildPlan, repoRoot, validateVersion, writeProvenance } from "./prepare-build.ts";

it("validates versions and chooses only supported native targets", () => {
  for (const version of ["0.1.6", "1.2.3-fork.42.1", "1.2.3-alpha-1+build.01"]) {
    assert.equal(validateVersion(version), version);
  }
  for (const version of [
    "v1.2.3",
    "01.2.3",
    "1.2.3-01",
    "1.2.3\nfoo=bar",
    "1.2",
    "1.2.3-nightly.20261103.1",
  ]) {
    assert.throws(() => validateVersion(version));
  }
  const all = buildPlan("all", "", "0.1.6-preview.1", "42", "2");
  assert.equal(all.version, "0.1.6-fork.42.2");
  assert.deepEqual(
    all.desktop.map(({ runner, arch }) => ({ runner, arch })),
    [
      { runner: "macos-26", arch: "arm64" },
      { runner: "ubuntu-24.04", arch: "x64" },
    ],
  );
  assert.isTrue(all.cli && all.web && all.bundle);
  const desktop = buildPlan("desktop-all", "", "0.1.6");
  assert.lengthOf(desktop.desktop, 2);
  assert.isTrue(desktop.bundle);
  assert.isFalse(desktop.cli || desktop.web);
  const linux = buildPlan("desktop-linux-x64", "2.0.0-fork", "0.1.6");
  assert.isTrue(linux.cli);
  assert.isFalse(linux.web);
  assert.lengthOf(linux.desktop, 1);
  const cli = buildPlan("cli-linux-x64", "", "0.1.6");
  assert.isTrue(cli.cli && cli.bundle);
  assert.isEmpty(cli.desktop);
  const web = buildPlan("web", "", "0.1.6");
  assert.isTrue(web.web);
  assert.isFalse(web.bundle || web.cli);
  assert.throws(() => buildPlan("desktop-win-x64", "", "0.1.6"));
});

it("persists the updater guard before Electron loads, overriding launch-time environment", async () => {
  const boot = await NodeFSP.readFile(NodePath.join(repoRoot, "apps/desktop/src/boot.ts"), "utf8");
  const guarded = disableBundledUpdater(boot);
  assert.isTrue(guarded.startsWith(updaterGuard));
  assert.equal(disableBundledUpdater(guarded), guarded);
  const calls: string[] = [];
  const env = { T3CODE_DISABLE_AUTO_UPDATE: "false" };
  NodeVM.runInNewContext(guarded, {
    process: { env },
    require: (name: string) => {
      assert.equal(env.T3CODE_DISABLE_AUTO_UPDATE, "true");
      calls.push(name);
    },
  });
  assert.deepEqual(calls, ["./compileCache.cjs", "./main.cjs"]);
  assert.throws(() => disableBundledUpdater("require('./new-entry.cjs');"));
});

it.effect("omits update feeds without changing the production app identity", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "linux",
      "AppImage",
      "0.1.6-fork.1",
      false,
      false,
      undefined,
      undefined,
    );
    assert.isNull(config.publish);
    assert.equal(config.appId, "com.t3tools.t3code");
    assert.equal(config.productName, "T3 Code (Beta)");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: packagingEnvironment({
              GITHUB_REPOSITORY: "pingdotgg/t3code",
              T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
            }),
          }),
        ),
      ),
    ),
  ),
);

it("writes target-specific provenance and independently verifiable checksums", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-provenance-"));
  try {
    await NodeFSP.writeFile(NodePath.join(directory, "t3-test.tar.gz"), "artifact bytes");
    await writeProvenance(directory, "cli-linux-x64", "0.1.6-fork.1");
    const manifest = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(directory, "fork-cli-linux-x64-provenance.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.version, "0.1.6-fork.1");
    assert.deepEqual(
      manifest.files.map((file: { name: string }) => file.name),
      ["t3-test.tar.gz"],
    );
    const sums = await NodeFSP.readFile(
      NodePath.join(directory, "fork-cli-linux-x64-SHA256SUMS.txt"),
      "utf8",
    );
    for (const line of sums.trim().split("\n")) {
      const [hash, name] = line.split("  ");
      assert.equal(
        NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(NodePath.join(directory, name!)))
          .digest("hex"),
        hash,
      );
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
