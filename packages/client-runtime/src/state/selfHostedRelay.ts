import { msg } from "gt-i18n";
import { translatableDetail } from "../errors/translatable.ts";
import { SELF_HOSTED_RELAY_CONNECT_PATH, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { buildRelayPairingUrl } from "@t3tools/relay-transport";
import { virtualRelayOrigin } from "@t3tools/relay-transport/protocol";
import { ConnectionOnboarding } from "../connection/onboarding.ts";
import { ConnectionBlockedError } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import * as Option from "effect/Option";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { connectionRoutes } from "../connection/routes.ts";
import {
  createRuntimeCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface SelfHostedRelayCandidate {
  readonly environmentId: EnvironmentId;
  readonly viaEnvironmentId: EnvironmentId;
  readonly label: string;
  readonly relayUrl: string;
  readonly route: string;
  readonly peerId: string;
}

export function createSelfHostedRelayAtoms<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>;
  readonly catalog: Atom.Atom<{
    readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  }>;
}) {
  const directory = createEnvironmentRpcSubscriptionAtomFamily(input.runtime, {
    label: "self-hosted-relay:directory",
    tag: WS_METHODS.selfHostedRelayDirectory,
    idleTtlMs: 0,
  });
  const mcpToken = createEnvironmentRpcCommand(input.runtime, {
    label: "self-hosted-relay:mcp-token",
    tag: WS_METHODS.selfHostedRelayMcpToken,
  });
  const grant = createEnvironmentRpcCommand(input.runtime, {
    label: "self-hosted-relay:connect-grant",
    tag: WS_METHODS.selfHostedRelayConnect,
  });
  const connectCommand = createRuntimeCommand(input.runtime, {
    label: "self-hosted-relay:connect",
    concurrency: {
      mode: "singleFlight",
      key: (candidate: SelfHostedRelayCandidate) => candidate.environmentId,
    },
    execute: Effect.fn("selfHostedRelay.connect")(function* (
      candidate: SelfHostedRelayCandidate,
      registry,
    ) {
      const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
      const onboarding = yield* Effect.serviceOption(ConnectionOnboarding);
      if (Option.isNone(signer) || Option.isNone(onboarding))
        return yield* new ConnectionBlockedError({
          reason: "unsupported",
          ...translatableDetail(
            msg("Update this client and the remote T3 Code before connecting."),
          ),
        });
      const proof = yield* signer.value.createProof({
        method: "POST",
        url: virtualRelayOrigin(candidate.route) + SELF_HOSTED_RELAY_CONNECT_PATH,
      });
      const issued = yield* grant.run(registry, {
        environmentId: candidate.viaEnvironmentId,
        input: { environmentId: candidate.environmentId, proof },
      });
      return yield* onboarding.value.registerPairing({
        pairingUrl: buildRelayPairingUrl(
          { ...issued.environment, relayUrl: issued.relayUrl },
          issued.credential,
        ),
        expectedEnvironmentId: candidate.environmentId,
        requireDpop: true,
      });
    }),
  });
  const connect = { ...connectCommand, permissionAtom: grant.permissionAtom };
  const candidates = Atom.make((get) => {
    const entries = get(input.catalog).entries;
    const found = new Map<EnvironmentId, SelfHostedRelayCandidate>();
    for (const [environmentId, entry] of entries) {
      if (
        !entry.enabled ||
        (entry.target._tag !== "PrimaryConnectionTarget" &&
          !connectionRoutes(entry).some((route) => {
            const profile = Option.getOrNull(route.profile);
            return (
              profile?._tag === "BearerConnectionProfile" && profile.selfHostedRelay !== undefined
            );
          }))
      )
        continue;
      const result = get(directory({ environmentId, input: {} }));
      if (!AsyncResult.isSuccess(result)) continue;
      for (const environment of result.value.environments) {
        const id = environment.environmentId;
        if (entries.has(id)) continue;
        if (!found.has(id))
          found.set(id, {
            ...environment,
            environmentId: id,
            relayUrl: result.value.relayUrl,
            viaEnvironmentId: environmentId,
          });
      }
    }
    return [...found.values()];
  }).pipe(Atom.withLabel("self-hosted-relay:discovered-environments"));
  return { directory, mcpToken, candidates, connect };
}
