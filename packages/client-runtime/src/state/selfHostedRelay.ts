import { msg } from "gt-i18n";
import { translatableDetail } from "../errors/translatable.ts";
import {
  AuthAccessWriteScope,
  AuthRelayReadScope,
  SelfHostedRelayOperationError,
  SELF_HOSTED_RELAY_CONNECT_PATH,
  type EnvironmentId,
  type SelfHostedRelayApproval,
  sessionGrantsScope,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { buildRelayPairingUrl } from "@t3tools/relay-transport";
import { relayPublicBaseUrl, virtualRelayOrigin } from "@t3tools/relay-transport/protocol";
import { ConnectionOnboarding } from "../connection/onboarding.ts";
import { ConnectionBlockedError } from "../connection/model.ts";
import { ClientPresentation } from "../platform/capabilities.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import * as Option from "effect/Option";
import { EnvironmentNotRegisteredError, type EnvironmentRegistry } from "../connection/registry.ts";
import {
  EnvironmentRpcUnavailableError,
  isRpcClientError,
  scopeRequiredError,
} from "../rpc/client.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { connectionRoutes } from "../connection/routes.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";
import {
  createRuntimeCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface SelfHostedRelayCandidate {
  readonly environmentId: EnvironmentId;
  readonly viaEnvironmentIds: readonly EnvironmentId[];
  readonly label: string;
  readonly relayUrl: string;
  readonly route: string;
  readonly peerId: string;
}

const isRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);
const isUnregistered = Schema.is(EnvironmentNotRegisteredError);
const isRelayOperationError = Schema.is(SelfHostedRelayOperationError);

const canTryAnotherSource = (error: unknown) =>
  isRpcUnavailable(error) ||
  isUnregistered(error) ||
  isRpcClientError(error) ||
  (isRelayOperationError(error) && error.operation === "unavailable");

export function createSelfHostedRelayAtoms<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>;
  readonly catalog: Atom.Atom<{
    readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  }>;
}) {
  const status = createEnvironmentRpcSubscriptionAtomFamily(input.runtime, {
    label: "self-hosted-relay:status",
    tag: WS_METHODS.selfHostedRelaySubscribe,
    idleTtlMs: 0,
  });
  const sessions = createEnvironmentSessionAtoms(input.runtime);
  const linkUrls = Atom.make((get) => {
    const urls = new Map<EnvironmentId, string>();
    for (const [environmentId, entry] of get(input.catalog).entries) {
      if (!entry.enabled) continue;
      const session = get(sessions.sessionStateAtom(environmentId));
      if (!AsyncResult.isSuccess(session) || !sessionGrantsScope(session.value, AuthRelayReadScope))
        continue;
      const result = get(status({ environmentId, input: {} }));
      if (
        AsyncResult.isSuccess(result) &&
        result.value.enabled &&
        result.value.hasRegistrationToken &&
        result.value.relayUrl !== ""
      ) {
        urls.set(environmentId, relayPublicBaseUrl(result.value.relayUrl, environmentId));
      }
    }
    return urls;
  }).pipe(Atom.withLabel("self-hosted-relay:link-urls"));
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
  const update = createEnvironmentRpcCommand(input.runtime, {
    label: "self-hosted-relay:update",
    tag: WS_METHODS.selfHostedRelayUpdate,
  });
  const approval = Atom.family((_id: EnvironmentId) =>
    Atom.make<SelfHostedRelayApproval | null>(null).pipe(Atom.keepAlive),
  );
  const cancellations = new Map<EnvironmentId, Deferred.Deferred<void>>();
  const cancelConnect = createRuntimeCommand(input.runtime, {
    label: "self-hosted-relay:cancel-connect",
    execute: Effect.fn("selfHostedRelay.cancelConnect")(function* (environmentId: EnvironmentId) {
      const cancellation = cancellations.get(environmentId);
      if (cancellation) yield* Deferred.succeed(cancellation, undefined);
    }),
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
      const entries = registry.get(input.catalog).entries;
      const presentation = yield* Effect.serviceOption(ClientPresentation);
      const local =
        Option.isSome(presentation) && presentation.value.metadata.surface === "desktop"
          ? [...entries.values()].find((entry) => entry.target._tag === "PrimaryConnectionTarget")
          : undefined;
      const sources = candidate.viaEnvironmentIds.filter(
        (id) => entries.get(id)?.enabled && registry.get(grant.permissionAtom(id)),
      );
      if (sources.length === 0) return yield* scopeRequiredError(AuthAccessWriteScope);
      for (const [index, environmentId] of sources.entries()) {
        const proof = yield* signer.value.createProof({
          method: "POST",
          url: virtualRelayOrigin(candidate.route) + SELF_HOSTED_RELAY_CONNECT_PATH,
        });
        const issued = yield* grant
          .run(registry, {
            environmentId,
            input: { environmentId: candidate.environmentId, proof },
          })
          .pipe(
            Effect.catchIf(
              (error) => index < sources.length - 1 && canTryAnotherSource(error),
              () => Effect.undefined,
            ),
          );
        if (issued === undefined) continue;
        const cancellation = yield* Deferred.make<void>();
        cancellations.set(candidate.environmentId, cancellation);
        registry.set(approval(candidate.environmentId), issued.approval ?? null);
        return yield* onboarding.value
          .registerPairing({
            pairingUrl: buildRelayPairingUrl(
              { ...issued.environment, relayUrl: issued.relayUrl },
              issued.credential,
            ),
            ...(local ? { clientLabel: local.target.label } : {}),
            expectedEnvironmentId: candidate.environmentId,
            requireDpop: true,
            ...(issued.approval ? { approval: issued.approval } : {}),
          })
          .pipe(
            Effect.raceFirst(Deferred.await(cancellation).pipe(Effect.andThen(Effect.interrupt))),
            Effect.ensuring(
              Effect.sync(() => {
                cancellations.delete(candidate.environmentId);
                registry.set(approval(candidate.environmentId), null);
              }),
            ),
          );
      }
      return yield* scopeRequiredError(AuthAccessWriteScope);
    }),
  });
  const connect = {
    ...connectCommand,
    permissionAtom: Atom.family((candidate: SelfHostedRelayCandidate) =>
      Atom.make((get) => {
        const entries = get(input.catalog).entries;
        return candidate.viaEnvironmentIds.some(
          (id) => entries.get(id)?.enabled && get(grant.permissionAtom(id)),
        );
      }),
    ),
  };
  const candidates = Atom.make((get) => {
    const entries = get(input.catalog).entries;
    const found = new Map<EnvironmentId, SelfHostedRelayCandidate>();
    const sources = [...entries].sort(
      ([, left], [, right]) =>
        Number(right.target._tag === "PrimaryConnectionTarget") -
        Number(left.target._tag === "PrimaryConnectionTarget"),
    );
    for (const [environmentId, entry] of sources) {
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
        const previous = found.get(id);
        if (previous === undefined)
          found.set(id, {
            ...environment,
            environmentId: id,
            relayUrl: result.value.relayUrl,
            viaEnvironmentIds: [environmentId],
          });
        else if (
          previous.relayUrl === result.value.relayUrl &&
          previous.route === environment.route &&
          previous.peerId === environment.peerId
        ) {
          found.set(id, {
            ...previous,
            viaEnvironmentIds: [...previous.viaEnvironmentIds, environmentId],
          });
        }
      }
    }
    return [...found.values()];
  }).pipe(Atom.withLabel("self-hosted-relay:discovered-environments"));
  return {
    status,
    linkUrls,
    directory,
    mcpToken,
    candidates,
    connect,
    update,
    approval,
    cancelConnect,
  };
}
