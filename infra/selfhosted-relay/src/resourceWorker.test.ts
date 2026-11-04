// @effect-diagnostics nodeBuiltinImport:off -- Exercise the shipped service worker at its resource-response boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeVM from "node:vm";
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it } from "vite-plus/test";

it.each([
  { mime: "application/pdf", csp: null, sandbox: false },
  { mime: "Application/PDF; charset=binary", csp: null, sandbox: false },
  { mime: "application/pdf", csp: "default-src 'none'; sandbox", sandbox: true },
  { mime: "text/html", csp: null, sandbox: true },
  { mime: "image/svg+xml", csp: null, sandbox: true },
  { mime: "application/octet-stream", csp: null, sandbox: true },
  { mime: "application/pdf", csp: null, sandbox: true, path: "/api/other/guide.pdf" },
])("preserves native PDF access and document isolation: $mime ($csp)", async (input) => {
  const origin = "https://relay.test";
  const route = "a".repeat(32);
  const path = input.path ?? "/api/assets/token/guide.pdf";
  const response = Promise.withResolvers<Response>();
  const ports: NodeWorkerThreads.MessagePort[] = [];
  const worker = {
    location: { origin },
    clients: {
      matchAll: async () => [
        {
          postMessage: (
            message: { url: string; method: string; headers: string[][] },
            transferred: NodeWorkerThreads.MessagePort[],
          ) => {
            expect(message.url).toBe(`https://${route}.t3-relay.invalid${path}`);
            expect(message.method).toBe("HEAD");
            expect(message.headers).toContainEqual(["range", "bytes=0-31"]);
            const port = transferred[0]!;
            ports.push(port);
            port.on("message", (message) => {
              if (message.type === "start") {
                port.postMessage({
                  type: "head",
                  status: 206,
                  headers: [
                    ["content-type", input.mime],
                    ["content-range", "bytes 0-31/1024"],
                    ["content-length", "32"],
                    ...(input.csp ? [["content-security-policy", input.csp]] : []),
                  ],
                });
              }
            });
            port.postMessage({ type: "available" });
          },
        },
      ],
    },
    addEventListener: (
      name: string,
      listener: (event: {
        request: Request;
        respondWith: (value: Promise<Response>) => void;
      }) => void,
    ) => {
      if (name === "fetch") {
        listener({
          request: new Request(`${origin}/__t3_relay/${route}${path}`, {
            method: "HEAD",
            headers: { Range: "bytes=0-31" },
          }),
          respondWith: (value) => response.resolve(value),
        });
      }
    },
  };
  try {
    const source = await NodeFSP.readFile(
      new URL("../../../apps/web/public/relay-worker.js", import.meta.url),
      "utf8",
    );
    NodeVM.runInNewContext(source, {
      self: worker,
      URL,
      Request,
      Response,
      Headers,
      ReadableStream,
      MessageChannel: NodeWorkerThreads.MessageChannel,
      setTimeout,
      clearTimeout,
    });
    const result = await response.promise;
    expect(result.status).toBe(206);
    expect(result.headers.get("content-range")).toBe("bytes 0-31/1024");
    expect(result.headers.get("content-length")).toBe("32");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    const policy = result.headers.get("content-security-policy");
    if (input.sandbox) expect(policy).toContain("sandbox");
    else expect(policy).toBeNull();
    if (input.csp) expect(policy).toContain(input.csp);
    expect(await result.text()).toBe("");
  } finally {
    for (const port of ports) port.close();
  }
});
