import type { MessageStream } from "@libp2p/interface";
import { describe, expect, it } from "vite-plus/test";

import { AsyncQueue, RelayChannel, type RelayStream } from "./channel.ts";
import {
  encodeFrame,
  FRAME_BYTES,
  FrameDecoder,
  FrameKind,
  jsonBytes,
  readJson,
  STREAM_WINDOW,
} from "./protocol.ts";

const receiveWindow = 4 * 1024 * 1024;

function fixture(legacy = false) {
  const incoming = [new AsyncQueue<Uint8Array>(), new AsyncQueue<Uint8Array>()];
  const opened = Promise.withResolvers<{ stream: RelayStream; metadata: unknown }>();
  const wire = (side: number) =>
    ({
      send(bytes: Uint8Array) {
        if (legacy) {
          const [frame] = new FrameDecoder().push(bytes);
          if (frame!.kind === FrameKind.Open || frame!.kind === FrameKind.Head) {
            const { receiveWindow: _window, ...metadata } = readJson(frame!.payload) as Record<
              string,
              unknown
            >;
            bytes = encodeFrame(frame!.kind, frame!.id, jsonBytes(metadata));
          }
        }
        incoming[1 - side]!.push(bytes);
        return true;
      },
      abort(error: Error) {
        for (const queue of incoming) queue.end(error);
      },
      [Symbol.asyncIterator]: () => incoming[side]!,
    }) as unknown as MessageStream;
  const client = new RelayChannel(wire(0));
  const server = new RelayChannel(wire(1), async (stream, metadata) => {
    opened.resolve({ stream, metadata });
    await stream.head({ open: true });
  });
  return {
    client,
    opened: opened.promise,
    [Symbol.dispose]() {
      client.close();
      server.close();
    },
  };
}

const credit = (bytes: number) => {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes);
  return payload;
};

describe("relay stream windows", () => {
  it("negotiates enough in-flight data in both directions without waiting for consumption", async () => {
    using test = fixture();
    const client = await test.client.open({ type: "websocket", path: "/api/preview/tunnel" });
    const { stream: server, metadata } = await test.opened;
    expect(metadata).toMatchObject({ receiveWindow });
    const head = await client.next();
    expect(head.done).toBe(false);
    expect(readJson(head.value!.payload)).toMatchObject({ receiveWindow });

    const payload = new Uint8Array(STREAM_WINDOW * 2).fill(23);
    for (const [sender, receiver] of [
      [client, server],
      [server, client],
    ] as const) {
      await sender.write(payload);
      await sender.end();
      const chunks: Uint8Array[] = [];
      for await (const frame of receiver) chunks.push(frame.payload);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(payload));
    }
  });

  it.each([false, true])(
    "keeps the negotiated or legacy window bounded and cancels a blocked writer (legacy: %s)",
    async (legacy) => {
      using test = fixture(legacy);
      const stream = await test.client.open({ type: "http", path: "/" });
      await test.opened;
      const head = await stream.next();
      expect(readJson(head.value!.payload)).toEqual(
        legacy ? { open: true } : { open: true, receiveWindow },
      );
      const window = legacy ? STREAM_WINDOW : receiveWindow;
      expect(() => stream.receive(FrameKind.Credit, credit(1))).toThrow("Invalid relay credit.");
      const payload = new Uint8Array(FRAME_BYTES);
      const frames = Math.floor(window / (FRAME_BYTES + 9));
      for (let index = 0; index < frames; index++) await stream.send(FrameKind.Data, payload);
      if (!legacy) stream.receive(FrameKind.Head, jsonBytes({ receiveWindow }));
      const blocked = expect(stream.send(FrameKind.Data, payload)).rejects.toThrow(
        "Relay stream cancelled.",
      );
      const independent = await test.client.open({ type: "http", path: "/other" });
      expect(readJson((await independent.next()).value!.payload)).toMatchObject({ open: true });
      independent.cancel();
      stream.cancel();
      await blocked;
    },
  );

  it.each([0, STREAM_WINDOW - 1, receiveWindow + 1, "4194304", 1.5])(
    "rejects an invalid advertised receive window: %s",
    async (window) => {
      using test = fixture();
      const stream = await test.client.open({ type: "http", path: "/" });
      await test.opened;
      await stream.next();
      expect(() => stream.receive(FrameKind.Head, jsonBytes({ receiveWindow: window }))).toThrow(
        "Invalid relay receive window.",
      );
    },
  );
});
