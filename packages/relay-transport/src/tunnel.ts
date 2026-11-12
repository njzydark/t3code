// @effect-diagnostics nodeBuiltinImport:off -- Node boundary for a loopback-only TCP listener.
import * as NodeNet from "node:net";
import { WebSocket } from "ws";
import { EncryptedRelayClient } from "./client.ts";
import { relayRouteFromUrl, type RelayAddress } from "./protocol.ts";

export async function createLoopbackTunnel(input: {
  readonly wsUrl: string;
  readonly relay?: RelayAddress;
}) {
  const url = new URL(input.wsUrl);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !url.pathname.endsWith("/api/preview-tunnel/ws") ||
    !url.searchParams.get("wsTicket") ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid browser tunnel endpoint.");
  }
  const client = new EncryptedRelayClient(
    (address) => new WebSocket(address, { perMessageDeflate: false }),
  );
  if (input.relay) {
    if (relayRouteFromUrl(input.wsUrl) !== input.relay.route)
      throw new Error("Browser tunnel relay does not match.");
    client.register(input.relay);
  }
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer({ pauseOnConnect: true }, (local) => {
    if (sockets.size >= 64) {
      local.destroy();
      return;
    }
    local.setNoDelay(true);
    sockets.add(local);
    const remote = input.relay
      ? client.socket(input.wsUrl)
      : new WebSocket(input.wsUrl, { perMessageDeflate: false, handshakeTimeout: 15_000 });
    const close = () => {
      local.destroy();
      remote.close();
      sockets.delete(local);
    };
    local.once("close", close);
    local.on("error", close);
    remote.onclose = (event: { code: number }) => (event.code === 1000 ? local.end() : close());
    remote.onerror = close;
    const write = (bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        local.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
    if (input.relay && "consumeMessages" in remote) remote.consumeMessages((bytes) => write(bytes));
    else if (remote instanceof WebSocket) {
      remote.on("message", (data) => {
        remote.pause();
        void write(new Uint8Array(data as Buffer)).then(() => remote.resume(), close);
      });
    }
    remote.onopen = () => {
      local.resume();
      void (async () => {
        for await (const bytes of local) {
          if (remote instanceof WebSocket)
            await new Promise<void>((resolve, reject) =>
              remote.send(bytes, { binary: true }, (error) => (error ? reject(error) : resolve())),
            );
          else {
            remote.send(bytes);
            await remote.flushed();
          }
        }
        remote.close();
      })().catch(close);
    };
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    client.dispose();
    server.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    port: (server.address() as NodeNet.AddressInfo).port,
    close() {
      if (closing) return closing;
      for (const socket of sockets) socket.destroy();
      client.dispose();
      closing = new Promise<void>((resolve) => server.close(() => resolve()));
      return closing;
    },
  };
}
