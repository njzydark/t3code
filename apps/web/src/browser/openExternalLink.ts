import {
  type DesktopBrowserTunnelInput,
  type EnvironmentId,
  PreviewTunnelGrant,
} from "@t3tools/contracts";
import { relayRouteFromUrl, virtualRelayOrigin } from "@t3tools/relay-transport/protocol";
import * as Schema from "effect/Schema";
import { readLocalApi } from "~/localApi";
import { relayNetwork } from "~/lib/selfHostedRelay";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { hostEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { readPreviewTunnelAccess } from "~/state/previewStream";

const decodeGrant = Schema.decodeUnknownSync(PreviewTunnelGrant);
const grants = new Map<string, Promise<DesktopBrowserTunnelInput>>();

export async function openExternalLink(url: string, environmentId?: EnvironmentId) {
  const target = new URL(url);
  const remoteLoopback =
    environmentId !== undefined &&
    environmentId !== appAtomRegistry.get(hostEnvironmentIdAtom) &&
    target.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (!remoteLoopback) {
    const api = readLocalApi();
    if (!api) throw new Error("Link opening is unavailable.");
    return api.shell.openExternal(url);
  }
  if (!window.desktopBridge?.openBrowserTunnel)
    throw new Error(
      "Open this remote service from the desktop app to forward it to your system browser.",
    );
  const key = `${environmentId}:${target.origin}`;
  let pending = grants.get(key);
  if (pending && (await pending).expiresAt <= Date.now() + 60_000) {
    grants.delete(key);
    pending = undefined;
  }
  if (!pending) {
    pending = createGrant(environmentId, target);
    grants.set(key, pending);
    void pending.catch(() => {
      grants.delete(key);
    });
  }
  const input = await pending;
  const opened = await window.desktopBridge.openBrowserTunnel({ ...input, url });
  if (!opened) throw new Error("Unable to open the browser tunnel.");
}

async function createGrant(
  environmentId: EnvironmentId,
  target: URL,
): Promise<DesktopBrowserTunnelInput> {
  const access = await readPreviewTunnelAccess(environmentId);
  if (!access) throw new Error("The remote environment is unavailable.");
  const endpoint = new URL(access.httpBase);
  for (const [key, value] of Object.entries(access.query)) endpoint.searchParams.set(key, value);
  const response = await fetch(endpoint.href, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostname: target.hostname === "[::1]" ? "::1" : target.hostname,
      port: Number(target.port || 80),
    }),
    credentials: access.credentials ? "include" : "omit",
  });
  if (!response.ok)
    throw new Error(
      "The remote server could not open a browser tunnel. Update the server and check Browser permissions.",
    );
  const grant = decodeGrant(await response.json());
  const route = relayRouteFromUrl(endpoint.href);
  const relay = route ? relayNetwork.transport.addressForRoute(route) : undefined;
  if (route && !relay) throw new Error("This relay environment is disconnected.");
  const ws = new URL(
    relay ? "/api/preview-tunnel/ws" : endpoint.pathname + "/ws",
    relay ? virtualRelayOrigin(relay.route) : endpoint.origin,
  );
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  ws.searchParams.set("wsTicket", grant.token);
  return {
    url: target.href,
    wsUrl: ws.href,
    expiresAt: grant.expiresAt,
    ...(relay ? { relay } : {}),
  };
}
