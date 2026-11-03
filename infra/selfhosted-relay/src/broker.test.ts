// @effect-diagnostics-next-line nodeBuiltinImport:off -- Network fixture for the standalone transport, not an Effect service.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import type * as NodeNet from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vite-plus/test";
import { EncryptedRelayClient } from "@t3tools/relay-transport";
import { connectHost } from "@t3tools/relay-transport/node";
import { generateIdentity } from "@t3tools/relay-transport/secure";
import { createRelayBroker } from "../test/broker.ts";

const TOKEN = "test-registration-token-with-32-characters";

async function listen(server: NodeHttp.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
}

async function fixture() {
  const broker = await createRelayBroker({ registrationToken: TOKEN });
  const relayUrl = broker.url;
  const uploads: Uint8Array[] = [];
  let cancelStarted!: () => void;
  let cancelClosed!: () => void;
  const started = new Promise<void>((resolve) => {
    cancelStarted = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    cancelClosed = resolve;
  });
  const http = NodeHttp.createServer(async (request, response) => {
    if (request.url === "/cancel") {
      cancelStarted();
      response.once("close", cancelClosed);
      return;
    }
    if (request.headers.authorization !== "Bearer t3-session") {
      response.writeHead(401);
      response.end("unauthorized");
      return;
    }
    if (request.url === "/large") {
      const bytes = Buffer.alloc(2 * 1024 * 1024, 23);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.length,
      });
      response.end(bytes);
      return;
    }
    if (request.method === "POST") {
      for await (const chunk of request) uploads.push(new Uint8Array(chunk));
      response.end(String(uploads.reduce((sum, bytes) => sum + bytes.length, 0)));
    } else {
      const range = request.headers.range;
      response.writeHead(range ? 206 : 200, {
        "content-type": "application/octet-stream",
        ...(range ? { "content-range": "bytes 1-3/5" } : {}),
      });
      if (request.method !== "HEAD") response.end(range ? "ell" : "hello");
      else response.end();
    }
  });
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", (socket) => {
    socket.send("relay-welcome");
    socket.on("message", (bytes, binary) => socket.send(bytes, { binary }));
  });
  const target = await listen(http);
  const identity = await generateIdentity();
  const address = { relayUrl, route: "1234567890abcdef1234567890abcdef", peerId: identity.peerId };
  const controller = new AbortController();
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const host = connectHost({
    address,
    registrationToken: TOKEN,
    privateKey: identity.privateKey,
    target,
    signal: controller.signal,
    onConnected: connected,
  });
  await Promise.race([ready, host]);
  const client = new EncryptedRelayClient(
    (url) => new WebSocket(url, { perMessageDeflate: false }),
  );
  const endpoint = client.register(address).httpBaseUrl;
  return {
    client,
    endpoint,
    address,
    started,
    cancelled,
    async [Symbol.asyncDispose]() {
      client.dispose();
      controller.abort();
      await host;
      await broker.close();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

describe("self-hosted encrypted relay", () => {
  it("preserves server authorization, HTTP range and headers, and streams uploads larger than its window", async () => {
    await using test = await fixture();
    const unauthorized = await test.client.fetch(`${test.endpoint}/file`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toBe("unauthorized");
    const response = await test.client.fetch(`${test.endpoint}/file`, {
      headers: { authorization: "Bearer t3-session", range: "bytes=1-3" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(await response.text()).toBe("ell");
    const upload = await test.client.fetch(`${test.endpoint}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer t3-session" },
      body: new Uint8Array(2 * 1024 * 1024).fill(42),
    });
    expect(await upload.text()).toBe(String(2 * 1024 * 1024));
    const head = await test.client.fetch(`${test.endpoint}/file`, {
      method: "HEAD",
      headers: { authorization: "Bearer t3-session" },
    });
    expect(head.body).toBeNull();
    const large = await test.client.fetch(`${test.endpoint}/large`, {
      headers: { authorization: "Bearer t3-session" },
    });
    expect(large.headers.get("content-length")).toBe(String(2 * 1024 * 1024));
    expect(new Uint8Array(await large.arrayBuffer())).toEqual(
      new Uint8Array(2 * 1024 * 1024).fill(23),
    );
    test.client.disconnect(test.address.route);
    const reconnected = await test.client.fetch(`${test.endpoint}/file`, {
      headers: { authorization: "Bearer t3-session" },
    });
    expect(await reconnected.text()).toBe("hello");
  });

  it("preserves WebSocket text, binary message boundaries, and concurrent HTTP streams", async () => {
    await using test = await fixture();
    const socket = test.client.socket(test.endpoint.replace("https:", "wss:") + "/ws");
    socket.binaryType = "arraybuffer";
    const messages: unknown[] = [];
    const received = new Promise<void>((resolve) => {
      socket.onmessage = (event) => {
        messages.push(event.data);
        if (event.data instanceof ArrayBuffer) resolve();
      };
    });
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Socket failed"));
    });
    const bytes = new Uint8Array(512 * 1024).fill(17);
    socket.send("test text");
    socket.send(bytes);
    const response = await test.client.fetch(`${test.endpoint}/file`, {
      headers: { authorization: "Bearer t3-session" },
    });
    expect(await response.text()).toBe("hello");
    await received;
    expect(messages[0]).toBe("relay-welcome");
    expect(messages[1]).toBe("test text");
    expect(new Uint8Array(messages[2] as ArrayBuffer)).toEqual(bytes);
    const closed = new Promise<void>((resolve) => {
      socket.onclose = () => resolve();
    });
    socket.close();
    await closed;
  });

  it("rejects a relay that routes to a different host identity", async () => {
    await using test = await fixture();
    const wrongIdentity = await generateIdentity();
    test.client.register({ ...test.address, peerId: wrongIdentity.peerId });
    await expect(test.client.fetch(`${test.endpoint}/file`)).rejects.toThrow();
  });

  it("cancels an in-flight request without breaking other streams", async () => {
    await using test = await fixture();
    const controller = new AbortController();
    const request = test.client.fetch(`${test.endpoint}/cancel`, { signal: controller.signal });
    const rejected = expect(request).rejects.toThrow();
    await test.started;
    controller.abort();
    await rejected;
    await test.cancelled;
    const response = await test.client.fetch(`${test.endpoint}/file`, {
      headers: { authorization: "Bearer t3-session" },
    });
    expect(await response.text()).toBe("hello");
  });

  it("rejects unauthenticated host registration", async () => {
    const broker = await createRelayBroker({ registrationToken: TOKEN });
    try {
      const url = broker.url;
      const socket = new WebSocket(url.replace("http:", "ws:") + "/v1/socket");
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({ type: "host", route: "1234567890abcdef1234567890abcdef", token: "wrong" }),
      );
      const code = await new Promise<number>((resolve) => socket.once("close", resolve));
      expect(code).toBe(1008);
    } finally {
      await broker.close();
    }
  });

  it("keeps host routes exclusive, authenticates one-use session tickets, and retains immediately buffered ciphertext", async () => {
    const broker = await createRelayBroker({ registrationToken: TOKEN });
    const sockets: WebSocket[] = [];
    const readers: AsyncIterator<unknown[]>[] = [];
    const open = async () => {
      const socket = new WebSocket(broker.url.replace("http:", "ws:") + "/v1/socket");
      sockets.push(socket);
      const messages = NodeEvents.EventEmitter.on(socket, "message");
      readers.push(messages);
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      await NodeEvents.EventEmitter.once(socket, "open");
      return {
        socket,
        closed,
        async read() {
          const result = await messages.next();
          return result.value as [Buffer, boolean];
        },
      };
    };
    const route = "1234567890abcdef1234567890abcdef";
    try {
      const host = await open();
      host.socket.send(JSON.stringify({ type: "host", route, token: TOKEN }));
      expect(JSON.parse((await host.read())[0].toString())).toEqual({ type: "ready" });
      const duplicate = await open();
      duplicate.socket.send(JSON.stringify({ type: "host", route, token: TOKEN }));
      expect(await duplicate.closed).toBe(1008);

      const client = await open();
      client.socket.send(JSON.stringify({ type: "client", route }));
      const notification = JSON.parse((await host.read())[0].toString()) as {
        id: string;
        ticket: string;
        type: string;
      };
      expect(notification.type).toBe("session");
      const wrong = await open();
      wrong.socket.send(JSON.stringify({ ...notification, ticket: "wrong" }));
      expect(await wrong.closed).toBe(1008);

      const session = await open();
      session.socket.send(JSON.stringify(notification));
      const ciphertext = Buffer.alloc(60 * 1024, 37);
      session.socket.send(ciphertext);
      expect(JSON.parse((await session.read())[0].toString())).toEqual({ type: "ready" });
      expect(JSON.parse((await client.read())[0].toString())).toEqual({ type: "ready" });
      const [received, binary] = await client.read();
      expect(binary).toBe(true);
      expect(received).toEqual(ciphertext);

      const replay = await open();
      replay.socket.send(JSON.stringify(notification));
      expect(await replay.closed).toBe(1008);
      client.socket.send("not ciphertext");
      expect(await client.closed).toBe(1008);
      await session.closed;

      const pending = await open();
      pending.socket.send(JSON.stringify({ type: "client", route }));
      const stale = JSON.parse((await host.read())[0].toString()) as {
        id: string;
        ticket: string;
        type: string;
      };
      host.socket.close();
      expect(await pending.closed).toBe(1012);
      await host.closed;
      const staleSession = await open();
      staleSession.socket.send(JSON.stringify(stale));
      expect(await staleSession.closed).toBe(1008);
    } finally {
      for (const reader of readers) await reader.return?.();
      for (const socket of sockets) socket.terminate();
      await broker.close();
    }
  });
});
