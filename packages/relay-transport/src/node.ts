// @effect-diagnostics globalTimers:off -- The Node socket adapter owns and clears its connection heartbeat timers.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This boundary proxies raw headers and streaming bodies without fetch decompression.
import * as NodeHttp from "node:http";
import { WebSocket } from "ws";

import { AsyncQueue, RelayChannel, type RelayStream } from "./channel.ts";
import { decodeHeaders, readSocketMessages, writeSocketMessage } from "./client.ts";
import {
  FrameKind,
  isRecord,
  MAX_SOCKET_MESSAGE,
  relaySocketUrl,
  validateRelayAddress,
  virtualRelayOrigin,
  type RelayAddress,
} from "./protocol.ts";
import { openSocket, secureSocket, type RelaySocketFactory } from "./secure.ts";

const nodeSocket: RelaySocketFactory = (url) => {
  const socket = new WebSocket(url, {
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  socket.once("open", () => {
    // Detect silent network loss locally even when the relay's close frame cannot reach us.
    heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30_000);
    heartbeat.unref();
  });
  socket.once("close", () => clearInterval(heartbeat));
  return socket;
};

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-prefix",
  "content-length",
  "accept-encoding",
]);

function requestTarget(origin: URL, path: unknown): URL {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("#")
  ) {
    throw new Error("Invalid relay request path.");
  }
  const target = new URL(path, origin);
  if (target.origin !== origin.origin)
    throw new Error("Relay requests must stay on the local T3 origin.");
  return target;
}

function filteredHeaders(value: unknown) {
  const headers = decodeHeaders(value);
  const connectionHeaders = (headers.get("connection") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  return Object.fromEntries(
    [...headers].filter(([name]) => !HOP_HEADERS.has(name) && !connectionHeaders.includes(name)),
  );
}

function responseHeaders(response: NodeHttp.IncomingMessage) {
  return Object.entries(response.headers).flatMap(([name, value]) => {
    if (
      (HOP_HEADERS.has(name) && name !== "content-length") ||
      name === "set-cookie" ||
      value === undefined
    )
      return [];
    return (Array.isArray(value) ? value : [value]).map((entry) => [name, entry]);
  });
}

async function proxyHttp(
  stream: RelayStream,
  metadata: Record<string, unknown>,
  origin: URL,
  agent: NodeHttp.Agent,
  relayOrigin: URL,
) {
  const target = requestTarget(origin, metadata.path);
  if (
    typeof metadata.method !== "string" ||
    !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(metadata.method)
  ) {
    throw new Error("Invalid relay HTTP method.");
  }
  const request = NodeHttp.request(target, {
    method: metadata.method,
    // All client aliases sign the same virtual origin. Never take proxy identity
    // headers from the caller; only the connector's configured route owns it.
    headers: {
      ...filteredHeaders(metadata.headers),
      host: relayOrigin.host,
      "x-forwarded-proto": "https",
    },
    agent,
  });
  const abort = () => request.destroy(new Error("Relay request cancelled."));
  stream.signal.addEventListener("abort", abort, { once: true });
  const responsePromise = new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  const upload = (async () => {
    for await (const frame of stream) {
      if (frame.kind !== FrameKind.Data) throw new Error("Invalid relay HTTP request body.");
      if (!request.write(frame.payload)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const onClose = () => {
            cleanup();
            reject(new Error("Local HTTP request closed."));
          };
          const cleanup = () => {
            request.off("drain", onDrain);
            request.off("error", onError);
            request.off("close", onClose);
          };
          request.once("drain", onDrain);
          request.once("error", onError);
          request.once("close", onClose);
        });
      }
    }
    request.end();
  })();
  void upload.catch(() => {
    request.destroy();
    stream.cancel();
  });
  let response: NodeHttp.IncomingMessage | undefined;
  try {
    response = await responsePromise;
    await stream.head({ status: response.statusCode ?? 502, headers: responseHeaders(response) });
    for await (const chunk of response) await stream.write(new Uint8Array(chunk));
    await stream.end();
    await upload;
  } finally {
    stream.signal.removeEventListener("abort", abort);
    if (!request.writableFinished || !response?.complete) request.destroy();
    if (!response?.complete) response?.destroy();
  }
}

async function proxyWebSocket(
  stream: RelayStream,
  metadata: Record<string, unknown>,
  origin: URL,
  relayOrigin: URL,
) {
  const target = requestTarget(origin, metadata.path);
  target.protocol = "ws:";
  if (
    !Array.isArray(metadata.protocols) ||
    metadata.protocols.length > 16 ||
    !metadata.protocols.every((value) => typeof value === "string")
  ) {
    throw new Error("Invalid relay WebSocket protocols.");
  }
  const socket = new WebSocket(target, metadata.protocols, {
    headers: { host: relayOrigin.host, "x-forwarded-proto": "https" },
    maxPayload: MAX_SOCKET_MESSAGE,
    perMessageDeflate: false,
  });
  const abort = () => socket.terminate();
  stream.signal.addEventListener("abort", abort, { once: true });
  let output = Promise.resolve();
  let queuedBytes = 0;
  let closeCode = 1000;
  let closeReason = "";
  let opened = false;
  let rejected = false;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  try {
    const opening = new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        opened = true;
        output = stream.head({ open: true, protocol: socket.protocol });
        void output.catch(() => {
          socket.terminate();
          stream.cancel();
        });
        resolve();
      });
      socket.once("unexpected-response", (_request, response) => {
        rejected = true;
        output = stream
          .head({
            open: false,
            status: response.statusCode ?? 502,
            headers: responseHeaders(response),
          })
          .then(() => stream.end());
        resolve();
      });
      socket.once("error", reject);
      socket.once("close", () => {
        if (!opened) reject(new Error("Local WebSocket rejected."));
      });
    });
    socket.on("message", (data, binary) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array(data);
      queuedBytes += bytes.length;
      if (queuedBytes > MAX_SOCKET_MESSAGE) {
        socket.terminate();
        stream.cancel();
        return;
      }
      socket.pause();
      output = output
        .then(() => writeSocketMessage(stream, bytes, binary))
        .then(() => {
          queuedBytes -= bytes.length;
          if (queuedBytes === 0) socket.resume();
        });
      void output.catch(() => {
        socket.terminate();
        stream.cancel();
      });
    });
    socket.once("close", (code, reason) => {
      if (!opened) return;
      output = output.then(async () => {
        await stream.head({ closeCode: code, closeReason: reason.toString() });
        await stream.end();
      });
      void output.catch(() => stream.cancel());
    });
    await opening;
    if (rejected) {
      await output;
      return;
    }
    await readSocketMessages(
      stream,
      (bytes, binary) =>
        new Promise<void>((resolve, reject) => {
          socket.send(bytes, { binary }, (error) => (error ? reject(error) : resolve()));
        }),
      (head) => {
        if (
          isRecord(head) &&
          typeof head.closeCode === "number" &&
          typeof head.closeReason === "string"
        ) {
          closeCode = head.closeCode;
          closeReason = head.closeReason;
        }
      },
    );
    socket.close(
      closeCode === 1000 || (closeCode >= 3000 && closeCode <= 4999) ? closeCode : 1000,
      closeReason.slice(0, 100),
    );
    await closed;
    await output;
  } finally {
    stream.signal.removeEventListener("abort", abort);
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

const publicGatewayPaths = new Set([
  "/mcp",
  "/.well-known/t3/environment",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/mcp/register",
  "/oauth/mcp/decision",
  "/oauth/mcp/token",
  "/oauth/mcp/revoke",
  "/api/peer-link/client-pairing",
  "/api/links/thread/stream",
  "/api/links/thread/history",
  "/api/links/thread/item",
]);

async function readEnvironment(origin: URL, signal: AbortSignal) {
  const response = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
    const request = NodeHttp.get(
      new URL("/.well-known/t3/environment", origin),
      { signal },
      resolve,
    );
    request.once("error", reject);
  });
  let text = "";
  for await (const chunk of response) {
    text += chunk.toString();
    if (text.length > 64 * 1024) {
      response.destroy();
      throw new Error("Environment descriptor is too large.");
    }
  }
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.environmentId !== "string" ||
    typeof value.label !== "string"
  )
    throw new Error("Invalid environment descriptor.");
  return { environmentId: value.environmentId, label: value.label };
}

async function serveGateway(input: {
  address: RelayAddress;
  id: string;
  ticket: string;
  origin: URL;
  environmentId: string;
  agent: NodeHttp.Agent;
  signal: AbortSignal;
}) {
  const socket = await openSocket(
    relaySocketUrl(input.address.relayUrl),
    { type: "session", id: input.id, ticket: input.ticket },
    nodeSocket,
    input.signal,
  );
  const messages = new AsyncQueue<string | Uint8Array>();
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", ({ data }) =>
    messages.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer)),
  );
  let request: NodeHttp.ClientRequest | undefined;
  let response: NodeHttp.IncomingMessage | undefined;
  const abort = () => {
    request?.destroy();
    response?.destroy();
    socket.close();
    messages.end(new Error("Relay gateway disconnected."));
  };
  socket.addEventListener("close", abort);
  socket.addEventListener("error", abort);
  input.signal.addEventListener("abort", abort, { once: true });
  const next = async () => {
    const item = await messages.next();
    if (item.done) throw new Error("Relay gateway closed.");
    return item.value;
  };
  try {
    const first = await next();
    if (typeof first !== "string" || first.length > 60 * 1024)
      throw new Error("Invalid gateway request.");
    const metadata: unknown = JSON.parse(first);
    if (
      !isRecord(metadata) ||
      typeof metadata.path !== "string" ||
      typeof metadata.method !== "string" ||
      !/^(GET|HEAD|POST|DELETE|OPTIONS)$/.test(metadata.method)
    )
      throw new Error("Invalid gateway request.");
    const target = requestTarget(input.origin, metadata.path);
    if (!publicGatewayPaths.has(target.pathname)) throw new Error("Unsupported gateway path.");
    const publicOrigin = new URL(input.address.relayUrl);
    request = NodeHttp.request(target, {
      method: metadata.method,
      agent: input.agent,
      headers: {
        ...filteredHeaders(metadata.headers),
        host: publicOrigin.host,
        "x-forwarded-proto": publicOrigin.protocol.slice(0, -1),
        "x-forwarded-prefix": `/v1/environments/${encodeURIComponent(input.environmentId)}`,
      },
    });
    const pending = new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
      request!.once("response", resolve);
      request!.once("error", reject);
    });
    void pending.catch(() => {});
    for (;;) {
      const message = await next();
      if (message === "end") break;
      if (!(message instanceof Uint8Array) || message.length > 60 * 1024)
        throw new Error("Invalid gateway body.");
      await new Promise<void>((resolve, reject) =>
        request!.write(message, (error) => (error ? reject(error) : resolve())),
      );
      socket.send("ack");
    }
    request.end();
    response = await pending;
    socket.send(
      JSON.stringify({ status: response.statusCode ?? 502, headers: responseHeaders(response) }),
    );
    for await (const bytes of response) {
      const chunk = new Uint8Array(bytes);
      for (let offset = 0; offset < chunk.length; offset += 60 * 1024) {
        if ((await next()) !== "pull") throw new Error("Invalid gateway flow control.");
        socket.send(chunk.slice(offset, offset + 60 * 1024));
      }
    }
    if ((await next()) !== "pull") throw new Error("Invalid gateway flow control.");
    socket.send("end");
  } finally {
    input.signal.removeEventListener("abort", abort);
    request?.destroy();
    response?.destroy();
    abort();
  }
}

export function validateLocalTarget(value: string): URL {
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("The relay connector target must be a loopback HTTP origin.");
  }
  return origin;
}

export async function connectHost(input: {
  readonly address: RelayAddress;
  readonly registrationToken: string;
  readonly privateKey: string;
  readonly target: string;
  readonly signal: AbortSignal;
  readonly onConnected?: () => void;
  readonly publishEnvironment?: boolean;
}) {
  const address = validateRelayAddress(input.address);
  const origin = validateLocalTarget(input.target);
  const relayOrigin = new URL(virtualRelayOrigin(address.route));
  const environment = input.publishEnvironment
    ? {
        ...(await readEnvironment(
          origin,
          AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]),
        )),
        peerId: address.peerId,
      }
    : undefined;
  const channels = new Set<RelayChannel>();
  const sessions = new Set<AbortController>();
  const socket = await openSocket(
    relaySocketUrl(address.relayUrl),
    {
      type: "host",
      route: address.route,
      token: input.registrationToken,
      ...(environment ? { environment } : {}),
    },
    nodeSocket,
    input.signal,
  );
  const agent = new NodeHttp.Agent({
    keepAlive: true,
    maxSockets: 64,
    maxFreeSockets: 8,
    scheduling: "lifo",
  });
  const close = () => {
    agent.destroy();
    socket.close();
    for (const session of sessions) session.abort();
    for (const channel of channels) channel.close();
  };
  input.signal.addEventListener("abort", close, { once: true });
  const session = async (id: string, ticket: string) => {
    if (channels.size + sessions.size >= 32) throw new Error("Relay client limit exceeded.");
    const controller = new AbortController();
    sessions.add(controller);
    const signal = AbortSignal.any([input.signal, controller.signal]);
    try {
      const socket = await openSocket(
        relaySocketUrl(address.relayUrl),
        { type: "session", id, ticket },
        nodeSocket,
        signal,
      );
      const wire = await secureSocket({
        socket,
        privateKey: input.privateKey,
        initiator: false,
        route: address.route,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      const channel = new RelayChannel(wire, (stream, metadata) => {
        if (!isRecord(metadata)) return Promise.reject(new Error("Invalid relay stream."));
        if (metadata.type === "http")
          return proxyHttp(stream, metadata, origin, agent, relayOrigin);
        if (metadata.type === "websocket")
          return proxyWebSocket(stream, metadata, origin, relayOrigin);
        return Promise.reject(new Error("Unknown relay stream type."));
      });
      sessions.delete(controller);
      channels.add(channel);
      try {
        await channel.done;
      } finally {
        channels.delete(channel);
      }
    } finally {
      sessions.delete(controller);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("close", () =>
        input.signal.aborted ? resolve() : reject(new Error("Relay host disconnected.")),
      );
      socket.addEventListener("error", () => reject(new Error("Relay host connection failed.")));
      socket.addEventListener("message", (event: { data: unknown }) => {
        try {
          if (typeof event.data !== "string" || event.data.length > 1024)
            throw new Error("Invalid relay session request.");
          const request: unknown = JSON.parse(event.data);
          if (
            !isRecord(request) ||
            (request.type !== "session" && request.type !== "gateway") ||
            typeof request.id !== "string" ||
            typeof request.ticket !== "string" ||
            !/^[a-f0-9]{64}$/.test(request.id) ||
            !/^[a-f0-9]{64}$/.test(request.ticket)
          ) {
            throw new Error("Invalid relay session request.");
          }
          if (request.type === "gateway") {
            if (!environment || sessions.size + channels.size >= 32)
              throw new Error("Gateway unavailable.");
            const controller = new AbortController();
            sessions.add(controller);
            void serveGateway({
              address,
              id: request.id,
              ticket: request.ticket,
              origin,
              environmentId: environment.environmentId,
              agent,
              signal: AbortSignal.any([input.signal, controller.signal]),
            })
              .catch(() => {})
              .finally(() => sessions.delete(controller));
          } else void session(request.id, request.ticket).catch(() => {});
        } catch {
          reject(new Error("Invalid relay control message."));
        }
      });
      input.onConnected?.();
      if (input.signal.aborted) close();
    });
  } finally {
    input.signal.removeEventListener("abort", close);
    close();
  }
}
