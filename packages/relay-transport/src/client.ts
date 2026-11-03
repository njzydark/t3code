import { RelayChannel, type RelayStream } from "./channel.ts";
import {
  FRAME_BYTES,
  FrameKind,
  isRecord,
  MAX_SOCKET_MESSAGE,
  readJson,
  relayRouteFromUrl,
  relayRequestPath,
  relaySocketUrl,
  validateRelayAddress,
  virtualRelayOrigin,
  type RelayAddress,
} from "./protocol.ts";
import type { RelaySocketFactory } from "./secure.ts";

export { type RelayAddress, relayRouteFromUrl, virtualRelayOrigin } from "./protocol.ts";

export function parseRelayPairingUrl(value: string): (RelayAddress & { token: string }) | null {
  const url = new URL(value);
  const hash = new URLSearchParams(url.hash.slice(1));
  if (hash.get("relay") !== "1") return null;
  const address = validateRelayAddress({
    relayUrl: url.origin,
    route: hash.get("route") ?? "",
    peerId: hash.get("peer") ?? "",
  });
  const token = hash.get("token") ?? "";
  if (!token) throw new Error("The relay pairing link is missing its pairing code.");
  return { ...address, token };
}

export function buildRelayPairingUrl(address: RelayAddress, token: string): string {
  const validated = validateRelayAddress(address);
  const url = new URL("/pair", validated.relayUrl);
  url.hash = new URLSearchParams({
    relay: "1",
    route: validated.route,
    peer: validated.peerId,
    token,
  }).toString();
  return url.href;
}

function decodeHeaders(value: unknown): Headers {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid relay headers.");
  const headers = new Headers();
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new Error("Invalid relay headers.");
    }
    headers.append(entry[0], entry[1]);
  }
  return headers;
}

export { decodeHeaders };

export interface RelayHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function sendBody(stream: RelayStream, body: ReadableStream<Uint8Array> | null) {
  if (!body) return stream.end();
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      await stream.write(next.value);
    }
    await stream.end();
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    stream.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class EncryptedRelayClient {
  private readonly addresses = new Map<string, RelayAddress>();
  private readonly channels = new Map<string, Promise<RelayChannel>>();
  private readonly openings = new Map<string, AbortController>();
  private readonly aliases = new Map<string, string>();
  private readonly socketFactory: RelaySocketFactory;

  constructor(socketFactory: RelaySocketFactory = (url) => new WebSocket(url)) {
    this.socketFactory = socketFactory;
  }

  register(address: RelayAddress, endpoint?: string) {
    const valid = validateRelayAddress(address);
    const previous = this.addresses.get(valid.route);
    if (previous && (previous.peerId !== valid.peerId || previous.relayUrl !== valid.relayUrl)) {
      this.disconnect(valid.route);
    }
    this.addresses.set(valid.route, valid);
    const httpBaseUrl = endpoint ?? virtualRelayOrigin(valid.route);
    if (endpoint && !relayRouteFromUrl(endpoint))
      this.aliases.set(new URL(endpoint).host, valid.route);
    return { httpBaseUrl, wsBaseUrl: httpBaseUrl.replace(/^http/, "ws") };
  }

  routeForUrl(value: string) {
    try {
      return relayRouteFromUrl(value) ?? this.aliases.get(new URL(value).host) ?? null;
    } catch {
      return null;
    }
  }

  hasRoute(route: string) {
    return this.addresses.has(route);
  }

  forget(route: string) {
    this.disconnect(route);
    this.addresses.delete(route);
    for (const [host, savedRoute] of this.aliases)
      if (savedRoute === route) this.aliases.delete(host);
  }

  disconnect(route: string) {
    this.openings.get(route)?.abort();
    this.openings.delete(route);
    const current = this.channels.get(route);
    this.channels.delete(route);
    void current?.then(
      (channel) => channel.close(),
      () => {},
    );
  }

  dispose() {
    for (const route of this.channels.keys()) this.disconnect(route);
    this.addresses.clear();
    this.aliases.clear();
  }

  private channel(route: string): Promise<RelayChannel> {
    const current = this.channels.get(route);
    if (current) return current;
    const address = this.addresses.get(route);
    if (!address) return Promise.reject(new Error("This relay host has not been paired."));
    const controller = new AbortController();
    this.openings.set(route, controller);
    const opening = (async () => {
      const { openSocket, secureSocket } = await import("./secure.ts");
      const socket = await openSocket(
        relaySocketUrl(address.relayUrl),
        {
          type: "client",
          route,
        },
        this.socketFactory,
        controller.signal,
      );
      const wire = await secureSocket({
        socket,
        remotePeer: address.peerId,
        initiator: true,
        route,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      const channel = new RelayChannel(wire);
      if (controller.signal.aborted) {
        channel.close();
        throw controller.signal.reason;
      }
      void channel.done
        .finally(() => {
          if (this.channels.get(route) === opening) this.channels.delete(route);
        })
        .catch(() => {});
      return channel;
    })();
    this.channels.set(route, opening);
    void opening
      .finally(() => {
        if (this.openings.get(route) === controller) this.openings.delete(route);
      })
      .catch(() => {
        if (this.channels.get(route) === opening) this.channels.delete(route);
      });
    return opening;
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const response = await this.request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  async request(request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly body: ReadableStream<Uint8Array> | null;
    readonly signal: AbortSignal;
  }): Promise<RelayHttpResponse> {
    const route = this.routeForUrl(request.url);
    if (!route) throw new Error("Expected a relay environment URL.");
    request.signal.throwIfAborted();
    const channel = await abortable(this.channel(route), request.signal);
    request.signal.throwIfAborted();
    const stream = await channel.open({
      type: "http",
      method: request.method,
      path: relayRequestPath(request.url),
      headers: [...request.headers],
    });
    const abort = () => stream.cancel();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const cleanup = () => request.signal.removeEventListener("abort", abort);
    void sendBody(stream, request.body).catch(() => {});
    try {
      const first = await stream.next();
      if (first.done || first.value.kind !== FrameKind.Head)
        throw new Error("Missing relay HTTP response.");
      const head = readJson(first.value.payload);
      if (
        !isRecord(head) ||
        !Number.isInteger(head.status) ||
        typeof head.status !== "number" ||
        head.status < 200 ||
        head.status > 599
      ) {
        throw new Error("Invalid relay HTTP response.");
      }
      const headers = decodeHeaders(head.headers);
      if (request.method === "HEAD" || [204, 205, 304].includes(head.status)) {
        for await (const frame of stream) {
          if (frame.payload.length) throw new Error("Unexpected relay response body.");
        }
        cleanup();
        return { body: null, status: head.status, headers };
      }
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const next = await stream.next();
              if (next.done) {
                cleanup();
                controller.close();
              } else {
                if (next.value.kind !== FrameKind.Data) throw new Error("Invalid relay HTTP body.");
                controller.enqueue(next.value.payload);
              }
            } catch (error) {
              cleanup();
              stream.cancel();
              controller.error(error);
            }
          },
          cancel() {
            cleanup();
            stream.cancel();
          },
        },
        { highWaterMark: 0 },
      );
      return { body, status: head.status, headers };
    } catch (error) {
      cleanup();
      stream.cancel();
      throw error;
    }
  }

  socket(url: string, protocols?: string | string[]): RelayWebSocket {
    return new RelayWebSocket(this, url, protocols);
  }

  async openSocket(url: string, protocols?: string | string[]) {
    const route = this.routeForUrl(url);
    if (!route) throw new Error("Expected a relay environment URL.");
    return (await this.channel(route)).open({
      type: "websocket",
      path: relayRequestPath(url),
      protocols: typeof protocols === "string" ? [protocols] : (protocols ?? []),
    });
  }
}

// RPC and device streams need the browser WebSocket event surface, including message boundaries.
export class RelayWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  bufferedAmount = 0;
  binaryType: "blob" | "arraybuffer" = "blob";
  protocol = "";
  readonly extensions = "";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private stream: RelayStream | undefined;
  private writing = Promise.resolve();
  private closeCode = 1006;
  private closeReason = "";
  private messageConsumer: ((bytes: Uint8Array, binary: boolean) => Promise<void>) | undefined;
  readonly url: string;

  constructor(client: EncryptedRelayClient, url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    void this.run(client, protocols).catch(() => {
      this.stream?.cancel();
      if (this.readyState === 3) return;
      const error = new Event("error");
      this.dispatchEvent(error);
      this.onerror?.(error);
      this.finish();
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error("Relay WebSocket is not open.");
    const binary = typeof data !== "string";
    const input =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof Blob
          ? data
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
            : new Uint8Array(data).slice();
    const length = input instanceof Blob ? input.size : input.byteLength;
    if (length > MAX_SOCKET_MESSAGE || this.bufferedAmount + length > MAX_SOCKET_MESSAGE) {
      this.close(1009, "Relay WebSocket send buffer exceeded.");
      throw new Error("Relay WebSocket message is too large.");
    }
    this.bufferedAmount += length;
    this.writing = this.writing.then(async () => {
      const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
      const stream = this.stream;
      if (!stream) throw new Error("Relay WebSocket is closed.");
      await writeSocketMessage(stream, bytes, binary);
      this.bufferedAmount -= length;
    });
    void this.writing.catch(() => this.close());
  }

  consumeMessages(consumer: (bytes: Uint8Array, binary: boolean) => Promise<void>) {
    this.messageConsumer = consumer;
  }

  flushed() {
    return this.writing;
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    if (new TextEncoder().encode(reason).length > 123)
      throw new Error("WebSocket close reason is too long.");
    this.readyState = 2;
    this.closeCode = code;
    this.closeReason = reason;
    void this.writing
      .then(async () => {
        if (this.stream) {
          await this.stream.head({ closeCode: code, closeReason: reason });
          await this.stream.end();
        }
        this.finish();
      })
      .catch(() => {
        this.stream?.cancel();
        this.finish();
      });
  }

  private finish() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.bufferedAmount = 0;
    // Hermes provides Event but some native runtimes do not provide CloseEvent.
    const event = Object.assign(new Event("close"), {
      code: this.closeCode,
      reason: this.closeReason,
      wasClean: this.closeCode !== 1006,
    }) as CloseEvent;
    this.dispatchEvent(event);
    this.onclose?.(event);
  }

  private async run(client: EncryptedRelayClient, protocols?: string | string[]) {
    const stream = await client.openSocket(this.url, protocols);
    this.stream = stream;
    if (this.readyState !== 0) {
      stream.cancel();
      this.finish();
      return;
    }
    const first = await stream.next();
    if (first.done || first.value.kind !== FrameKind.Head)
      throw new Error("Missing relay WebSocket response.");
    const head = readJson(first.value.payload);
    if (!isRecord(head) || head.open !== true || typeof head.protocol !== "string")
      throw new Error("Relay WebSocket was rejected.");
    this.protocol = head.protocol;
    this.readyState = 1;
    const event = new Event("open");
    this.dispatchEvent(event);
    this.onopen?.(event);
    await readSocketMessages(
      stream,
      async (bytes, binary) => {
        if (this.messageConsumer) {
          await this.messageConsumer(bytes, binary);
          return;
        }
        const data = binary
          ? this.binaryType === "arraybuffer"
            ? bytes.slice().buffer
            : new Blob([bytes.slice()])
          : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const message = Object.assign(new Event("message"), { data }) as MessageEvent;
        this.dispatchEvent(message);
        this.onmessage?.(message);
      },
      (head) => {
        if (
          isRecord(head) &&
          typeof head.closeCode === "number" &&
          typeof head.closeReason === "string"
        ) {
          this.closeCode = head.closeCode;
          this.closeReason = head.closeReason;
        }
      },
    );
    await stream.end();
    this.finish();
  }
}

export async function writeSocketMessage(stream: RelayStream, bytes: Uint8Array, binary: boolean) {
  if (bytes.length > MAX_SOCKET_MESSAGE) throw new Error("Relay WebSocket message is too large.");
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, bytes.length);
  await stream.send(binary ? FrameKind.Binary : FrameKind.Text, head);
  for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) {
    await stream.send(FrameKind.Data, bytes.subarray(offset, offset + FRAME_BYTES));
  }
}

export async function readSocketMessages(
  stream: RelayStream,
  onMessage: (bytes: Uint8Array, binary: boolean) => void | Promise<void>,
  onHead: (head: unknown) => void,
) {
  let message: Uint8Array | undefined;
  let offset = 0;
  let binary = false;
  for await (const frame of stream) {
    if (frame.kind === FrameKind.Head) {
      onHead(readJson(frame.payload));
      continue;
    }
    if (frame.kind === FrameKind.Text || frame.kind === FrameKind.Binary) {
      if (message || frame.payload.length !== 4)
        throw new Error("Invalid relay WebSocket message.");
      const length = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0);
      if (length > MAX_SOCKET_MESSAGE) throw new Error("Relay WebSocket message is too large.");
      binary = frame.kind === FrameKind.Binary;
      message = new Uint8Array(length);
      offset = 0;
    } else if (frame.kind === FrameKind.Data) {
      if (!message || offset + frame.payload.length > message.length)
        throw new Error("Invalid relay WebSocket fragment.");
      message.set(frame.payload, offset);
      offset += frame.payload.length;
    } else throw new Error("Invalid relay WebSocket frame.");
    if (message && offset === message.length) {
      await onMessage(message, binary);
      message = undefined;
    }
  }
  if (message) throw new Error("Truncated relay WebSocket message.");
}
