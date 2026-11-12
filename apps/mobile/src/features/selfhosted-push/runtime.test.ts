import { describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { EnvironmentId } from "@t3tools/contracts";
import { appAtomRegistry } from "../../state/atom-registry";
import { installSelfHostedPush, refreshSelfHostedPush, unregisterSelfHostedPush } from "./runtime";
import * as Notifications from "expo-notifications";

const state = vi.hoisted(() => ({
  entries: new Map<string, { enabled: boolean; profile: unknown }>(),
  configs: new Map<string, unknown>(),
  enabled: true,
  requests: [] as Array<{ environmentId: string; input: Record<string, unknown> }>,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make(() => ({ isReady: true, entries: state.entries })),
    },
  };
});
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(() => state.configs) };
});
vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
  runAtomCommand: async (
    _registry: unknown,
    _command: unknown,
    target: { environmentId: string; input: Record<string, unknown> },
  ) => {
    state.requests.push(target);
    return {
      _tag: "Success",
      value:
        target.input.operation === "capabilities"
          ? { enabled: state.enabled }
          : target.input.operation === "snapshot"
            ? { aggregate: null }
            : { ok: true },
    };
  },
  squashAtomCommandFailure: () => new Error("RPC failed"),
}));
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      version: "1",
      ios: { bundleIdentifier: "test.app" },
      extra: { appVariant: "development" },
    },
  },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(async () => ({ granted: true })),
  getDevicePushTokenAsync: vi.fn(async () => ({ type: "ios", data: "a".repeat(64) })),
  addPushTokenListener: () => ({ remove: () => {} }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "18.0" },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: async () => "self-hosted-device",
  loadPreferences: async () => ({}),
}));
vi.mock("../agent-awareness/capabilities", () => ({ supportsAgentAwarenessPush: () => true }));
vi.mock("./activity", () => ({
  selfHostedActivity: { dismissEnded: () => {}, getInstances: () => [], start: () => null },
}));

function setup(selfHosted: boolean, enabled = true) {
  appAtomRegistry.reset();
  state.entries.clear();
  state.configs.clear();
  state.requests.length = 0;
  state.enabled = enabled;
  vi.mocked(Notifications.getDevicePushTokenAsync).mockClear();
  const id = EnvironmentId.make("environment");
  state.entries.set(id, {
    enabled: true,
    profile: Option.some({
      _tag: "BearerConnectionProfile",
      ...(selfHosted ? { selfHostedRelay: { relayUrl: "https://relay.test" } } : {}),
    }),
  });
  state.configs.set(id, {});
  return { id };
}

describe("isolated mobile self-hosted push registration", () => {
  it("does not read native push tokens or register official and direct connections", async () => {
    setup(false);
    const stop = installSelfHostedPush();
    try {
      await refreshSelfHostedPush();
      expect(state.requests).toEqual([]);
      expect(Notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("registers a native token with its paired environment and unregisters before removal", async () => {
    const { id } = setup(true);
    const stop = installSelfHostedPush();
    try {
      await refreshSelfHostedPush();
      expect(
        state.requests.find((request) => request.input.operation === "register"),
      ).toMatchObject({
        environmentId: id,
        input: {
          registration: {
            deviceId: "self-hosted-device",
            platform: "ios",
            bundleId: "test.app",
            apsEnvironment: "sandbox",
            pushToken: "a".repeat(64),
          },
        },
      });
      await unregisterSelfHostedPush(id);
      expect(state.requests.at(-1)).toEqual({
        environmentId: id,
        input: { operation: "unregister", deviceId: "self-hosted-device" },
      });
    } finally {
      stop();
    }
  });

  it("does not register devices when the deployment does not advertise push", async () => {
    setup(true, false);
    const stop = installSelfHostedPush();
    try {
      await refreshSelfHostedPush();
      expect(state.requests.every((request) => request.input.operation === "capabilities")).toBe(
        true,
      );
      expect(Notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
