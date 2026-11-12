// @effect-diagnostics nodeBuiltinImport:off -- Real loopback HTTP fixture for byte-preserving port forwarding.
// @effect-diagnostics globalFetchInEffect:off -- Exercise a real browser-shaped HTTP client through the encrypted tunnel.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createLoopbackTunnel } from "@t3tools/relay-transport/tunnel";
import { EncryptedRelayClient } from "@t3tools/relay-transport";
import { connectHost } from "@t3tools/relay-transport/node";
import { generateIdentity } from "@t3tools/relay-transport/secure";
import { it, expect } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSessionId,
  PreviewTunnelTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServer } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { WebSocket, WebSocketServer } from "ws";

import { createRelayBroker } from "../../../../infra/selfhosted-relay/test/broker.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as PreviewTunnel from "./PreviewTunnel.ts";
import { routeLayer } from "./PreviewTunnelHttp.ts";

const isTunnelTarget = Schema.is(PreviewTunnelTarget);
const owner = AuthSessionId.make("tunnel-test");
const sessionLayer = Layer.mock(SessionStore.SessionStore, {
  cookieName: "fixture",
  legacyCookieName: undefined,
  issueWebSocketToken: () =>
    Effect.succeed({ token: "validation-ticket", expiresAt: DateTime.makeUnsafe(3_600_000) }),
  verifyWebSocketToken: () =>
    Effect.succeed({
      sessionId: owner,
      subject: "test",
      method: "bearer-access-token",
      scopes: [AuthPreviewOperateScope],
      token: "validation-ticket",
      client: { deviceType: "unknown" },
    }),
  awaitInvalidation: () => Effect.never,
});

it.effect("restricts grants to loopback ports, expires them, and revokes them", () =>
  Effect.gen(function* () {
    const tunnels = yield* PreviewTunnel.PreviewTunnel;
    for (const target of [
      { hostname: "example.com", port: 80 },
      { hostname: "127.0.0.1", port: 0 },
      { hostname: "localhost", port: 65536 },
    ])
      expect(isTunnelTarget(target)).toBe(false);
    const first = yield* tunnels.create({ hostname: "127.0.0.1", port: 8080 }, owner);
    yield* tunnels.revoke(first.token);
    const socket = Socket.make({
      reader: Effect.die("must not connect"),
      writer: Effect.die("must not connect"),
    });
    expect(
      yield* tunnels.bridge(first.token, socket).pipe(Effect.flip, Effect.scoped),
    ).toMatchObject({ _tag: "PreviewTunnelError" });
    const second = yield* tunnels.create({ hostname: "localhost", port: 8080 }, owner);
    yield* TestClock.adjust("1 hour");
    expect(
      yield* tunnels.bridge(second.token, socket).pipe(Effect.flip, Effect.scoped),
    ).toMatchObject({ _tag: "PreviewTunnelError" });
  }).pipe(
    Effect.provide(
      PreviewTunnel.layer.pipe(
        Layer.provide(sessionLayer),
        Layer.provide(SecureRandom.layerWebCrypto),
      ),
    ),
  ),
);

it.live("forwards HTTP bodies, cookies, redirects and WebSockets through the encrypted relay", () =>
  Effect.gen(function* () {
    const site = NodeHttp.createServer(async (request, response) => {
      if (request.url === "/close") {
        response.writeHead(200, { connection: "close" });
        response.end(Buffer.alloc(1024 * 1024, 17));
        return;
      }
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/nested/page" });
        response.end();
        return;
      }
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const bytes of request) chunks.push(bytes);
        response.end(Buffer.concat(chunks));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": ["test=one; HttpOnly; Path=/", "other=two; Path=/"],
      });
      response.end(`<h1>${request.url}</h1><p>${request.headers.cookie ?? ""}</p>`);
    });
    const ws = new WebSocketServer({ server: site });
    ws.on("connection", (socket) =>
      socket.on("message", (bytes, binary) => socket.send(bytes, { binary })),
    );
    yield* Effect.promise(
      () => new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve)),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const socket of ws.clients) socket.terminate();
        await new Promise<void>((resolve) => ws.close(() => resolve()));
        site.closeAllConnections();
        await new Promise<void>((resolve) => site.close(() => resolve()));
      }),
    );
    const tunnelLayer = PreviewTunnel.layer.pipe(
      Layer.provide(sessionLayer),
      Layer.provide(SecureRandom.layerWebCrypto),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routeLayer.pipe(Layer.provide(tunnelLayer)), {
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: (request) =>
              request.url.includes("allowed") || request.url.includes("read-only")
                ? Effect.succeed({
                    sessionId: owner,
                    subject: "test",
                    method: "bearer-access-token",
                    scopes: request.url.includes("read-only")
                      ? [AuthOrchestrationReadScope]
                      : [AuthPreviewOperateScope],
                  })
                : Effect.fail(
                    new EnvironmentAuth.ServerAuthSessionCredentialValidationError({
                      cause: "fixture unauthorized",
                    }),
                  ),
          }),
        ),
      ),
    );
    const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address)
      .replace("0.0.0.0", "127.0.0.1")
      .replace("[::]", "[::1]");
    const broker = yield* Effect.acquireRelease(
      Effect.promise(() =>
        createRelayBroker({ registrationToken: "fixture-only-browser-tunnel-registration-0000" }),
      ),
      (broker) => Effect.promise(() => broker.close()),
    );
    const identity = yield* Effect.promise(() => generateIdentity());
    const address = {
      relayUrl: broker.url,
      route: "1234567890abcdef1234567890abcdef",
      peerId: identity.peerId,
    };
    const ready = Promise.withResolvers<void>();
    const host = yield* Effect.promise((signal) =>
      connectHost({
        address,
        target: origin,
        registrationToken: "fixture-only-browser-tunnel-registration-0000",
        privateKey: identity.privateKey,
        signal,
        onConnected: () => ready.resolve(),
      }),
    ).pipe(Effect.forkScoped);
    yield* Effect.raceFirst(
      Effect.promise(() => ready.promise),
      Fiber.join(host),
    );
    const client = new EncryptedRelayClient((url) => new WebSocket(url));
    yield* Effect.addFinalizer(() => Effect.sync(() => client.dispose()));
    const endpoint = client.register(address).httpBaseUrl;
    const port = (site.address() as NodeNet.AddressInfo).port;
    const denied = yield* Effect.promise(() =>
      client.fetch(`${endpoint}/api/preview-tunnel`, {
        method: "POST",
        body: JSON.stringify({ hostname: "127.0.0.1", port }),
      }),
    );
    expect(denied.status).toBe(403);
    yield* Effect.promise(() => denied.text());
    const readOnly = yield* Effect.promise(() =>
      client.fetch(`${endpoint}/api/preview-tunnel?wsTicket=read-only`, {
        method: "POST",
        body: JSON.stringify({ hostname: "127.0.0.1", port }),
      }),
    );
    expect(readOnly.status).toBe(403);
    yield* Effect.promise(() => readOnly.text());
    const granted = yield* Effect.promise(() =>
      client.fetch(`${endpoint}/api/preview-tunnel?wsTicket=allowed`, {
        method: "POST",
        body: JSON.stringify({ hostname: "127.0.0.1", port }),
      }),
    );
    expect(granted.status).toBe(200);
    const grant = (yield* Effect.promise(() => granted.json())) as { token: string };
    const tunnel = yield* Effect.acquireRelease(
      Effect.promise(() =>
        createLoopbackTunnel({
          wsUrl: `${endpoint.replace("https:", "wss:")}/api/preview-tunnel/ws?wsTicket=${grant.token}`,
          relay: address,
        }),
      ),
      (tunnel) => Effect.promise(() => tunnel.close()),
    );
    const local = `http://127.0.0.1:${tunnel.port}`;
    const page = yield* Effect.promise(() =>
      fetch(`${local}/nested/page?x=1`, { headers: { cookie: "from=browser" } }),
    );
    expect(page.headers.getSetCookie()).toEqual([
      "test=one; HttpOnly; Path=/",
      "other=two; Path=/",
    ]);
    expect(yield* Effect.promise(() => page.text())).toContain(
      "/nested/page?x=1</h1><p>from=browser",
    );
    const complete = yield* Effect.promise(() => fetch(`${local}/close`));
    expect(new Uint8Array(yield* Effect.promise(() => complete.arrayBuffer()))).toEqual(
      new Uint8Array(1024 * 1024).fill(17),
    );
    const bytes = new Uint8Array(1024 * 1024).fill(42);
    const uploaded = yield* Effect.promise(() =>
      fetch(`${local}/upload`, { method: "POST", body: bytes }),
    );
    expect(new Uint8Array(yield* Effect.promise(() => uploaded.arrayBuffer()))).toEqual(bytes);
    const redirect = yield* Effect.promise(() =>
      fetch(`${local}/redirect`, { redirect: "manual" }),
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/nested/page");
    yield* Effect.promise(() => redirect.text());
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(local.replace("http:", "ws:") + "/hmr")),
      (socket) => Effect.sync(() => socket.terminate()),
    );
    const echoed = Promise.withResolvers<Buffer>();
    socket.on("message", (data) => echoed.resolve(Buffer.from(data as Buffer)));
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        }),
    );
    socket.send(bytes);
    expect(yield* Effect.promise(() => echoed.promise)).toEqual(Buffer.from(bytes));
    const revoked = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const removed = yield* Effect.promise(() =>
      client.fetch(`${endpoint}/api/preview-tunnel?wsTicket=${grant.token}`, { method: "DELETE" }),
    );
    expect(removed.status).toBe(204);
    yield* Effect.promise(() => revoked);
  }).pipe(Effect.scoped),
);
