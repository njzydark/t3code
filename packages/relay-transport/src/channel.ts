import type { MessageStream } from "@libp2p/interface";

import {
  encodeFrame,
  FRAME_BYTES,
  FrameDecoder,
  FrameKind,
  jsonBytes,
  MAX_STREAMS,
  readJson,
  STREAM_WINDOW,
} from "./protocol.ts";

export class AsyncQueue<T> {
  private values: T[] = [];
  private waiting:
    | { resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }
    | undefined;
  private ended = false;
  private error: Error | undefined;

  push(value: T) {
    if (this.ended) throw new Error("Relay stream is closed.");
    if (this.waiting) {
      this.waiting.resolve({ value, done: false });
      this.waiting = undefined;
    } else {
      this.values.push(value);
    }
  }

  end(error?: Error) {
    this.ended = true;
    this.error = error;
    if (error) this.values = [];
    if (this.waiting) {
      if (error) this.waiting.reject(error);
      else this.waiting.resolve({ value: undefined, done: true });
      this.waiting = undefined;
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    if (this.waiting) return Promise.reject(new Error("Concurrent relay stream reads."));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

export interface StreamFrame {
  readonly kind: FrameKind;
  readonly payload: Uint8Array;
}

function consumesCredit(kind: FrameKind) {
  return (
    kind === FrameKind.Head ||
    kind === FrameKind.Data ||
    kind === FrameKind.Text ||
    kind === FrameKind.Binary
  );
}

export class RelayStream {
  private readonly incoming = new AsyncQueue<StreamFrame>();
  private credit = STREAM_WINDOW;
  private receivedCredit = STREAM_WINDOW;
  private creditWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private localEnded = false;
  private remoteEnded = false;
  private failure: Error | undefined;
  private readonly abortController = new AbortController();
  readonly id: number;
  private readonly channel: RelayChannel;
  readonly signal = this.abortController.signal;

  constructor(id: number, channel: RelayChannel) {
    this.id = id;
    this.channel = channel;
  }

  receive(kind: FrameKind, payload: Uint8Array) {
    if (kind === FrameKind.Credit) {
      if (payload.length !== 4) throw new Error("Invalid relay credit.");
      const count = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
      if (count === 0 || this.credit + count > STREAM_WINDOW)
        throw new Error("Invalid relay credit.");
      this.credit += count;
      this.creditWaiter?.resolve();
      this.creditWaiter = undefined;
      return;
    }
    if (kind === FrameKind.Reset) {
      if (payload.length !== 0) throw new Error("Invalid relay reset.");
      this.fail(new Error("The remote relay stream was cancelled."));
      return;
    }
    if (this.remoteEnded) throw new Error("Data after relay stream end.");
    if (kind === FrameKind.End) {
      if (payload.length !== 0) throw new Error("Invalid relay end.");
      this.remoteEnded = true;
      this.incoming.end();
      this.release();
      return;
    }
    if (consumesCredit(kind)) {
      this.receivedCredit -= payload.length + 9;
      if (this.receivedCredit < 0) throw new Error("Relay receive window exceeded.");
    }
    this.incoming.push({ kind, payload });
  }

  async next(): Promise<IteratorResult<StreamFrame>> {
    const result = await this.incoming.next();
    if (!result.done && consumesCredit(result.value.kind)) {
      const length = result.value.payload.length + 9;
      if (length > 0) {
        this.receivedCredit += length;
        const payload = new Uint8Array(4);
        new DataView(payload.buffer).setUint32(0, length);
        await this.channel.send(FrameKind.Credit, this.id, payload);
      }
    }
    return result;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async send(kind: FrameKind, payload: Uint8Array) {
    if (this.failure) throw this.failure;
    if (this.localEnded) throw new Error("Relay stream is closed for writing.");
    if (payload.length > FRAME_BYTES) throw new Error("Relay frame is too large.");
    const counted = consumesCredit(kind);
    if (counted) {
      const cost = payload.length + 9;
      while (this.credit < cost) {
        await new Promise<void>((resolve, reject) => {
          this.creditWaiter = { resolve, reject };
        });
        if (this.failure) throw this.failure;
      }
      this.credit -= cost;
    }
    await this.channel.send(kind, this.id, payload);
  }

  async write(bytes: Uint8Array) {
    for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) {
      await this.send(FrameKind.Data, bytes.subarray(offset, offset + FRAME_BYTES));
    }
  }

  async head(value: unknown) {
    await this.send(FrameKind.Head, jsonBytes(value));
  }

  async end() {
    if (this.localEnded || this.failure) return;
    this.localEnded = true;
    await this.channel.send(FrameKind.End, this.id);
    this.release();
  }

  cancel() {
    if (this.failure) return;
    void this.channel.send(FrameKind.Reset, this.id).catch(() => {});
    this.fail(new Error("Relay stream cancelled."));
  }

  fail(error: Error) {
    this.failure = error;
    this.abortController.abort(error);
    this.incoming.end(error);
    this.creditWaiter?.reject(error);
    this.creditWaiter = undefined;
    this.channel.remove(this.id);
  }

  private release() {
    if (this.localEnded && this.remoteEnded) this.channel.remove(this.id);
  }
}

export class RelayChannel {
  private readonly streams = new Map<number, RelayStream>();
  private nextId = 1;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;
  readonly done: Promise<void>;
  private readonly wire: MessageStream;
  private readonly onOpen: ((stream: RelayStream, metadata: unknown) => Promise<void>) | undefined;

  constructor(
    wire: MessageStream,
    onOpen?: (stream: RelayStream, metadata: unknown) => Promise<void>,
  ) {
    this.wire = wire;
    this.onOpen = onOpen;
    this.done = this.read();
    void this.done.catch(() => {});
  }

  get isClosed() {
    return this.closed;
  }
  get streamCount() {
    return this.streams.size;
  }

  async open(metadata: unknown): Promise<RelayStream> {
    if (this.closed) throw new Error("Relay disconnected.");
    if (this.streams.size >= MAX_STREAMS || this.nextId > 0xffffffff) {
      throw new Error("Too many concurrent relay streams.");
    }
    const stream = new RelayStream(this.nextId++, this);
    this.streams.set(stream.id, stream);
    try {
      await this.send(FrameKind.Open, stream.id, jsonBytes(metadata));
      return stream;
    } catch (error) {
      stream.cancel();
      throw error;
    }
  }

  remove(id: number) {
    this.streams.delete(id);
  }

  send(kind: FrameKind, id: number, payload?: Uint8Array): Promise<void> {
    const frame = encodeFrame(kind, id, payload);
    const operation = this.writing.then(async () => {
      if (this.closed) throw new Error("Relay disconnected.");
      if (!this.wire.send(frame)) await this.wire.onDrain();
    });
    this.writing = operation.catch(() => {});
    return operation;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams.values()) stream.fail(new Error("Relay disconnected."));
    this.wire.abort(new Error("Relay connection closed."));
  }

  private async read() {
    const decoder = new FrameDecoder();
    let lastOpenedId = 0;
    try {
      for await (const chunk of this.wire) {
        const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
        for (const { kind, id, payload } of decoder.push(bytes)) {
          if (kind === FrameKind.Open) {
            if (!this.onOpen || id <= lastOpenedId || this.streams.size >= MAX_STREAMS) {
              throw new Error("Invalid relay stream open.");
            }
            lastOpenedId = id;
            const stream = new RelayStream(id, this);
            this.streams.set(id, stream);
            void this.onOpen(stream, readJson(payload)).catch(() => stream.cancel());
          } else {
            const stream = this.streams.get(id);
            if (stream) stream.receive(kind, payload);
          }
        }
      }
    } finally {
      this.close();
    }
  }
}
