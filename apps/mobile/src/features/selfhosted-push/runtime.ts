import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { AppState, Platform } from "react-native";
import {
  WS_METHODS,
  type EnvironmentId,
  type SelfHostedPushRequest,
  type SelfHostedPushResponse,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { loadOrCreateAgentAwarenessDeviceId, loadPreferences } from "../../persistence/imperative";
import {
  makeRelayDeviceRegistrationRequest,
  resolveApsEnvironment,
} from "../agent-awareness/registrationPayload";
import { selfHostedActivity } from "./activity";

const selfHostedPushCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: WS_METHODS.selfHostedRelayPush,
  label: "mobile:self-hosted-push",
});

const targetsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const configs = get(environmentServerConfigsAtom);
  return [...catalog.entries].flatMap(([environmentId, entry]) => {
    const profile = Option.getOrNull(entry.profile);
    return entry.enabled &&
      configs.has(environmentId) &&
      profile?._tag === "BearerConnectionProfile" &&
      profile.selfHostedRelay
      ? [{ environmentId, relayUrl: profile.selfHostedRelay.relayUrl }]
      : [];
  });
}).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));
export const hasSelfHostedPushTargetsAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.values()].some((entry) => {
    const profile = Option.getOrNull(entry.profile);
    return profile?._tag === "BearerConnectionProfile" && profile.selfHostedRelay !== undefined;
  }),
);

export const selfHostedPushStatusAtom = Atom.make<string>("Not registered").pipe(Atom.keepAlive);
const registered = new Map<EnvironmentId, string>();
const activityRelays = new Map<string, string>();
const listeners = new Map<string, { remove: () => void }>();
const activityOperations = new Map<string, Promise<void>>();
let installed = false;
let generation = 0;
let operation: Promise<void> | null = null;
let pending = false;

async function request(
  environmentId: EnvironmentId,
  input: SelfHostedPushRequest,
): Promise<SelfHostedPushResponse> {
  const result = await runAtomCommand(
    appAtomRegistry,
    selfHostedPushCommand,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}

function targetsForRelay(relayUrl: string) {
  return appAtomRegistry
    .get(targetsAtom)
    .filter((target) => target.relayUrl === relayUrl && registered.has(target.environmentId));
}

async function registerActivity(
  relayUrl: string,
  activity: ReturnType<typeof selfHostedActivity.getInstances>[number],
  expectedGeneration: number,
) {
  const token = await activity.getPushToken();
  if (!token || expectedGeneration !== generation) return;
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  for (const target of targetsForRelay(relayUrl)) {
    await request(target.environmentId, {
      operation: "activity",
      deviceId,
      activityPushToken: token,
    });
  }
}

function reconcileActivity(
  relayUrl: string,
  expectedGeneration: number,
  prime = false,
): Promise<void> {
  const running = activityOperations.get(relayUrl);
  if (running)
    return prime
      ? running.then(() => reconcileActivity(relayUrl, expectedGeneration, true))
      : running;
  const next = reconcileActivityNow(relayUrl, expectedGeneration, prime).finally(() => {
    if (activityOperations.get(relayUrl) === next) activityOperations.delete(relayUrl);
  });
  activityOperations.set(relayUrl, next);
  return next;
}

async function reconcileActivityNow(relayUrl: string, expectedGeneration: number, prime = false) {
  const target = targetsForRelay(relayUrl)[0];
  if (!target || expectedGeneration !== generation) return;
  let activity = selfHostedActivity
    .getInstances()
    .find((instance) => activityRelays.get(instance.getId()) === relayUrl);
  if (!activity) {
    const deviceId = await loadOrCreateAgentAwarenessDeviceId();
    const snapshot = await request(target.environmentId, { operation: "snapshot", deviceId });
    if (expectedGeneration !== generation) return;
    if (!snapshot.aggregate?.activeCount && !prime) return;
    activity =
      selfHostedActivity.start(
        snapshot.aggregate ?? {
          title: "T3 Code",
          subtitle: "Agent work in progress",
          activeCount: 1,
          updatedAt: new Date().toISOString(),
          activities: [],
        },
        undefined,
        new Date(Date.now() + 600_000),
      ) ?? undefined;
    if (!activity) return;
    activityRelays.set(activity.getId(), relayUrl);
  }
  if (!listeners.has(activity.getId())) {
    const observed = activity;
    listeners.set(
      activity.getId(),
      activity.addPushTokenListener(() => {
        void registerActivity(relayUrl, observed, generation).catch(() => {
          appAtomRegistry.set(selfHostedPushStatusAtom, "Live Activity registration needs retry");
        });
      }),
    );
  }
  await registerActivity(relayUrl, activity, expectedGeneration);
}

async function refresh(expectedGeneration: number) {
  const targets = appAtomRegistry.get(targetsAtom);
  for (const id of registered.keys())
    if (!targets.some((target) => target.environmentId === id)) registered.delete(id);
  for (const [id, relayUrl] of activityRelays) {
    if (targets.some((target) => target.relayUrl === relayUrl)) continue;
    await selfHostedActivity
      .getInstances()
      .find((activity) => activity.getId() === id)
      ?.end("immediate");
    activityRelays.delete(id);
    listeners.get(id)?.remove();
    listeners.delete(id);
  }
  if (targets.length === 0) {
    appAtomRegistry.set(selfHostedPushStatusAtom, "Not registered");
    return;
  }
  const eligible: typeof targets = [];
  for (const target of targets) {
    try {
      const capabilities = await request(target.environmentId, { operation: "capabilities" });
      if (expectedGeneration !== generation) return;
      if (capabilities.enabled) eligible.push(target);
      else registered.delete(target.environmentId);
    } catch {
      appAtomRegistry.set(selfHostedPushStatusAtom, "Could not read the Relay's push capabilities");
    }
  }
  for (const [id, relayUrl] of activityRelays) {
    if (eligible.some((target) => target.relayUrl === relayUrl)) continue;
    await selfHostedActivity
      .getInstances()
      .find((activity) => activity.getId() === id)
      ?.end("immediate");
    activityRelays.delete(id);
    listeners.get(id)?.remove();
    listeners.delete(id);
  }
  if (eligible.length === 0) {
    appAtomRegistry.set(
      selfHostedPushStatusAtom,
      "Push unavailable; check Relay and Connect configuration",
    );
    return;
  }
  selfHostedActivity.dismissEnded();
  const preferences = await loadPreferences();
  if (expectedGeneration !== generation) return;
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  const permissions = await Notifications.getPermissionsAsync();
  const token = permissions.granted ? await Notifications.getDevicePushTokenAsync() : null;
  if (expectedGeneration !== generation) return;
  const pushToken =
    token?.type === "ios" && typeof token.data === "string" ? token.data : undefined;
  const payload = makeRelayDeviceRegistrationRequest({
    deviceId,
    label: Constants.deviceName ?? "iOS device",
    platform: "ios",
    iosMajorVersion: Number.parseInt(String(Platform.Version), 10),
    appVersion: Constants.expoConfig?.version,
    bundleId: Constants.expoConfig?.ios?.bundleIdentifier,
    apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
    ...(pushToken ? { pushToken } : {}),
    notificationsEnabled: permissions.granted && preferences.selfHostedPushEnabled !== false,
    preferences: {
      ...preferences,
      liveActivitiesEnabled:
        preferences.selfHostedPushEnabled !== false &&
        preferences.selfHostedLiveActivitiesEnabled !== false,
    },
  });
  const relays = new Set<string>();
  for (const target of eligible) {
    if (expectedGeneration !== generation) return;
    try {
      const signature = JSON.stringify([target.relayUrl, payload]);
      if (registered.get(target.environmentId) !== signature) {
        const response = await request(target.environmentId, {
          operation: "register",
          registration: payload,
        });
        if (expectedGeneration !== generation) return;
        if (!response.ok) continue;
        registered.set(target.environmentId, signature);
      }
      relays.add(target.relayUrl);
    } catch {
      appAtomRegistry.set(
        selfHostedPushStatusAtom,
        "Registration failed; check the Relay and app signing identity",
      );
    }
  }
  if (relays.size > 0)
    appAtomRegistry.set(
      selfHostedPushStatusAtom,
      preferences.selfHostedPushEnabled === false
        ? "Disabled"
        : permissions.granted
          ? "Registered"
          : "Notification permission required",
    );
  if (payload.preferences.liveActivitiesEnabled) {
    for (const relay of relays) await reconcileActivity(relay, expectedGeneration);
  } else {
    for (const activity of selfHostedActivity.getInstances()) await activity.end("immediate");
    activityRelays.clear();
    for (const listener of listeners.values()) listener.remove();
    listeners.clear();
  }
}

export function refreshSelfHostedPush(): Promise<void> {
  if (!installed) return Promise.resolve();
  pending = true;
  if (operation) return operation;
  const expectedGeneration = generation;
  operation = (async () => {
    while (pending) {
      if (expectedGeneration !== generation) break;
      pending = false;
      try {
        await refresh(expectedGeneration);
      } catch {
        appAtomRegistry.set(selfHostedPushStatusAtom, "Registration needs retry");
      }
    }
  })().finally(() => {
    operation = null;
    if (pending && installed) void refreshSelfHostedPush();
  });
  return operation;
}

export function armSelfHostedLiveActivityForLocalWork(environmentId: EnvironmentId): void {
  const target = appAtomRegistry
    .get(targetsAtom)
    .find((candidate) => candidate.environmentId === environmentId);
  if (!target || !registered.has(environmentId)) return;
  void loadPreferences()
    .then((preferences) => {
      if (
        preferences.selfHostedPushEnabled === false ||
        preferences.selfHostedLiveActivitiesEnabled === false
      )
        return;
      return reconcileActivity(target.relayUrl, generation, true);
    })
    .catch(() => {
      appAtomRegistry.set(selfHostedPushStatusAtom, "Live Activity registration needs retry");
    });
}

export async function unregisterSelfHostedPush(environmentId: EnvironmentId): Promise<void> {
  if (!registered.has(environmentId)) return;
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  try {
    await request(environmentId, { operation: "unregister", deviceId });
  } catch {
    appAtomRegistry.set(
      selfHostedPushStatusAtom,
      "Could not unregister remotely; revoke this device on the host to stop pending notifications",
    );
  }
  registered.delete(environmentId);
}

export function installSelfHostedPush(): () => void {
  if (Platform.OS !== "ios") return () => {};
  installed = true;
  generation++;
  // Only this factory's activities are touched; official Connect owns AgentActivity independently.
  for (const activity of selfHostedActivity.getInstances())
    void activity.end("immediate").catch(() => {});
  const unsubscribe = appAtomRegistry.subscribe(targetsAtom, () => {
    void refreshSelfHostedPush();
  });
  const foreground = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      registered.clear();
      void refreshSelfHostedPush();
    }
  });
  const token = Notifications.addPushTokenListener(() => {
    registered.clear();
    void refreshSelfHostedPush();
  });
  void refreshSelfHostedPush();
  return () => {
    installed = false;
    generation++;
    pending = false;
    unsubscribe();
    foreground.remove();
    token.remove();
    for (const listener of listeners.values()) listener.remove();
    listeners.clear();
    registered.clear();
    activityRelays.clear();
  };
}
