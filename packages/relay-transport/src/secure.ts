// @effect-diagnostics globalTimers:off -- The socket adapter owns and clears its handshake and drain timers.
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import type { PrivateKey, MessageStream, Upgrader } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { noise, pureJsCrypto } from "@libp2p/noise";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { AbstractMessageStream } from "@libp2p/utils";
import type { Uint8ArrayList } from "uint8arraylist";

import { base64ToBytes, bytesToBase64, MAX_BUFFERED_BYTES, RELAY_PROTOCOL } from "./protocol.ts";

export interface RelaySocket {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "open" | "close" | "error", listener: () => void): void;
}

export type RelaySocketFactory = (url: string) => RelaySocket;

export const globalSocket: RelaySocketFactory = (url) => new WebSocket(url);

export async function generateIdentity() {
  const key = await generateKeyPair("Ed25519");
  return {
    privateKey: bytesToBase64(privateKeyToProtobuf(key)),
    peerId: peerIdFromPrivateKey(key).toString(),
  };
}

export function restoreIdentity(privateKey: string): PrivateKey {
  return privateKeyFromProtobuf(base64ToBytes(privateKey));
}

export function peerIdForPrivateKey(privateKey: string): string {
  return peerIdFromPrivateKey(restoreIdentity(privateKey)).toString();
}

// ws can deliver ready and the next frame in one turn, before an awaiting caller resumes.
function bufferSocket(socket: RelaySocket): RelaySocket {
  const queued: { data: unknown }[] = [];
  let queuedBytes = 0;
  let receiver: ((event: { data: unknown }) => void) | undefined;
  const flush = () => {
    while (queued.length) {
      const handler = receiver;
      if (!handler) break;
      const next = queued.shift()!;
      queuedBytes -=
        typeof next.data === "string"
          ? next.data.length * 2
          : (next.data as ArrayBuffer).byteLength;
      handler(next);
    }
  };
  socket.addEventListener("error", () => {});
  socket.addEventListener("message", (event) => {
    if (receiver) {
      receiver(event);
      return;
    }
    queuedBytes +=
      typeof event.data === "string"
        ? event.data.length * 2
        : event.data instanceof ArrayBuffer
          ? event.data.byteLength
          : MAX_BUFFERED_BYTES + 1;
    if (queuedBytes > MAX_BUFFERED_BYTES) {
      socket.close(1009);
      return;
    }
    queued.push(event);
  });
  return {
    get binaryType() {
      return socket.binaryType;
    },
    set binaryType(value) {
      socket.binaryType = value;
    },
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener(type: string, listener: ((event: { data: unknown }) => void) | (() => void)) {
      if (type === "message") {
        receiver = listener;
        flush();
      } else {
        socket.addEventListener(type as "open" | "close" | "error", listener as () => void);
      }
    },
    removeEventListener(
      type: string,
      listener: ((event: { data: unknown }) => void) | (() => void),
    ) {
      if (type === "message") {
        if (receiver === listener) receiver = undefined;
      } else {
        socket.removeEventListener(type as "open" | "close" | "error", listener as () => void);
      }
    },
  };
}

export async function openSocket(
  url: string,
  registration: unknown,
  factory = globalSocket,
  signal?: AbortSignal,
): Promise<RelaySocket> {
  signal?.throwIfAborted();
  const socket = bufferSocket(factory(url));
  socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close();
      reject(
        signal?.aborted ? signal.reason : new Error("Could not establish the relay connection."),
      );
    };
    const onAbort = () => fail();
    const onClose = () => fail();
    const onOpen = () => socket.send(JSON.stringify(registration));
    const onMessage = (event: { data: unknown }) => {
      if (event.data !== '{"type":"ready"}') return fail();
      settled = true;
      cleanup();
      resolve(socket);
    };
    const deadline = setTimeout(fail, 15_000);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

class SocketStream extends AbstractMessageStream {
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly socket: RelaySocket;

  constructor(socket: RelaySocket) {
    super({
      log: defaultLogger().forComponent("t3:self-relay"),
      maxReadBufferLength: MAX_BUFFERED_BYTES,
      maxWriteBufferLength: MAX_BUFFERED_BYTES,
      maxMessageSize: 64 * 1024,
    });
    this.socket = socket;
    const onMessage = (event: { data: unknown }) => {
      if (!(event.data instanceof ArrayBuffer)) {
        this.abort(new Error("Expected encrypted relay bytes."));
        return;
      }
      this.onData(new Uint8Array(event.data));
    };
    const onClose = () => this.onTransportClosed(new Error("Relay disconnected."));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
    this.addEventListener("close", () => {
      clearTimeout(this.drainTimer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onClose);
      socket.close();
    });
  }

  override sendData(data: Uint8ArrayList) {
    if (this.socket.readyState !== 1) throw new Error("Relay disconnected.");
    if (this.socket.bufferedAmount > 256 * 1024) {
      this.scheduleDrain();
      return { sentBytes: 0, canSendMore: false };
    }
    this.socket.send(data.subarray().slice());
    return { sentBytes: data.byteLength, canSendMore: true };
  }

  private scheduleDrain() {
    if (this.drainTimer !== undefined) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      if (this.socket.bufferedAmount > 128 * 1024) {
        this.scheduleDrain();
      } else {
        this.onMuxerDrain();
      }
    }, 10);
  }

  override sendReset() {
    this.socket.close(1000);
  }
  override sendPause() {}
  override sendResume() {}
  override async close() {
    this.socket.close(1000);
    this.onTransportClosed();
  }
}

export async function secureSocket(input: {
  readonly socket: RelaySocket;
  readonly privateKey?: string;
  readonly remotePeer?: string;
  readonly initiator: boolean;
  readonly route: string;
  readonly signal?: AbortSignal;
}): Promise<MessageStream> {
  const privateKey = input.privateKey
    ? restoreIdentity(input.privateKey)
    : await generateKeyPair("Ed25519");
  // No libp2p multiplexers: T3 frames run inside Noise with negotiation disabled.
  const upgrader = { getStreamMuxers: () => new Map() } as Pick<Upgrader, "getStreamMuxers">;
  const encrypter = noise({
    crypto: pureJsCrypto,
    prologueBytes: new TextEncoder().encode(`${RELAY_PROTOCOL}:${input.route}`),
  })({
    privateKey,
    peerId: peerIdFromPrivateKey(privateKey),
    logger: defaultLogger(),
    upgrader: upgrader as Upgrader,
  });
  const raw = new SocketStream(input.socket);
  try {
    const options = {
      signal: input.signal ?? AbortSignal.timeout(15_000),
      skipStreamMuxerNegotiation: true,
      ...(input.remotePeer ? { remotePeer: peerIdFromString(input.remotePeer) } : {}),
    };
    const secured = await (input.initiator
      ? encrypter.secureOutbound(raw, options)
      : encrypter.secureInbound(raw, options));
    return secured.connection;
  } catch (error) {
    raw.abort(error instanceof Error ? error : new Error("Relay handshake failed."));
    throw error;
  }
}
