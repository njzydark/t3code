import { EncryptedRelayClient } from "./client.ts";
import { virtualRelayOrigin, base64ToBytes, bytesToBase64 } from "./protocol.ts";

export interface LocalRelayRequest {
  readonly id: string;
  readonly route: string;
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly websocket: boolean;
}

export interface LocalRelayBridge {
  start(route: string): Promise<number>;
  stop(route: string): Promise<void>;
  read(id: string): Promise<string | null>;
  respond(id: string, status: number, headers: string[][]): Promise<void>;
  write(id: string, base64: string): Promise<void>;
  finish(id: string): Promise<void>;
  close(id: string): void;
  upgrade(id: string, protocol: string): Promise<void>;
  readSocket(id: string): Promise<{ data: string; binary: boolean } | null>;
  writeSocket(id: string, base64: string, binary: boolean): Promise<void>;
}

export async function serveLocalRelayRequest(
  client: EncryptedRelayClient,
  bridge: LocalRelayBridge,
  request: LocalRelayRequest,
  signal: AbortSignal,
) {
  const url = virtualRelayOrigin(request.route) + request.path;
  if (request.websocket) {
    const headers = new Headers(request.headers.map(([name, value]) => [name, value]));
    const protocols = (headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const socket = client.socket(url.replace(/^https:/, "wss:"), protocols);
    socket.binaryType = "arraybuffer";
    const abort = () => {
      socket.close();
      bridge.close(request.id);
    };
    signal.addEventListener("abort", abort, { once: true });
    let upgradeDone!: () => void;
    let upgradeFailed!: (error: Error) => void;
    const upgraded = new Promise<void>((resolve, reject) => {
      upgradeDone = resolve;
      upgradeFailed = reject;
    });
    void upgraded.catch(() => {});
    let finished!: () => void;
    let failed!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      finished = resolve;
      failed = reject;
    });
    socket.consumeMessages(async (bytes, binary) => {
      await upgraded;
      await bridge.writeSocket(request.id, bytesToBase64(bytes), binary);
    });
    socket.onerror = () => failed(new Error("Relay WebSocket failed."));
    socket.onclose = () => {
      bridge.close(request.id);
      finished();
    };
    socket.onopen = () => {
      void (async () => {
        await bridge.upgrade(request.id, socket.protocol);
        upgradeDone();
        for (;;) {
          const message = await bridge.readSocket(request.id);
          if (!message) break;
          const bytes = base64ToBytes(message.data);
          socket.send(message.binary ? bytes : new TextDecoder().decode(bytes));
          await socket.flushed();
        }
        socket.close();
      })().catch(() => {
        const error = new Error("Local relay WebSocket disconnected.");
        upgradeFailed(error);
        abort();
        failed(error);
      });
    };
    try {
      await done;
    } finally {
      upgradeFailed(new Error("Local relay WebSocket disconnected."));
      signal.removeEventListener("abort", abort);
      abort();
    }
    return;
  }
  const headers = new Headers(request.headers.map(([name, value]) => [name, value]));
  const body = ["GET", "HEAD"].includes(request.method)
    ? null
    : new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const chunk = await bridge.read(request.id);
              if (chunk === null) controller.close();
              else controller.enqueue(base64ToBytes(chunk));
            } catch (error) {
              controller.error(error);
            }
          },
          cancel() {
            bridge.close(request.id);
          },
        },
        { highWaterMark: 0 },
      );
  const response = await client.request({ url, method: request.method, headers, body, signal });
  const reader = response.body?.getReader();
  try {
    await bridge.respond(request.id, response.status, [...response.headers]);
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        await bridge.write(request.id, bytesToBase64(chunk.value));
      }
    await bridge.finish(request.id);
  } catch (error) {
    await reader?.cancel().catch(() => {});
    throw error;
  } finally {
    bridge.close(request.id);
  }
}
