// @effect-diagnostics globalFetch:off -- Exercise an outside HTTP MCP client against the real gateway.
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { FetchHttpClient } from "effect/http";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf, servePeer, layerLinkingEnvironment } from "../peer/PeerLinks.testkit.ts";
import { createRelayBroker } from "../../../../infra/selfhosted-relay/test/broker.ts";
import { connectHost } from "@t3tools/relay-transport/node";
import { generateIdentity } from "@t3tools/relay-transport/secure";

it.live("uses real MCP bearer sessions and peer linking through a single-origin relay path", () =>
  Effect.gen(function* () {
    const peer = yield* servePeer(descriptorOf("remote-relay-mcp", "Remote"), Layer.empty);
    const registrationToken = "relay-mcp-network-fixture-token-".repeat(2);
    const broker = yield* Effect.acquireRelease(
      Effect.promise(() => createRelayBroker({ registrationToken })),
      (value) => Effect.promise(() => value.close()),
    );
    const identity = yield* Effect.promise(generateIdentity);
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const controller = new AbortController();
        const ready = Promise.withResolvers<void>();
        const task = connectHost({
          address: { relayUrl: broker.url, route: "f".repeat(32), peerId: identity.peerId },
          registrationToken,
          privateKey: identity.privateKey,
          target: peer.url,
          publishEnvironment: true,
          signal: controller.signal,
          onConnected: () => ready.resolve(),
        });
        await Promise.race([ready.promise, task]);
        return { task, controller };
      }),
      ({ task, controller }) =>
        Effect.promise(async () => {
          controller.abort();
          await task;
        }),
    );
    const base = broker.url + "/v1/environments/remote-relay-mcp";
    const issued = yield* peer.auth.issueMcpClientSession({
      label: "External token client",
      access: "read-only",
      peerLink: false,
      client: { deviceType: "bot" },
    });
    const initialize = async (token: string) => {
      const response = await fetch(base + "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "fixture", version: "1" },
          },
        }),
      });
      await response.text();
      return response;
    };
    expect((yield* Effect.promise(() => initialize(issued.token))).status).toBe(200);
    expect((yield* Effect.promise(() => initialize("invalid"))).status).toBe(401);
    const context = yield* Layer.build(
      layerLinkingEnvironment(descriptorOf("local-linking", "Local")),
    );
    const links = Context.get(context, PeerLinks.PeerLinks);
    const pairing = yield* peer.auth.issuePairingCredential();
    const linked = yield* links.link({
      url: `${base}/mcp`,
      pairingCode: pairing.credential,
      access: "read-only",
    });
    expect(linked.environmentId).toBe("remote-relay-mcp");
    expect(linked.urls).toEqual([base]);
    const resolved = yield* links.resolve(linked.environmentId);
    expect(resolved.url).toBe(base);
    expect((yield* links.unlink(linked.environmentId)).endedThere).toBe(true);
    yield* peer.auth.revokeMcpClientToken(issued.token);
    expect((yield* Effect.promise(() => initialize(issued.token))).status).toBe(401);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, FetchHttpClient.layer)),
  ),
);
