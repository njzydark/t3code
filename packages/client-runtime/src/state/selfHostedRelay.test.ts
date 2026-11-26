import {
  AuthAccessWriteScope,
  AuthRelayReadScope,
  EnvironmentId,
  SelfHostedRelayOperationError,
  type AuthSessionState,
  type SelfHostedRelayDirectory,
  type SelfHostedRelayStatus,
  WS_METHODS,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type NetworkStatus,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { ConnectionOnboarding, type PairingConnectionInput } from "../connection/onboarding.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { parseRelayPairingUrl } from "@t3tools/relay-transport";
import { SELF_HOSTED_RELAY_CONNECT_PATH } from "@t3tools/contracts";
import { createSelfHostedRelayAtoms } from "./selfHostedRelay.ts";

it.effect.each(["primary", "relay"] as const)(
  "discovers online peers through a $0 environment and hides peers once added",
  (mode) =>
    Effect.gen(function* () {
      const local = EnvironmentId.make("mac-local");
      const remote = EnvironmentId.make("mac-remote");
      const relayUrl = "https://relay.example.test";
      const address = {
        relayUrl,
        route: "a".repeat(32),
        peerId: "12D3KooWFixturePeerIdentityForTest",
      };
      const entry: ConnectionCatalogEntry = {
        target:
          mode === "primary"
            ? new PrimaryConnectionTarget({
                environmentId: local,
                label: "Local",
                httpBaseUrl: "http://127.0.0.1:3773",
                wsBaseUrl: "ws://127.0.0.1:3773",
              })
            : new BearerConnectionTarget({
                environmentId: local,
                label: "Local",
                connectionId: "relay-local",
              }),
        profile:
          mode === "primary"
            ? Option.none()
            : Option.some(
                new BearerConnectionProfile({
                  environmentId: local,
                  label: "Local",
                  connectionId: "relay-local",
                  httpBaseUrl: "https://local.example.test",
                  wsBaseUrl: "wss://local.example.test",
                  selfHostedRelay: address,
                }),
              ),
        enabled: true,
      };
      const directory = yield* SubscriptionRef.make<SelfHostedRelayDirectory>({
        relayUrl,
        environments: [
          { environmentId: local, label: "Local", route: "a".repeat(32), peerId: "local-peer" },
          {
            environmentId: remote,
            label: "Other Mac",
            route: "b".repeat(32),
            peerId: "remote-peer",
          },
        ],
      });
      const supervisor = {
        target: entry.target,
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.selfHostedRelayDirectory]: () => SubscriptionRef.changes(directory),
            },
          } as unknown as RpcSession),
        ),
      } as EnvironmentSupervisor["Service"];
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry, {
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as Pick<
          EnvironmentRegistry["Service"],
          "followStream"
        > as EnvironmentRegistry["Service"]),
      );
      const catalog = Atom.make({
        entries: new Map<EnvironmentId, ConnectionCatalogEntry>([[local, entry]]),
      });
      const atoms = createSelfHostedRelayAtoms({ runtime, catalog });
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      registry.mount(atoms.candidates);
      registry.mount(atoms.directory({ environmentId: local, input: {} }));
      yield* AtomRegistry.getResult(registry, atoms.directory({ environmentId: local, input: {} }));
      expect(registry.get(atoms.candidates)).toEqual([
        {
          environmentId: remote,
          viaEnvironmentId: local,
          label: "Other Mac",
          relayUrl,
          route: "b".repeat(32),
          peerId: "remote-peer",
        },
      ]);
      registry.set(catalog, {
        entries: new Map([
          [local, entry],
          [
            remote,
            {
              ...entry,
              target: new BearerConnectionTarget({
                environmentId: remote,
                label: "Other Mac",
                connectionId: "remote",
              }),
            },
          ],
        ]),
      });
      expect(registry.get(atoms.candidates)).toEqual([]);
    }).pipe(Effect.scoped),
);

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);

it.effect("offers the primary host's relay for links only while enabled and permitted", () =>
  Effect.gen(function* () {
    const local = EnvironmentId.make("mac-local");
    const target = new PrimaryConnectionTarget({
      environmentId: local,
      label: "Local",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
    });
    const state = yield* SubscriptionRef.make<SelfHostedRelayStatus>({
      relayUrl: "https://relay.example.test",
      enabled: true,
      hasRegistrationToken: true,
      phase: "connected",
      error: null,
    });
    let subscriptions = 0;
    const supervisor = {
      target,
      session: yield* SubscriptionRef.make(
        Option.some({
          client: {
            [WS_METHODS.selfHostedRelaySubscribe]: () => {
              subscriptions++;
              return SubscriptionRef.changes(state);
            },
          },
        } as unknown as RpcSession),
      ),
    } as EnvironmentSupervisor["Service"];
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry, {
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as Pick<EnvironmentRegistry["Service"], "followStream"> as EnvironmentRegistry["Service"]),
    );
    const atoms = createSelfHostedRelayAtoms({
      runtime,
      catalog: Atom.make({
        entries: new Map<EnvironmentId, ConnectionCatalogEntry>([
          [local, { target, profile: Option.none(), enabled: true }],
        ]),
      }),
    });
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );
    registry.mount(atoms.linkUrls);
    expect(registry.get(atoms.linkUrls).size).toBe(0);
    expect(subscriptions).toBe(0);
    const session: AuthSessionState = {
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthRelayReadScope],
      permissions: [AuthRelayReadScope],
    };
    registry.set(sessions(local), AsyncResult.success(session));
    const waitForUrl = (url: string | undefined) =>
      AtomRegistry.toStream(registry, atoms.linkUrls).pipe(
        Stream.filter((urls) => urls.get(local) === url),
        Stream.runHead,
      );
    yield* waitForUrl("https://relay.example.test/v1/environments/mac-local");
    expect(subscriptions).toBe(1);

    yield* SubscriptionRef.update(state, (current) => ({ ...current, enabled: false }));
    yield* waitForUrl(undefined);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      enabled: true,
      relayUrl: "https://replacement.example.test",
    }));
    yield* waitForUrl("https://replacement.example.test/v1/environments/mac-local");
    registry.set(sessions(local), AsyncResult.success({ ...session, scopes: [], permissions: [] }));
    expect(registry.get(atoms.linkUrls).size).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect.each([
  { allowed: true, hostFails: false },
  { allowed: false, hostFails: false },
  { allowed: true, hostFails: true },
])(
  "connects directly from discovery and honors access limits (allowed: $allowed, failure: $hostFails)",
  ({ allowed, hostFails }) =>
    Effect.gen(function* () {
      const source = EnvironmentId.make("source");
      const target = EnvironmentId.make("target");
      const candidate = {
        environmentId: target,
        viaEnvironmentId: source,
        label: "Target",
        relayUrl: "https://relay.example.test",
        route: "b".repeat(32),
        peerId: "12D3KooWFixturePeerIdentityForTest",
      };
      const grants: Array<{ environmentId: EnvironmentId; proof: string }> = [];
      const registrations: PairingConnectionInput[] = [];
      const supervisor = {
        target: new BearerConnectionTarget({
          environmentId: source,
          label: "Source",
          connectionId: "source",
        }),
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.selfHostedRelayConnect]: (input: {
                environmentId: EnvironmentId;
                proof: string;
              }) =>
                Effect.suspend(() => {
                  grants.push(input);
                  return hostFails
                    ? Effect.fail(new SelfHostedRelayOperationError({ operation: "unavailable" }))
                    : Effect.succeed({
                        environment: candidate,
                        relayUrl: candidate.relayUrl,
                        credential: "one-use-key-bound-grant",
                      });
                }),
            },
          } as unknown as RpcSession),
        ),
      } as EnvironmentSupervisor["Service"];
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map());
      const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.mock(EnvironmentRegistry)({
            entries,
            networkStatus,
            run: (_id, effect) =>
              effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
          }),
          Layer.mock(ConnectionOnboarding)({
            registerPairing: (input) =>
              Effect.sync(() => {
                registrations.push(input);
                return target;
              }),
          }),
          Layer.succeed(ManagedRelayDpopSigner, {
            thumbprint: Effect.succeed("client-key"),
            createProof: ({ method, url }) =>
              Effect.sync(() => {
                expect(method).toBe("POST");
                expect(url).toBe(
                  `https://${candidate.route}.t3-relay.invalid${SELF_HOSTED_RELAY_CONNECT_PATH}`,
                );
                return "device-proof";
              }),
          }),
        ),
      );
      const atoms = createSelfHostedRelayAtoms({
        runtime,
        catalog: Atom.make({ entries: new Map<EnvironmentId, ConnectionCatalogEntry>() }),
      });
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      registry.set(
        sessions(source),
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: allowed ? [AuthAccessWriteScope] : [],
          permissions: allowed ? [AuthAccessWriteScope] : [],
        }),
      );
      const result = yield* atoms.connect.run(registry, candidate).pipe(Effect.result);
      expect(result._tag).toBe(allowed && !hostFails ? "Success" : "Failure");
      expect(grants).toEqual(allowed ? [{ environmentId: target, proof: "device-proof" }] : []);
      expect(registrations).toHaveLength(allowed && !hostFails ? 1 : 0);
      if (registrations[0]) {
        expect(registrations[0]).toMatchObject({
          expectedEnvironmentId: target,
          requireDpop: true,
        });
        expect(parseRelayPairingUrl(registrations[0].pairingUrl!)).toMatchObject({
          route: candidate.route,
          peerId: candidate.peerId,
          token: "one-use-key-bound-grant",
        });
      }
    }).pipe(Effect.scoped),
);
