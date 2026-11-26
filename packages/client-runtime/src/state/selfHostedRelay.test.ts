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
import { RpcClientError } from "effect/rpc";
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
  ConnectionBlockedError,
  PrimaryConnectionTarget,
  type NetworkStatus,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { ConnectionOnboarding, type PairingConnectionInput } from "../connection/onboarding.ts";
import { ClientPresentation } from "../platform/capabilities.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { parseRelayPairingUrl } from "@t3tools/relay-transport";
import { SELF_HOSTED_RELAY_CONNECT_PATH } from "@t3tools/contracts";
import { createSelfHostedRelayAtoms } from "./selfHostedRelay.ts";

it.effect.each([
  { mode: "primary", conflict: false },
  { mode: "relay", conflict: false },
  { mode: "primary", conflict: true },
] as const)(
  "discovers peers through $mode, prefers the primary source, and keeps identities separate (conflict: $conflict)",
  ({ mode, conflict }) =>
    Effect.gen(function* () {
      const local = EnvironmentId.make("mac-local");
      const remote = EnvironmentId.make("mac-remote");
      const other = EnvironmentId.make("other-source");
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
      const otherSupervisor = {
        ...supervisor,
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.selfHostedRelayDirectory]: () =>
                SubscriptionRef.changes(directory).pipe(
                  Stream.map((value) =>
                    conflict
                      ? {
                          ...value,
                          environments: value.environments.map((peer) => ({
                            ...peer,
                            peerId: "different-peer-identity",
                          })),
                        }
                      : value,
                  ),
                ),
            },
          } as unknown as RpcSession),
        ),
      } as EnvironmentSupervisor["Service"];
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry, {
          followStream: (id, stream) =>
            Stream.provideService(
              stream,
              EnvironmentSupervisor,
              id === other ? otherSupervisor : supervisor,
            ),
        } as Pick<
          EnvironmentRegistry["Service"],
          "followStream"
        > as EnvironmentRegistry["Service"]),
      );
      const catalog = Atom.make({
        entries: new Map<EnvironmentId, ConnectionCatalogEntry>([
          [
            other,
            {
              ...entry,
              target: new BearerConnectionTarget({
                environmentId: other,
                label: "Other",
                connectionId: "other",
              }),
              profile: Option.some(
                new BearerConnectionProfile({
                  environmentId: other,
                  label: "Other",
                  connectionId: "other",
                  httpBaseUrl: "https://other.test",
                  wsBaseUrl: "wss://other.test",
                  selfHostedRelay: address,
                }),
              ),
            },
          ],
          [local, entry],
        ]),
      });
      const atoms = createSelfHostedRelayAtoms({ runtime, catalog });
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      registry.mount(atoms.candidates);
      registry.mount(atoms.directory({ environmentId: other, input: {} }));
      yield* AtomRegistry.getResult(registry, atoms.directory({ environmentId: other, input: {} }));
      registry.mount(atoms.directory({ environmentId: local, input: {} }));
      yield* AtomRegistry.getResult(registry, atoms.directory({ environmentId: local, input: {} }));
      expect(registry.get(atoms.candidates)).toEqual([
        {
          environmentId: remote,
          viaEnvironmentIds:
            mode === "primary" ? (conflict ? [local] : [local, other]) : [other, local],
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
  { failure: "none", allowed: true, success: true, attempts: ["source"] },
  { failure: "none", allowed: false, success: true, attempts: ["backup"] },
  { failure: "unavailable", allowed: true, success: true, attempts: ["source", "backup"] },
  { failure: "unsupported", allowed: true, success: true, attempts: ["source", "backup"] },
  { failure: "pairing", allowed: true, success: false, attempts: ["source"] },
  { failure: "permissions", allowed: true, success: false, attempts: ["source"] },
  { failure: "all", allowed: true, success: false, attempts: ["source", "backup"] },
  { failure: "onboarding", allowed: true, success: false, attempts: ["source"] },
  { failure: "offline", allowed: true, success: true, attempts: ["backup"] },
  { failure: "web", allowed: true, success: true, attempts: ["source"] },
  { failure: "mobile", allowed: true, success: true, attempts: ["source"] },
  { failure: "disabled", allowed: true, success: true, attempts: ["backup"] },
  { failure: "no-permission", allowed: false, success: false, attempts: [] },
] as const)(
  "connects through an eligible source without retrying an authorization denial or onboarding ($failure, allowed: $allowed)",
  ({ failure, allowed, success, attempts }) =>
    Effect.gen(function* () {
      const source = EnvironmentId.make("source");
      const backup = EnvironmentId.make("backup");
      const target = EnvironmentId.make("target");
      const candidate = {
        environmentId: target,
        viaEnvironmentIds: [source, backup],
        label: "Target",
        relayUrl: "https://relay.example.test",
        route: "b".repeat(32),
        peerId: "12D3KooWFixturePeerIdentityForTest",
      };
      const grants: Array<{ via: EnvironmentId; proof: string }> = [];
      const registrations: PairingConnectionInput[] = [];
      const entry = (id: EnvironmentId): ConnectionCatalogEntry => ({
        target: new BearerConnectionTarget({ environmentId: id, label: id, connectionId: id }),
        profile: Option.none(),
        enabled: !(failure === "disabled" && id === source),
      });
      const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
      for (const id of [source, backup]) {
        supervisors.set(id, {
          target: entry(id).target,
          session: yield* SubscriptionRef.make(
            id === source && failure === "offline"
              ? Option.none()
              : Option.some({
                  client: {
                    [WS_METHODS.selfHostedRelayConnect]: (input: {
                      environmentId: EnvironmentId;
                      proof: string;
                    }) =>
                      Effect.gen(function* () {
                        expect(input.environmentId).toBe(target);
                        grants.push({ via: id, proof: input.proof });
                        if (id === source && failure === "unsupported")
                          return yield* new RpcClientError.RpcClientError({
                            reason: new RpcClientError.RpcClientDefect({
                              message: "Unknown request tag: selfHostedRelay.connect",
                              cause: null,
                            }),
                          });
                        if (
                          failure === "all" ||
                          (id === source &&
                            (failure === "unavailable" ||
                              failure === "pairing" ||
                              failure === "permissions"))
                        )
                          return yield* new SelfHostedRelayOperationError({
                            operation:
                              failure === "pairing" || failure === "permissions"
                                ? failure
                                : "unavailable",
                          });
                        return yield* Effect.succeed({
                          environment: candidate,
                          relayUrl: candidate.relayUrl,
                          credential: "one-use-key-bound-grant",
                        });
                      }),
                  },
                } as unknown as RpcSession),
          ),
        } as EnvironmentSupervisor["Service"]);
      }
      const local = EnvironmentId.make("actual-client-host");
      const catalogEntries = new Map<EnvironmentId, ConnectionCatalogEntry>([
        [
          local,
          {
            target: new PrimaryConnectionTarget({
              environmentId: local,
              label: "M4 MacBook Pro",
              httpBaseUrl: "http://127.0.0.1:3773",
              wsBaseUrl: "ws://127.0.0.1:3773",
            }),
            profile: Option.none(),
            enabled: true,
          },
        ],
        [source, entry(source)],
        [backup, entry(backup)],
      ]);
      const entries =
        yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          catalogEntries,
        );
      const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
      let proofs = 0;
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(ClientPresentation, {
            metadata: {
              surface: failure === "web" || failure === "mobile" ? failure : "desktop",
              label: "T3 Code Desktop",
              deviceType: "desktop",
            },
          }),
          Layer.mock(EnvironmentRegistry)({
            entries,
            networkStatus,
            run: (id, effect) =>
              effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisors.get(id)!)),
          }),
          Layer.mock(ConnectionOnboarding)({
            registerPairing: (input) =>
              Effect.suspend(() => {
                registrations.push(input);
                return failure === "onboarding"
                  ? Effect.fail(
                      new ConnectionBlockedError({
                        reason: "authentication",
                        detail: "exchange failed",
                      }),
                    )
                  : Effect.succeed(target);
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
                return `device-proof-${++proofs}`;
              }),
          }),
        ),
      );
      const atoms = createSelfHostedRelayAtoms({
        runtime,
        catalog: Atom.make({ entries: catalogEntries }),
      });
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      for (const id of [source, backup]) {
        const permitted = id === source ? allowed : failure !== "no-permission";
        registry.set(
          sessions(id),
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: permitted ? [AuthAccessWriteScope] : [],
            permissions: permitted ? [AuthAccessWriteScope] : [],
          }),
        );
      }
      expect(registry.get(atoms.connect.permissionAtom(candidate))).toBe(attempts.length > 0);
      const result = yield* atoms.connect.run(registry, candidate).pipe(Effect.result);
      expect(result._tag).toBe(success ? "Success" : "Failure");
      expect(grants.map((grant) => grant.via)).toEqual(attempts);
      expect(grants.map((grant) => grant.proof)).toEqual(
        attempts.map((_, index) => `device-proof-${index + (failure === "offline" ? 2 : 1)}`),
      );
      expect(registrations).toHaveLength(success || failure === "onboarding" ? 1 : 0);
      if (registrations[0]) {
        expect(registrations[0]).toMatchObject({
          expectedEnvironmentId: target,
          ...(failure === "web" || failure === "mobile" ? {} : { clientLabel: "M4 MacBook Pro" }),
          requireDpop: true,
        });
        if (failure === "web" || failure === "mobile")
          expect(registrations[0].clientLabel).toBeUndefined();
        expect(parseRelayPairingUrl(registrations[0].pairingUrl!)).toMatchObject({
          route: candidate.route,
          peerId: candidate.peerId,
          token: "one-use-key-bound-grant",
        });
      }
    }).pipe(Effect.scoped),
);
