import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  supportsServerBrowser: vi.fn(),
  readPreparedConnection: vi.fn(),
}));

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => true }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => "primary" } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: mocks.supportsServerBrowser,
  useEnvironmentSupportsServerBrowser: vi.fn(),
}));
vi.mock("~/state/session", () => ({ readPreparedConnection: mocks.readPreparedConnection }));

import { previewRuntimeFor } from "./previewRuntime";

it("opens relay previews on the host browser while keeping direct desktop connections local", () => {
  mocks.supportsServerBrowser.mockReturnValue(true);
  for (const [httpBaseUrl, target, runtime] of [
    [
      "t3code://app/__t3_relay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      "BearerConnectionTarget",
      "server",
    ],
    [
      "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.t3-relay.invalid",
      "BearerConnectionTarget",
      "server",
    ],
    [
      "http://127.0.0.1:3773/__t3_relay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      "BearerConnectionTarget",
      "server",
    ],
    ["https://host.connect.example/", "RelayConnectionTarget", "server"],
    ["http://192.168.1.25:3773/", "BearerConnectionTarget", undefined],
  ]) {
    mocks.readPreparedConnection.mockReturnValue({ httpBaseUrl, target: { _tag: target } });
    expect(previewRuntimeFor(EnvironmentId.make("remote"))).toBe(runtime);
    expect(previewRuntimeFor(EnvironmentId.make("primary"))).toBe("server");
    mocks.supportsServerBrowser.mockReturnValue(false);
    expect(previewRuntimeFor(EnvironmentId.make("remote"))).toBeUndefined();
    mocks.supportsServerBrowser.mockReturnValue(true);
  }
});
