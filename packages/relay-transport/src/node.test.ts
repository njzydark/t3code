import { describe, expect, it, vi } from "vite-plus/test";

import { connectHost } from "./node.ts";

const transport = vi.hoisted(() => {
  class Socket extends EventTarget {
    binaryType = "";
    readyState = 0;
    bufferedAmount = 0;
    pings = 0;
    terminated = false;

    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    on(type: string, listener: () => void) {
      this.addEventListener(type, listener);
      return this;
    }

    once(type: string, listener: () => void) {
      this.addEventListener(type, listener, { once: true });
      return this;
    }

    send() {
      this.dispatchEvent(new MessageEvent("message", { data: '{"type":"ready"}' }));
    }

    ping() {
      this.pings++;
    }

    terminate() {
      this.terminated = true;
      this.close();
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  const sockets: Socket[] = [];
  return { Socket, sockets };
});

vi.mock("ws", () => ({ WebSocket: transport.Socket }));

async function fixture() {
  transport.sockets.length = 0;
  vi.useFakeTimers();
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const host = connectHost({
    address: {
      relayUrl: "https://relay.example.com",
      route: "1234567890abcdef1234567890abcdef",
      peerId: "1234567890abcdefghij",
    },
    registrationToken: "local-fixture-registration-token-only",
    privateKey: "unused",
    target: "http://127.0.0.1:3000",
    signal: controller.signal,
    onConnected: () => ready.resolve(),
  });
  const result = host.catch((error: unknown) => error);
  await Promise.race([ready.promise, host]);
  return {
    socket: transport.sockets[0]!,
    result,
    stop: () => controller.abort(),
    async [Symbol.asyncDispose]() {
      controller.abort();
      await result;
      vi.useRealTimers();
    },
  };
}

describe("relay host liveness", () => {
  it("terminates a half-open control socket so the host runner can retry", async () => {
    await using test = await fixture();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.socket.terminated).toBe(true);
    expect(await test.result).toEqual(new Error("Relay host disconnected."));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a responsive control socket and clears its heartbeat on shutdown", async () => {
    await using test = await fixture();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.socket.pings).toBe(1);
    test.socket.dispatchEvent(new Event("pong"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.socket.pings).toBe(2);
    expect(test.socket.terminated).toBe(false);
    test.stop();
    expect(await test.result).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
