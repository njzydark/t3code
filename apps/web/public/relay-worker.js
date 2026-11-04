/* The page owns Noise keys; this worker only bridges browser-managed resource requests. */
const relayPath = /^\/__t3_relay\/([a-f0-9]{32})(\/.*)?$/;
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function relayFetch(event, route, path) {
  if (event.request.method !== "GET" && event.request.method !== "HEAD") {
    return new Response("Use the T3 client to upload through this connection.", { status: 405 });
  }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
  if (!windows.length)
    return new Response("Open T3 Code to use this relay connection.", { status: 503 });
  return new Promise((resolve) => {
    let chosen = null;
    let finished = false;
    let rejected = 0;
    let bodyController;
    let pendingPull;
    const ports = [];
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      event.request.signal.removeEventListener("abort", fail);
      pendingPull?.();
      for (const port of ports) {
        port.postMessage({ type: "cancel" });
        port.close();
      }
      if (bodyController) bodyController.error(new Error("Relay resource connection closed."));
      else resolve(new Response("The relay host is unavailable.", { status: 503 }));
    };
    let deadline = setTimeout(fail, 15000);
    const complete = () => {
      clearTimeout(deadline);
      finished = true;
      event.request.signal.removeEventListener("abort", fail);
      for (const port of ports) port.close();
    };
    for (const window of windows) {
      const channel = new MessageChannel();
      const port = channel.port1;
      ports.push(port);
      port.onmessage = ({ data }) => {
        if (finished) return;
        if (data.type === "available" && chosen === null) {
          chosen = port;
          port.postMessage({ type: "start" });
          for (const other of ports)
            if (other !== port) {
              // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort has no targetOrigin argument.
              other.postMessage({ type: "cancel" });
              other.close();
            }
        } else if (data.type === "head" && port === chosen) {
          clearTimeout(deadline);
          const headers = new Headers(data.headers);
          headers.set("X-Content-Type-Options", "nosniff");
          const nativePdf =
            path.startsWith("/api/assets/") &&
            headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ===
              "application/pdf";
          // PDF plugins require an unsandboxed response; active documents still need isolation.
          if (!nativePdf)
            headers.append(
              "Content-Security-Policy",
              "sandbox allow-scripts allow-forms allow-popups allow-downloads",
            );
          const body =
            event.request.method === "HEAD" || [204, 205, 304].includes(data.status)
              ? null
              : new ReadableStream({
                  start(controller) {
                    bodyController = controller;
                  },
                  pull() {
                    deadline = setTimeout(fail, 30000);
                    port.postMessage({ type: "pull" });
                    return new Promise((resolve) => {
                      pendingPull = resolve;
                    });
                  },
                  cancel() {
                    port.postMessage({ type: "cancel" });
                    complete();
                  },
                });
          resolve(new Response(body, { status: data.status, headers }));
          if (body === null) complete();
        } else if (port === chosen && data.type === "chunk") {
          clearTimeout(deadline);
          bodyController.enqueue(new Uint8Array(data.bytes));
          pendingPull?.();
          pendingPull = undefined;
        } else if (port === chosen && data.type === "end") {
          bodyController.close();
          pendingPull?.();
          complete();
        } else if (data.type === "error" || data.type === "unavailable") {
          if (port === chosen || (++rejected === windows.length && chosen === null)) fail();
        }
      };
      window.postMessage(
        {
          type: "t3-relay-fetch",
          url: `https://${route}.t3-relay.invalid${path}`,
          method: event.request.method,
          headers: [...event.request.headers],
        },
        [channel.port2],
      );
    }
    event.request.signal.addEventListener("abort", fail, { once: true });
    if (event.request.signal.aborted) fail();
  });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = relayPath.exec(url.pathname);
  const virtual = /^([a-f0-9]{32})\.t3-relay\.invalid$/.exec(url.hostname);
  if (url.origin === self.location.origin && match) {
    event.respondWith(relayFetch(event, match[1], (match[2] || "/") + url.search));
  } else if (virtual) {
    event.respondWith(relayFetch(event, virtual[1], url.pathname + url.search));
  }
});
