// @effect-diagnostics globalTimers:off -- The Node socket adapter owns and clears its connection heartbeat timers.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This boundary proxies raw headers and streaming bodies without fetch decompression.
import * as NodeHttp from "node:http";
import { WebSocket } from "ws";

import { RelayChannel, type RelayStream } from "./channel.ts";
import { decodeHeaders, readSocketMessages, writeSocketMessage } from "./client.ts";
import {
  FrameKind,
  isRecord,
  MAX_SOCKET_MESSAGE,
  relaySocketUrl,
  validateRelayAddress,
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

async function proxyHttp(stream: RelayStream, metadata: Record<string, unknown>, origin: URL) {
  const target = requestTarget(origin, metadata.path);
  if (
    typeof metadata.method !== "string" ||
    !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(metadata.method)
  ) {
    throw new Error("Invalid relay HTTP method.");
  }
  const request = NodeHttp.request(target, {
    method: metadata.method,
    headers: filteredHeaders(metadata.headers),
    agent: false,
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
    request.destroy();
    response?.destroy();
  }
}

async function proxyWebSocket(stream: RelayStream, metadata: Record<string, unknown>, origin: URL) {
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
      output = output.then(async () => {
        await stream.head({ closeCode: code, closeReason: reason.toString() });
        await stream.end();
      });
      void output.catch(() => stream.cancel());
    });
    await opening;
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
}) {
  const address = validateRelayAddress(input.address);
  const origin = validateLocalTarget(input.target);
  const channels = new Set<RelayChannel>();
  const sessions = new Set<AbortController>();
  const socket = await openSocket(
    relaySocketUrl(address.relayUrl),
    {
      type: "host",
      route: address.route,
      token: input.registrationToken,
    },
    nodeSocket,
    input.signal,
  );
  const close = () => {
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
        if (metadata.type === "http") return proxyHttp(stream, metadata, origin);
        if (metadata.type === "websocket") return proxyWebSocket(stream, metadata, origin);
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
            request.type !== "session" ||
            typeof request.id !== "string" ||
            typeof request.ticket !== "string" ||
            !/^[a-f0-9]{64}$/.test(request.id) ||
            !/^[a-f0-9]{64}$/.test(request.ticket)
          ) {
            throw new Error("Invalid relay session request.");
          }
          void session(request.id, request.ticket).catch(() => {});
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
