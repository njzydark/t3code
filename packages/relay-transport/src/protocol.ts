export const RELAY_PROTOCOL = "t3-self-relay/1";
export const FRAME_BYTES = 60 * 1024;
export const STREAM_WINDOW = 256 * 1024;
export const MAX_STREAMS = 64;
export const MAX_SOCKET_MESSAGE = 16 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export const FrameKind = {
  Open: 1,
  Head: 2,
  Data: 3,
  End: 4,
  Reset: 5,
  Credit: 6,
  Text: 7,
  Binary: 8,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function readJson(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function base64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeFrame(
  kind: FrameKind,
  id: number,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array {
  if (payload.byteLength > FRAME_BYTES) throw new Error("Relay frame is too large.");
  const bytes = new Uint8Array(9 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, id);
  view.setUint32(5, payload.byteLength);
  bytes.set(payload, 9);
  return bytes;
}

export class FrameDecoder {
  private buffer = new Uint8Array();

  *push(bytes: Uint8Array): Generator<{ kind: FrameKind; id: number; payload: Uint8Array }> {
    const next = new Uint8Array(this.buffer.length + bytes.length);
    next.set(this.buffer);
    next.set(bytes, this.buffer.length);
    let offset = 0;
    while (next.length - offset >= 9) {
      const view = new DataView(next.buffer, next.byteOffset + offset);
      const kind = view.getUint8(0);
      const id = view.getUint32(1);
      const length = view.getUint32(5);
      if (kind < 1 || kind > 8 || id === 0 || length > FRAME_BYTES) {
        throw new Error("Invalid relay frame.");
      }
      if (next.length - offset < 9 + length) break;
      yield {
        kind: kind as FrameKind,
        id,
        payload: next.slice(offset + 9, offset + 9 + length),
      };
      offset += 9 + length;
    }
    this.buffer = next.slice(offset);
    if (this.buffer.length > FRAME_BYTES + 9) throw new Error("Relay frame buffer exceeded.");
  }
}

export interface RelayAddress {
  readonly relayUrl: string;
  readonly route: string;
  readonly peerId: string;
}

export function validateRelayAddress(input: RelayAddress): RelayAddress {
  const url = new URL(input.relayUrl);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{32}$/.test(input.route) ||
    !/^[A-Za-z0-9]{20,128}$/.test(input.peerId)
  ) {
    throw new Error(
      "Invalid self-hosted relay address. Use an HTTPS origin and a host pairing link.",
    );
  }
  return { ...input, relayUrl: url.origin };
}

export function relaySocketUrl(relayUrl: string): string {
  const url = new URL("/v1/socket", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function virtualRelayOrigin(route: string): string {
  return `https://${route}.t3-relay.invalid`;
}

export function relayRouteFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (
      /^([a-f0-9]{32})\.t3-relay\.invalid$/.exec(url.hostname)?.[1] ??
      /^\/__t3_relay\/([a-f0-9]{32})(?:\/|$)/.exec(url.pathname)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

export function relayEndpointPath(base: string, path: string): string {
  const url = new URL(base);
  const prefix = /^\/__t3_relay\/[a-f0-9]{32}(?:\/|$)/.exec(url.pathname)?.[0];
  return new URL(prefix && path.startsWith("/") ? prefix.replace(/\/$/, "") + path : path, url)
    .href;
}

export function relayRequestPath(value: string): string {
  const url = new URL(value);
  return url.pathname.replace(/^\/__t3_relay\/[a-f0-9]{32}(?=\/|$)/, "") + url.search || "/";
}
