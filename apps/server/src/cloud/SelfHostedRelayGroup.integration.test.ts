import { expect, it } from "@effect/vitest";
import { NodeHttpServer, NodeCrypto } from "@effect/platform-node";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentHttpApi,
  SELF_HOSTED_RELAY_CONNECT_PATH,
} from "@t3tools/contracts";
import { virtualRelayOrigin } from "@t3tools/relay-transport/protocol";
import { connectHost, createNodeRelayClient } from "@t3tools/relay-transport/node";
import { generateIdentity } from "@t3tools/relay-transport/secure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { createRelayBroker } from "../../../../infra/selfhosted-relay/test/broker.ts";
import { descriptorOf, servePeer } from "../peer/PeerLinks.testkit.ts";
import { makeDpopKey } from "../auth/dpop.testkit.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SelfHostedRelay from "./SelfHostedRelay.ts";
import { SelfHostedRelayHost, layer as hostLayer } from "./SelfHostedRelayHost.ts";
import * as SelfHostedRelayHttp from "./SelfHostedRelayHttp.ts";
import { signGroupGrant } from "./selfHostedRelayGroupAuth.ts";

const decodeAccessToken = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }));

class GroupTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const groupPeer = Effect.fn("test.groupPeer")(function* (input: {
  readonly id: string;
  readonly route: string;
  readonly relayUrl: string;
  readonly token: string;
}) {
  const hosts = yield* Queue.unbounded<SelfHostedRelayHost["Service"]>();
  const routes = Layer.mergeAll(
    SelfHostedRelayHttp.layer,
    Layer.effectDiscard(
      SelfHostedRelayHost.pipe(Effect.flatMap((host) => Queue.offer(hosts, host))),
    ),
    HttpApiBuilder.layer(GroupTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
  ).pipe(
    Layer.provide(
      hostLayer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(
          Layer.mock(SelfHostedRelay.SelfHostedRelay)({
            run: ({ onStatus }) =>
              (onStatus?.("connected") ?? Effect.void).pipe(Effect.andThen(Effect.never)),
          }),
        ),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
  );
  const server = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
  const peer = yield* servePeer(
    descriptorOf(input.id, input.id, { accessTokenRenewal: true }),
    Layer.empty,
    routes,
  ).pipe(Effect.provideContext(server));
  const host = yield* Queue.take(hosts);
  yield* host.update({ relayUrl: input.relayUrl, registrationToken: input.token, enabled: true });
  const identity = yield* Effect.promise(generateIdentity);
  yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const controller = new AbortController();
      const ready = Promise.withResolvers<void>();
      const task = connectHost({
        address: { relayUrl: input.relayUrl, route: input.route, peerId: identity.peerId },
        registrationToken: input.token,
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
  return {
    ...peer,
    host,
    address: { relayUrl: input.relayUrl, route: input.route, peerId: identity.peerId },
  };
});

it.live(
  "connects without manual codes and enforces group isolation, scopes, key binding, replay and revocation",
  () =>
    Effect.gen(function* () {
      const token = "trusted-owner-group-fixture-".repeat(2);
      const otherToken = "another-owner-group-fixture-".repeat(2);
      const broker = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createRelayBroker({
            registrationToken: token,
            tokens: { owner: token, other: otherToken },
          }),
        ),
        (broker) => Effect.promise(() => broker.close()),
      );
      const source = yield* groupPeer({
        id: "source",
        route: "a".repeat(32),
        relayUrl: broker.url,
        token,
      });
      const target = yield* groupPeer({
        id: "target",
        route: "b".repeat(32),
        relayUrl: broker.url,
        token,
      });
      const other = yield* groupPeer({
        id: "other",
        route: "c".repeat(32),
        relayUrl: broker.url,
        token: otherToken,
      });
      const key = makeDpopKey();
      const wrongKey = makeDpopKey();
      const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      const proof = (path: string, proofKey = key, token = "") =>
        proofKey.sign({
          method: "POST",
          url: virtualRelayOrigin(target.address.route) + path,
          token,
          iat,
        });
      const input = {
        environmentId: (yield* Ref.get(target.descriptor)).environmentId,
        proof: proof(SELF_HOSTED_RELAY_CONNECT_PATH),
      };
      expect(
        (yield* source.host.connect([AuthOrchestrationReadScope], input).pipe(Effect.flip))
          .operation,
      ).toBe("permissions");
      expect(
        (yield* source.host
          .connect(AuthStandardClientScopes, {
            ...input,
            environmentId: (yield* Ref.get(other.descriptor)).environmentId,
          })
          .pipe(Effect.flip)).operation,
      ).toBe("unavailable");
      const issued = yield* source.host.connect(
        [AuthAccessWriteScope, AuthOrchestrationReadScope],
        input,
      );
      expect(issued.environment.environmentId).toBe(input.environmentId);
      expect(
        (yield* source.host.connect(AuthStandardClientScopes, input).pipe(Effect.flip)).operation,
      ).toBe("pairing");
      const client = yield* Effect.acquireRelease(Effect.sync(createNodeRelayClient), (client) =>
        Effect.sync(() => client.dispose()),
      );
      const endpoint = client.register(target.address);
      const exchange = (
        credential: string,
        proofKey: ReturnType<typeof makeDpopKey> | null = key,
      ) =>
        Effect.promise(async () => {
          const response = await client.fetch(endpoint.httpBaseUrl + "/oauth/token", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              ...(proofKey ? { dpop: proof("/oauth/token", proofKey) } : {}),
            },
            body: new URLSearchParams({
              grant_type: AuthTokenExchangeGrantType,
              subject_token: credential,
              subject_token_type: AuthEnvironmentBootstrapTokenType,
              requested_token_type: AuthAccessTokenType,
            }),
          });
          return { status: response.status, body: await response.json() };
        });
      expect((yield* exchange(issued.credential, null)).status).toBe(401);
      expect((yield* exchange(issued.credential, wrongKey)).status).toBe(401);
      const access = yield* exchange(issued.credential);
      expect(access.status).toBe(200);
      expect(access.body).toMatchObject({ token_type: "DPoP" });
      expect((yield* exchange(issued.credential)).status).toBe(401);
      const sessions = yield* target.auth.listSessions();
      const session = sessions.find((session) => session.subject === "self-hosted-relay-group");
      expect(session?.scopes).toEqual([AuthOrchestrationReadScope, AuthAccessWriteScope]);
      const accessToken = decodeAccessToken(access.body).access_token;
      const request = (scheme = "DPoP") =>
        Effect.promise(async () => {
          const url = endpoint.httpBaseUrl + "/api/auth/session";
          const response = await client.fetch(url, {
            headers: {
              authorization: `${scheme} ${accessToken}`,
              dpop: key.sign({ method: "GET", url, token: accessToken, iat }),
            },
          });
          return response.json();
        });
      expect(yield* request()).toMatchObject({
        authenticated: true,
        scopes: [AuthOrchestrationReadScope, AuthAccessWriteScope],
      });
      expect(yield* request("Bearer")).toMatchObject({ authenticated: false });
      expect(session).toBeDefined();
      const unspent = yield* source.host.connect(AuthStandardClientScopes, {
        ...input,
        proof: proof(SELF_HOSTED_RELAY_CONNECT_PATH),
      });
      if (session) yield* target.auth.revokeClient(session.sessionId);
      expect((yield* exchange(unspent.credential)).status).toBe(401);
      expect(yield* request()).toMatchObject({ authenticated: false });

      const postGrant = Effect.fn("test.postGrant")(function* (
        secret: string,
        environmentId = input.environmentId,
      ) {
        const grant = yield* signGroupGrant(secret, {
          environmentId,
          scopes: AuthStandardClientScopes,
          proof: proof(SELF_HOSTED_RELAY_CONNECT_PATH),
        });
        const response = yield* Effect.promise(() =>
          client.fetch(endpoint.httpBaseUrl + SELF_HOSTED_RELAY_CONNECT_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(grant),
          }),
        );
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
        return response.status;
      });
      expect(yield* postGrant(otherToken)).toBe(403);
      expect(yield* postGrant(token, (yield* Ref.get(source.descriptor)).environmentId)).toBe(403);
      const expired = yield* signGroupGrant(token, {
        environmentId: input.environmentId,
        scopes: AuthStandardClientScopes,
        proof: key.sign({
          method: "POST",
          url: endpoint.httpBaseUrl + SELF_HOSTED_RELAY_CONNECT_PATH,
          token: "",
          iat: iat - 3600,
        }),
      });
      const refused = yield* Effect.promise(() =>
        client.fetch(endpoint.httpBaseUrl + SELF_HOSTED_RELAY_CONNECT_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(expired),
        }),
      );
      expect(refused.status).toBe(403);
      yield* Effect.promise(() => refused.body?.cancel() ?? Promise.resolve());
      const http = yield* HttpClient.HttpClient;
      const hidden = yield* HttpClientRequest.post(
        `${broker.url}/v1/environments/target${SELF_HOSTED_RELAY_CONNECT_PATH}`,
      ).pipe(http.execute);
      expect(hidden.status).toBe(404);
      yield* hidden.text;
      yield* target.host.update({ relayUrl: broker.url, enabled: false });
      expect(yield* postGrant(token)).toBe(403);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeHttpServer.layerTest, FetchHttpClient.layer, NodeCrypto.layer),
      ),
    ),
);
