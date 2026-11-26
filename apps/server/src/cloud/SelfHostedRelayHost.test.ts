import * as DateTime from "effect/DateTime";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  SELF_HOSTED_RELAY_CONNECT_PATH,
  type ManagedPolicyDocument,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer, FetchHttpClient } from "effect/http";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { layerEnvironmentAuth } from "../peer/PeerLinks.testkit.ts";
import { makeDpopKey } from "../auth/dpop.testkit.ts";
import { signGroupGrant } from "./selfHostedRelayGroupAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { EnvironmentId } from "@t3tools/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SelfHostedRelay from "./SelfHostedRelay.ts";
import * as SelfHostedRelayHost from "./SelfHostedRelayHost.ts";

const token = "test-registration-secret-".repeat(2);
const url = "https://relay.example.com";
const fixture = (
  policy?: ManagedPolicyDocument,
  services?: {
    readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
    readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  },
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const started =
      yield* Queue.unbounded<Parameters<SelfHostedRelay.SelfHostedRelay["Service"]["run"]>[0]>();
    const stopped = yield* Queue.unbounded<void>();
    const issued =
      yield* Queue.unbounded<
        Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"]>[0]
      >();
    let failStorage = false;
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      FetchHttpClient.layer,
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture")),
      }),
      ManagedPolicy.layerTest(policy),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-settings-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      services
        ? Layer.succeed(ServerSecretStore.ServerSecretStore, services.secrets)
        : Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: (name) => Effect.sync(() => Option.fromUndefinedOr(stored.get(name))),
            set: (name, bytes) =>
              Effect.suspend(() =>
                failStorage
                  ? Effect.fail(
                      new ServerSecretStore.SecretStorePersistError({
                        resource: "test",
                        cause: new Error("private"),
                      }),
                    )
                  : Effect.sync(() => {
                      stored.set(name, bytes);
                    }),
              ),
            remove: (name) =>
              Effect.sync(() => {
                stored.delete(name);
              }),
          }),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 4321),
      }),
      services
        ? Layer.succeed(EnvironmentAuth.EnvironmentAuth, services.auth)
        : Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            createPairingLink: (input) =>
              Queue.offer(issued, input).pipe(
                Effect.as({
                  id: "pairing-id",
                  credential: "one-time",
                  ...(input?.label ? { label: input.label } : {}),
                  scopes: input?.scopes ?? [],
                  subject: "one-time-token",
                  createdAt: DateTime.makeUnsafe(0),
                  expiresAt: DateTime.makeUnsafe(600_000),
                }),
              ),
            revokePairingLink: () => Effect.succeed(true),
            issueMcpClientSession: () =>
              Effect.succeed({
                sessionId: "mcp-session" as import("@t3tools/contracts").AuthSessionId,
                token: "fixture-mcp-token",
                expiresAt: DateTime.makeUnsafe(30 * 86400_000),
              }),
          }),
      Layer.succeed(SelfHostedRelay.SelfHostedRelay, {
        run: (input) =>
          Effect.gen(function* () {
            yield* input.onStatus?.("connected") ?? Effect.void;
            yield* Queue.offer(started, input);
            return yield* Effect.never;
          }).pipe(Effect.onInterrupt(() => Queue.offer(stopped, undefined))),
        pairingUrl: (input) => Effect.succeed(`${input.relayUrl}/pair#token=${input.credential}`),
      }),
    );
    const context = yield* Layer.build(dependencies);
    const layer = SelfHostedRelayHost.layer.pipe(Layer.provide(Layer.succeedContext(context)));
    const read = (host: SelfHostedRelayHost.SelfHostedRelayHost["Service"]) =>
      host.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
    return {
      stored,
      started,
      stopped,
      issued,
      layer,
      read,
      failWrites: () => {
        failStorage = true;
      },
    };
  });

describe("self-hosted relay host settings", () => {
  it.effect.each([false, true])(
    "renews a relay device after its required approval (automatic: %s)",
    (automatic) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(layerEnvironmentAuth("t3-relay-client-name-"));
        const auth = yield* EnvironmentAuth.EnvironmentAuth.pipe(Effect.provideContext(context));
        const secrets = yield* ServerSecretStore.ServerSecretStore.pipe(
          Effect.provideContext(context),
        );
        const f = yield* fixture(undefined, { auth, secrets });
        yield* Effect.gen(function* () {
          const host = yield* SelfHostedRelayHost.SelfHostedRelayHost;
          yield* host.update({
            relayUrl: url,
            registrationToken: token,
            enabled: true,
            ...(automatic ? { autoApproveNewDevices: true } : {}),
          });
          yield* Queue.take(f.started);
          const key = makeDpopKey();
          const requestUrl = `https://target.example${SELF_HOSTED_RELAY_CONNECT_PATH}`;
          const grant = yield* signGroupGrant(token, {
            environmentId: EnvironmentId.make("fixture"),
            scopes: [AuthAccessReadScope],
            proof: key.sign({
              method: "POST",
              url: requestUrl,
              token: "",
              iat: Math.floor((yield* DateTime.now).epochMilliseconds / 1000),
            }),
          });
          const request = HttpServerRequest.fromWeb(
            new Request(requestUrl, { method: "POST", headers: { host: "target.example" } }),
          );
          const issued = yield* host.authorize(request, grant);
          const exchange = () =>
            auth.exchangeBootstrapCredentialForAccessToken(
              issued.credential,
              undefined,
              { label: "Connecting MacBook", deviceType: "desktop", os: "macOS" },
              { proofKeyThumbprint: key.thumbprint },
            );
          if (!automatic) {
            expect(issued.approval?.verificationCode).toBeDefined();
            expect((yield* exchange().pipe(Effect.flip))._tag).toBe(
              "ServerAuthConnectApprovalPendingError",
            );
            expect(yield* auth.listSessions()).toEqual([]);
          } else expect(issued.approval).toBeUndefined();
          yield* host.update({ relayUrl: url, enabled: true, autoApproveNewDevices: !automatic });
          yield* Queue.take(f.started);
          if (!automatic) {
            expect((yield* exchange().pipe(Effect.flip))._tag).toBe(
              "ServerAuthConnectApprovalPendingError",
            );
            const [pending] = yield* auth.listPairingLinks();
            expect(pending?.connectDeviceRequest).toMatchObject({
              verificationCode: issued.approval?.verificationCode,
              client: { label: "Connecting MacBook", os: "macOS" },
            });
            expect(pending?.connectDeviceRequest?.source).toBeDefined();
            expect(
              yield* auth.approveConnectDevice(
                Option.getOrThrow(Option.fromUndefinedOr(pending)).id,
              ),
            ).toBe(true);
            expect(yield* auth.listConnectDevices()).toEqual([]);
          }
          const access = yield* auth.exchangeBootstrapCredentialForAccessToken(
            issued.credential,
            undefined,
            { label: "Connecting MacBook", deviceType: "desktop", os: "macOS" },
            { proofKeyThumbprint: key.thumbprint },
          );
          expect(yield* auth.listSessions()).toMatchObject([
            {
              authorizationSource: automatic ? "relay-auto" : "relay-approved",
              scopes: [AuthAccessReadScope],
              client: { label: "Connecting MacBook", deviceType: "desktop", os: "macOS" },
            },
          ]);
          const session = Option.getOrThrow(
            Option.fromUndefinedOr((yield* auth.listSessions())[0]),
          );
          expect((yield* host.authorize(request, grant).pipe(Effect.flip)).operation).toBe(
            "pairing",
          );
          yield* TestClock.adjust("61 minutes");
          expect(
            (yield* auth
              .renewAccessToken(access.access_token, makeDpopKey().thumbprint, Effect.void)
              .pipe(Effect.flip))._tag,
          ).toBe("ServerAuthInvalidCredentialError");
          const replay = new EnvironmentAuth.ServerAuthInvalidCredentialError({
            dpopFailureReason: "replay",
          });
          expect(
            yield* auth
              .renewAccessToken(access.access_token, key.thumbprint, Effect.fail(replay))
              .pipe(Effect.flip),
          ).toBe(replay);
          const renewed = yield* auth.renewAccessToken(
            access.access_token,
            key.thumbprint,
            Effect.void,
          );
          expect(renewed.expires_in).toBe(60 * 60);
          expect(renewed.scope).toBe(AuthAccessReadScope);
          const now = (yield* DateTime.now).epochMilliseconds;
          expect(yield* auth.listSessions()).toMatchObject([
            {
              sessionId: session.sessionId,
              authorizationSource: automatic ? "relay-auto" : "relay-approved",
              subject: "one-time-token",
              scopes: session.scopes,
              client: session.client,
              expiresAt: DateTime.makeUnsafe(now + 30 * 24 * 60 * 60 * 1000),
            },
          ]);
          expect(yield* auth.revokeSession(session.sessionId)).toBe(true);
          expect(
            (yield* auth
              .renewAccessToken(renewed.access_token, key.thumbprint, Effect.void)
              .pipe(Effect.flip))._tag,
          ).toBe("ServerAuthInvalidCredentialError");
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("issues revocable MCP credentials only within the caller's grants", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const host = yield* SelfHostedRelayHost.SelfHostedRelayHost;
        yield* host.update({ relayUrl: url, registrationToken: token, enabled: true });
        const denied = yield* host
          .mcpToken([AuthAccessWriteScope], { label: "Outside agent", access: "read-only" })
          .pipe(Effect.flip);
        expect(denied.operation).toBe("permissions");
        const issued = yield* host.mcpToken(AuthStandardClientScopes, {
          label: "Outside agent",
          access: "read-only",
        });
        expect(issued.url).toBe("https://relay.example.com/v1/environments/fixture/mcp");
        expect(issued.token).toBe("fixture-mcp-token");
        expect(JSON.stringify(yield* f.read(host))).not.toContain(issued.token);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "saves credentials privately, reconnects after restart, and supports disable and clear",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let identity = "";
        yield* Effect.gen(function* () {
          const host = yield* SelfHostedRelayHost.SelfHostedRelayHost;
          expect((yield* f.read(host)).phase).toBe("disabled");
          yield* host.update({ relayUrl: url, registrationToken: token, enabled: true });
          const first = yield* Queue.take(f.started);
          identity = first.identityFile;
          expect(first.target).toBe("http://127.0.0.1:4321");
          expect(first.registrationToken).toBe(token);
          const state = yield* f.read(host);
          expect(state.phase).toBe("connected");
          expect(JSON.stringify(state)).not.toContain(token);
          yield* first.onStatus?.("reconnecting") ?? Effect.void;
          expect((yield* f.read(host)).phase).toBe("reconnecting");
        }).pipe(Effect.provide(f.layer), Effect.scoped);
        yield* Queue.take(f.stopped);
        yield* Effect.gen(function* () {
          const host = yield* SelfHostedRelayHost.SelfHostedRelayHost;
          const resumed = yield* Queue.take(f.started);
          expect(resumed.identityFile).toBe(identity);
          expect(resumed.registrationToken).toBe(token);
          expect((yield* host.update({ relayUrl: url, enabled: false })).phase).toBe("disabled");
          yield* Queue.take(f.stopped);
          expect((yield* host.pair(AuthStandardClientScopes).pipe(Effect.flip)).operation).toBe(
            "unavailable",
          );
          yield* host.update({ relayUrl: url, enabled: true });
          yield* Queue.take(f.started);
          expect((yield* host.forget).hasRegistrationToken).toBe(false);
          yield* Queue.take(f.stopped);
          expect(f.stored.size).toBe(0);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects insecure URLs and missing tokens and leaves the running connector intact on storage failure",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const host = yield* SelfHostedRelayHost.SelfHostedRelayHost;
          for (const relayUrl of [
            "http://public.example.com",
            "https://user:password@relay.example.com",
            `${url}/path`,
            `${url}/#private`,
          ]) {
            expect(
              (yield* host
                .update({ relayUrl, registrationToken: token, enabled: true })
                .pipe(Effect.flip)).operation,
            ).toBe("configuration");
          }
          expect(
            (yield* host.update({ relayUrl: url, enabled: true }).pipe(Effect.flip)).operation,
          ).toBe("configuration");
          expect(f.stored.size).toBe(0);
          yield* host.update({ relayUrl: url, registrationToken: token, enabled: true });
          yield* Queue.take(f.started);
          f.failWrites();
          expect(
            (yield* host.update({ relayUrl: url, enabled: false }).pipe(Effect.flip)).operation,
          ).toBe("storage");
          expect((yield* f.read(host)).phase).toBe("connected");
          expect((yield* f.read(host)).error).toBeNull();
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.scoped),
  );

  it.effect("recovers from corrupt saved configuration without preventing server startup", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.stored.set("self-hosted-relay", new TextEncoder().encode("invalid json"));
      yield* Effect.gen(function* () {
        const host = yield* SelfHostedRelayHost.SelfHostedRelayHost;
        expect((yield* f.read(host)).phase).toBe("error");
        expect((yield* host.forget).phase).toBe("disabled");
        yield* host.update({ relayUrl: url, registrationToken: token, enabled: true });
        yield* Queue.take(f.started);
        expect((yield* f.read(host)).phase).toBe("connected");
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.scoped),
  );

  it.effect("honors the machine policy that prohibits remote clients", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        schemaVersion: 1,
        organization: "Test organization",
        limits: { clients: ["desktop"] },
      });
      f.stored.set(
        "self-hosted-relay",
        new TextEncoder().encode(
          JSON.stringify({ relayUrl: url, registrationToken: token, enabled: true }),
        ),
      );
      yield* Effect.gen(function* () {
        const host = yield* SelfHostedRelayHost.SelfHostedRelayHost;
        expect((yield* f.read(host)).phase).toBe("error");
        expect(
          (yield* host.update({ relayUrl: url, enabled: true }).pipe(Effect.flip)).operation,
        ).toBe("policy");
        expect((yield* host.update({ relayUrl: url, enabled: false })).phase).toBe("disabled");
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.scoped),
  );

  it.effect("delegates no permissions beyond the caller's grants when issuing pairing links", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const host = yield* SelfHostedRelayHost.SelfHostedRelayHost;
        yield* host.update({ relayUrl: url, registrationToken: token, enabled: true });
        yield* Queue.take(f.started);
        expect(yield* host.pair([AuthAccessReadScope, AuthAccessWriteScope])).toMatchObject({
          url: `${url}/pair#token=one-time`,
        });
        expect((yield* Queue.take(f.issued))?.scopes).toEqual(
          AuthStandardClientScopes.filter(
            (scope) => scope === AuthAccessReadScope || scope === AuthAccessWriteScope,
          ),
        );
        const readOnly = yield* host.pair(AuthStandardClientScopes, {
          label: "Read-only iPad",
          scopes: [AuthAccessReadScope],
        });
        expect(readOnly).toMatchObject({
          id: "pairing-id",
          credential: "one-time",
          label: "Read-only iPad",
        });
        expect(yield* Queue.take(f.issued)).toMatchObject({
          label: "Read-only iPad",
          scopes: [AuthAccessReadScope],
        });
        for (const scopes of [
          [AuthAccessWriteScope],
          [],
          [AuthAccessReadScope, AuthAccessReadScope],
        ] as const) {
          expect(
            (yield* host.pair([AuthAccessReadScope], { scopes }).pipe(Effect.flip)).operation,
          ).toBe("permissions");
        }
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.scoped),
  );
});
