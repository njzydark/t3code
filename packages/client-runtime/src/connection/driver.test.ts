import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Stream from "effect/Stream";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  SshConnectionTarget,
  ConnectionTransientError,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const target = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("self-relay-environment"),
  label: "Self-hosted environment",
  connectionId: "self-relay",
});
const profile = new BearerConnectionProfile({
  connectionId: target.connectionId,
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: "http://127.0.0.1:49123/",
  wsBaseUrl: "ws://127.0.0.1:49123/",
  selfHostedRelay: {
    relayUrl: "https://relay.example.test",
    route: "1234567890abcdef1234567890abcdef",
    peerId: "pinned-host",
  },
});
const entry: ConnectionCatalogEntry = { target, profile: Option.some(profile), enabled: true };
const prepared: PreparedConnection = {
  target,
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: profile.httpBaseUrl,
  socketUrl: `${profile.wsBaseUrl}ws`,
  httpAuthorization: null,
};

describe("ConnectionDriver self-hosted relay recovery", () => {
  it.effect.each(["discovery", "synchronization", "connected", "interrupted"] as const)(
    "rebuilds a stale relay after the %s attempt scope ends",
    (stage) =>
      Effect.gen(function* () {
        const stalled = yield* Ref.make(false);
        const attempts = yield* Ref.make(0);
        const preparing = yield* Deferred.make<void>();
        const disconnected = new ConnectionTransientError({
          reason: "network",
          detail: "The cached relay channel no longer answers.",
        });
        const unused = () => Effect.die("Unexpected authorization operation.");
        const dependencies = Layer.mergeAll(
          Layer.succeed(ClientCapabilities.SelfHostedRelayGateway, {
            prepare: unused,
            disconnect: () => Ref.set(stalled, false),
          }),
          Layer.succeed(ConnectionResolver.ConnectionResolver, {
            prepare: () =>
              Effect.gen(function* () {
                const attempt = yield* Ref.updateAndGet(attempts, (value) => value + 1);
                if (yield* Ref.get(stalled)) return yield* disconnected;
                if (attempt === 1 && (stage === "discovery" || stage === "interrupted")) {
                  yield* Ref.set(stalled, true);
                  if (stage === "interrupted") {
                    yield* Deferred.succeed(preparing, undefined);
                    return yield* Effect.never;
                  }
                  return yield* disconnected;
                }
                return prepared;
              }),
            prepareForUpdate: unused,
          }),
          Layer.succeed(RpcSession.RpcSessionFactory, {
            connect: () =>
              Effect.succeed({
                client: {} as WsRpcProtocolClient,
                initialConfig: unused(),
                subscribeServerConfig: () => Stream.empty,
                ready: Effect.gen(function* () {
                  if ((yield* Ref.get(attempts)) === 1 && stage === "synchronization") {
                    yield* Ref.set(stalled, true);
                    return yield* disconnected;
                  }
                }),
                probe: Effect.void,
                inboundFrames: Effect.succeed(0),
                closed: Effect.never,
              }),
          }),
          Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
            authorizeBearer: unused,
            authorizeDpop: unused,
            authorizeDpopHttp: unused,
            renewDpopBeforeExpiry: unused,
          }),
          RpcHttp.layerRemoteHttpClient(() => Promise.reject(new Error("Unexpected HTTP probe."))),
        );
        const driver = yield* ConnectionDriver.ConnectionDriver.pipe(
          Effect.provide(ConnectionDriver.layer.pipe(Layer.provide(dependencies))),
        );
        const connect = driver.connect(entry, () => Effect.void);
        if (stage === "interrupted") {
          const first = yield* Effect.forkChild(Effect.scoped(connect));
          yield* Deferred.await(preparing);
          yield* Fiber.interrupt(first);
        } else {
          const first = yield* Effect.scoped(
            connect.pipe(
              Effect.tap(() => Ref.set(stalled, true)),
              Effect.result,
            ),
          );
          expect(first._tag).toBe(stage === "connected" ? "Success" : "Failure");
        }
        const recovered = yield* Effect.scoped(connect);
        expect(recovered.prepared.environmentId).toBe(target.environmentId);
        expect(recovered.prepared.httpBaseUrl).toBe(profile.httpBaseUrl);
      }),
  );
});

const sshTarget = (connectionId: string) =>
  new SshConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Test environment",
    connectionId,
  });

const ENTRY: ConnectionCatalogEntry = {
  target: sshTarget("ssh-first"),
  profile: Option.none(),
  enabled: true,
  alternateRoutes: [{ target: sshTarget("ssh-second"), profile: Option.none() }],
};

describe("ConnectionDriver", () => {
  it.effect("reports preparing before each route it prepares", () =>
    Effect.gen(function* () {
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ClientCapabilities.SelfHostedRelayGateway)({}),
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (entry) =>
                Effect.succeed({
                  environmentId: entry.target.environmentId,
                  label: entry.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: entry.target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
                ),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            // SSH routes have no HTTP check, so the driver never sends a request.
            FetchHttpClient.layer,
          ),
        ),
      );

      yield* driver
        .connect(ENTRY, (progress) => Ref.update(stages, (all) => [...all, progress.stage]))
        .pipe(Effect.scoped, Effect.flip);

      expect(yield* Ref.get(stages)).toEqual([
        "preparing",
        "preparing",
        "opening",
        "preparing",
        "opening",
      ]);
    }),
  );
});
