import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { createRelayNetwork } from "@t3tools/relay-transport/network";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

let workerReady: Promise<void> | undefined;

function ensureResourceWorker() {
  if (workerReady) return workerReady;
  workerReady = (async () => {
    if (!("serviceWorker" in navigator))
      throw new Error("This client needs service worker support for relay resources.");
    const signal = AbortSignal.timeout(15_000);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", aborted);
        navigator.serviceWorker.removeEventListener("controllerchange", changed);
      };
      const changed = () => {
        if (
          navigator.serviceWorker.controller?.scriptURL ===
          new URL("/relay-worker.js", location.href).href
        ) {
          cleanup();
          resolve();
        }
      };
      const aborted = () => {
        cleanup();
        reject(new Error("The relay resource worker did not become ready."));
      };
      signal.addEventListener("abort", aborted, { once: true });
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      void navigator.serviceWorker
        .register("/relay-worker.js", { scope: "/" })
        .then(changed, (error) => {
          cleanup();
          reject(error);
        });
    });
  })();
  void workerReady.catch(() => {
    workerReady = undefined;
  });
  return workerReady;
}

export const relayNetwork = createRelayNetwork({
  endpoint: async (address) => {
    await ensureResourceWorker();
    return `${window.location.origin}/__t3_relay/${address.route}/`;
  },
});

const uninstall = relayNetwork.install();

const onWorkerMessage = (event: MessageEvent) => {
  const input = event.data;
  const port = event.ports[0];
  if (input?.type !== "t3-relay-fetch" || !port || typeof input.url !== "string") return;
  const route = relayNetwork.transport.routeForUrl(input.url);
  if (!route || !relayNetwork.transport.hasRoute(route)) {
    port.postMessage({ type: "unavailable" });
    port.close();
    return;
  }
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pulling = false;
  let started = false;
  const start = () => {
    if (started || controller.signal.aborted) return;
    started = true;
    void relayNetwork.transport
      .fetch(input.url, {
        method: input.method,
        headers: input.headers,
        signal: controller.signal,
      })
      .then(
        (response) => {
          reader = response.body?.getReader();
          port.postMessage({
            type: "head",
            status: response.status,
            headers: [...response.headers],
          });
        },
        () => {
          port.postMessage({ type: "error" });
          port.close();
        },
      );
  };
  port.onmessage = ({ data }) => {
    if (data.type === "cancel") {
      controller.abort();
      void reader?.cancel().catch(() => {});
      port.close();
    } else if (data.type === "start") {
      start();
    } else if (data.type === "pull" && reader && !pulling) {
      pulling = true;
      void reader
        .read()
        .then(
          (chunk) => {
            if (chunk.done) {
              port.postMessage({ type: "end" });
              port.close();
            } else {
              const bytes = chunk.value.slice().buffer;
              port.postMessage({ type: "chunk", bytes }, [bytes]);
            }
          },
          () => {
            port.postMessage({ type: "error" });
            port.close();
          },
        )
        .finally(() => {
          pulling = false;
        });
    }
  };
  port.postMessage({ type: "available" });
};

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", onWorkerMessage);
}

export const layer = Layer.succeed(ClientCapabilities.SelfHostedRelayGateway, {
  disconnect: Effect.fn("SelfHostedRelayGateway.disconnect")((address) =>
    Effect.sync(() => relayNetwork.transport.forget(address.route)),
  ),
  prepare: Effect.fn("SelfHostedRelayGateway.prepare")((address) =>
    Effect.tryPromise({
      try: () => relayNetwork.prepare(address),
      catch: () =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail:
            "Could not initialize self-hosted relay access. Open this app over HTTPS and allow service workers.",
        }),
    }),
  ),
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    uninstall();
    navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
  });
}
