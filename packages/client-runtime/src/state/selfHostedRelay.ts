import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { connectionRoutes } from "../connection/routes.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
  const candidates = Atom.make((get) => {
    const entries = get(input.catalog).entries;
    const found = new Map<
      EnvironmentId,
      {
        environmentId: EnvironmentId;
        label: string;
        relayUrl: string;
        route: string;
        peerId: string;
      }
    >();
    for (const [environmentId, entry] of entries) {
      if (
        !entry.enabled ||
        !connectionRoutes(entry).some((route) => {
          const profile = Option.getOrNull(route.profile);
          return (
            profile?._tag === "BearerConnectionProfile" && profile.selfHostedRelay !== undefined
          );
        })
      )
        continue;
      const result = get(directory({ environmentId, input: {} }));
      if (!AsyncResult.isSuccess(result)) continue;
      for (const environment of result.value.environments) {
        const id = environment.environmentId;
        if (entries.has(id)) continue;
        found.set(id, { ...environment, environmentId: id, relayUrl: result.value.relayUrl });
      }
    }
    return [...found.values()];
  }).pipe(Atom.withLabel("self-hosted-relay:discovered-environments"));
  return { directory, mcpToken, candidates };
}
