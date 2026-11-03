// @effect-diagnostics globalFetch:off -- Application boundary dispatching fetch to the selected transport.
import { EncryptedRelayClient, RelayWebSocket } from "./client.ts";
import type { RelayAddress } from "./protocol.ts";

export function createRelayNetwork(input?: {
  readonly endpoint?: (address: RelayAddress) => Promise<string | undefined>;
  readonly interceptHttp?: boolean;
}) {
  const nativeFetch = globalThis.fetch;
  const NativeWebSocket = globalThis.WebSocket;
  const client = new EncryptedRelayClient((url) => new NativeWebSocket(url));
  const fetch: typeof globalThis.fetch = (request, init) => {
    const url = request instanceof Request ? request.url : String(request);
    return input?.interceptHttp !== false && client.routeForUrl(url)
      ? client.fetch(request, init)
      : nativeFetch(request, init);
  };
  class RoutedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (client.routeForUrl(String(url))) {
        return client.socket(String(url), protocols) as unknown as RoutedWebSocket;
      }
      super(url, protocols);
    }
  }
  const install = () => {
    globalThis.fetch = fetch;
    globalThis.WebSocket = RoutedWebSocket;
    return () => {
      if (globalThis.fetch === fetch) globalThis.fetch = nativeFetch;
      if (globalThis.WebSocket === RoutedWebSocket) globalThis.WebSocket = NativeWebSocket;
      client.dispose();
    };
  };
  const prepare = async (address: RelayAddress) =>
    client.register(address, await input?.endpoint?.(address));
  return { transport: client, fetch, prepare, install };
}

export { RelayWebSocket };
