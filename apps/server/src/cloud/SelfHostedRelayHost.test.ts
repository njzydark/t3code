import * as DateTime from "effect/DateTime";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  type ManagedPolicyDocument,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SelfHostedRelay from "./SelfHostedRelay.ts";
import * as SelfHostedRelayHost from "./SelfHostedRelayHost.ts";

const token = "test-registration-secret-".repeat(2);
const url = "https://relay.example.com";
const fixture = (policy?: ManagedPolicyDocument) =>
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
      ManagedPolicy.layerTest(policy),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-settings-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      Layer.mock(ServerSecretStore.ServerSecretStore)({
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
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
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
