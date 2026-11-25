import { EnvironmentId, type SelfHostedRelayDirectory, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { BearerConnectionTarget, PrimaryConnectionTarget } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSelfHostedRelayAtoms } from "./selfHostedRelay.ts";

it.effect.each(["primary", "relay"] as const)(
  "discovers online peers through a $0 environment and hides peers once added",
  (mode) =>
    Effect.gen(function* () {
      const local = EnvironmentId.make("mac-local");
      const remote = EnvironmentId.make("mac-remote");
      const relayUrl = "https://relay.example.test";
      const address = { relayUrl, route: "a".repeat(32), peerId: "fixture-peer" };
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
