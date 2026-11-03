import "./relayCrypto";
import { requireOptionalNativeModule } from "expo";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { createRelayNetwork } from "@t3tools/relay-transport/network";
import {
  serveLocalRelayRequest,
  type LocalRelayBridge,
  type LocalRelayRequest,
} from "@t3tools/relay-transport/local-bridge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

interface RelayBridgeModule extends LocalRelayBridge {
  addListener(event: "request", listener: (request: LocalRelayRequest) => void): { remove(): void };
  addListener(
    event: "closed",
    listener: (event: { readonly id: string }) => void,
  ): { remove(): void };
}

const ports = new Map<string, Promise<number>>();
const requests = new Map<string, AbortController>();
let bridge: RelayBridgeModule | null = null;
let subscriptions: { remove(): void }[] = [];

function nativeBridge() {
  if (bridge) return bridge;
  bridge = requireOptionalNativeModule<RelayBridgeModule>("T3RelayBridge");
  if (!bridge) throw new Error("Install a native build that includes self-hosted relay support.");
  const current = bridge;
  subscriptions = [
    current.addListener("request", (request) => {
      const controller = new AbortController();
      requests.set(request.id, controller);
      void serveLocalRelayRequest(relayNetwork.transport, current, request, controller.signal)
        .catch(() => current.close(request.id))
        .finally(() => requests.delete(request.id));
    }),
    current.addListener("closed", ({ id }) => {
      requests.get(id)?.abort();
      requests.delete(id);
    }),
  ];
  return current;
}

export const relayNetwork = createRelayNetwork({
  // Native fetch, images, AVKit, downloads and WebViews all use the loopback bridge.
  interceptHttp: false,
  endpoint: async (address) => {
    let port = ports.get(address.route);
    if (!port) {
      port = nativeBridge().start(address.route);
      ports.set(address.route, port);
      void port.catch(() => ports.delete(address.route));
    }
    return `http://127.0.0.1:${await port}/`;
  },
});

const uninstall = relayNetwork.install();

async function disconnect(route: string) {
  relayNetwork.transport.forget(route);
  const pending = ports.get(route);
  ports.delete(route);
  if (pending) {
    await pending.catch(() => {});
    await bridge?.stop(route).catch(() => {});
  }
}

export const layer = Layer.succeed(ClientCapabilities.SelfHostedRelayGateway, {
  disconnect: Effect.fn("SelfHostedRelayGateway.disconnect")((address) =>
    Effect.promise(() => disconnect(address.route)),
  ),
  prepare: Effect.fn("SelfHostedRelayGateway.prepare")((address) =>
    Effect.tryPromise({
      try: () => relayNetwork.prepare(address),
      catch: () =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail:
            "Could not initialize self-hosted relay access. Install the native client built from this fork.",
        }),
    }),
  ),
});

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () => {
  uninstall();
  for (const subscription of subscriptions) subscription.remove();
  for (const controller of requests.values()) controller.abort();
  requests.clear();
  subscriptions = [];
  for (const route of ports.keys()) void disconnect(route);
});
