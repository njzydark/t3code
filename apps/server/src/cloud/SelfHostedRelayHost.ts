import {
  AuthStandardClientScopes,
  SelfHostedRelayOperationError,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type SelfHostedRelayPairResult,
  type SelfHostedRelayStatus,
  type SelfHostedRelayUpdate,
} from "@t3tools/contracts";
import { validateRelayAddress } from "@t3tools/relay-transport/protocol";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import * as SelfHostedRelay from "./SelfHostedRelay.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { allowsRemoteClients } from "../policy/managedLimits.ts";

const CONFIG_SECRET = "self-hosted-relay";
const StoredConfig = Schema.fromJsonString(
  Schema.Struct({
    relayUrl: Schema.String,
    registrationToken: Schema.String,
    enabled: Schema.Boolean,
  }),
);
type StoredConfig = typeof StoredConfig.Type;
const encodeStoredConfig = Schema.encodeEffect(StoredConfig);
const decodeStoredConfig = Schema.decodeEffect(StoredConfig);
const emptyStatus: SelfHostedRelayStatus = {
  relayUrl: "",
  enabled: false,
  hasRegistrationToken: false,
  phase: "disabled",
  error: null,
};

export class SelfHostedRelayHost extends Context.Service<
  SelfHostedRelayHost,
  {
    readonly changes: Stream.Stream<SelfHostedRelayStatus>;
    readonly update: (
      input: SelfHostedRelayUpdate,
    ) => Effect.Effect<SelfHostedRelayStatus, SelfHostedRelayOperationError>;
    readonly forget: Effect.Effect<SelfHostedRelayStatus, SelfHostedRelayOperationError>;
    readonly pair: (
      scopes: ReadonlyArray<AuthEnvironmentScope>,
      input?: AuthCreatePairingCredentialInput,
    ) => Effect.Effect<SelfHostedRelayPairResult, SelfHostedRelayOperationError>;
  }
>()("t3/cloud/SelfHostedRelayHost") {}

const make = Effect.gen(function* () {
  const relay = yield* SelfHostedRelay.SelfHostedRelay;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const config = yield* ServerConfig.ServerConfig;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const server = yield* HttpServer.HttpServer;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const activation = (yield* ServerActivation) ?? Effect.void;
  const lock = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make(emptyStatus);
  const identityFile = path.join(config.baseDir, "relay", "identity.json");
  let saved: StoredConfig | undefined;
  let connector: Fiber.Fiber<void, never> | undefined;

  const stop = Effect.fn("SelfHostedRelayHost.stop")(function* () {
    if (connector) yield* Fiber.interrupt(connector);
    connector = undefined;
  });
  const start = Effect.fn("SelfHostedRelayHost.start")(function* (value: StoredConfig) {
    yield* stop();
    yield* SubscriptionRef.set(state, {
      relayUrl: value.relayUrl,
      enabled: value.enabled,
      hasRegistrationToken: true,
      phase: value.enabled ? "connecting" : "disabled",
      error: null,
    });
    if (!value.enabled) return;
    if (!allowsRemoteClients(policy)) {
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        phase: "error" as const,
        error: new SelfHostedRelayOperationError({ operation: "policy" }).message,
      }));
      return;
    }
    const address = server.address;
    if (typeof address === "string" || !("port" in address)) {
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        phase: "error" as const,
        error: "Self-hosted relay requires a TCP server listener.",
      }));
      return;
    }
    connector = yield* activation.pipe(
      Effect.andThen(
        relay.run({
          relayUrl: value.relayUrl,
          registrationToken: value.registrationToken,
          identityFile,
          target: `http://${loopbackUrlHostForAddress(address)}:${address.port}`,
          onStatus: (phase) =>
            SubscriptionRef.update(state, (current) => ({
              ...current,
              phase,
              error:
                phase === "reconnecting"
                  ? "Connection lost or registration rejected. Retrying automatically; check the URL and token."
                  : null,
            })),
        }),
      ),
      Effect.catch((error) =>
        SubscriptionRef.update(state, (current) => ({
          ...current,
          phase: "error" as const,
          error: error.message,
        })),
      ),
      Effect.forkIn(scope),
    );
  });

  const update = Effect.fn("SelfHostedRelayHost.update")(function* (input: SelfHostedRelayUpdate) {
    if (input.enabled && !allowsRemoteClients(policy))
      return yield* new SelfHostedRelayOperationError({ operation: "policy" });
    const value = yield* Effect.try({
      try: () => {
        const registrationToken = input.registrationToken ?? saved?.registrationToken ?? "";
        const address = validateRelayAddress({
          relayUrl: input.relayUrl.trim(),
          route: "0".repeat(32),
          peerId: "0".repeat(32),
        });
        if (registrationToken.length < 32 || registrationToken.length > 1024)
          throw new Error("Invalid token length.");
        return { relayUrl: address.relayUrl, registrationToken, enabled: input.enabled };
      },
      catch: () => new SelfHostedRelayOperationError({ operation: "configuration" }),
    });
    const encoded = yield* encodeStoredConfig(value).pipe(
      Effect.mapError(() => new SelfHostedRelayOperationError({ operation: "storage" })),
    );
    yield* secrets
      .set(CONFIG_SECRET, new TextEncoder().encode(encoded))
      .pipe(Effect.mapError(() => new SelfHostedRelayOperationError({ operation: "storage" })));
    saved = value;
    yield* start(value);
    return yield* SubscriptionRef.get(state);
  }, lock.withPermit);

  const forget = Effect.gen(function* () {
    yield* secrets
      .remove(CONFIG_SECRET)
      .pipe(Effect.mapError(() => new SelfHostedRelayOperationError({ operation: "storage" })));
    yield* stop();
    saved = undefined;
    yield* SubscriptionRef.set(state, emptyStatus);
    return emptyStatus;
  }).pipe(lock.withPermit);

  const pair = Effect.fn("SelfHostedRelayHost.pair")(function* (
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    input?: AuthCreatePairingCredentialInput,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (!saved || current.phase !== "connected") {
      return yield* new SelfHostedRelayOperationError({ operation: "unavailable" });
    }
    // Pairing can delegate only the caller's existing grants, never elevate them.
    const delegated =
      input?.scopes ?? AuthStandardClientScopes.filter((permission) => scopes.includes(permission));
    if (
      delegated.length === 0 ||
      new Set(delegated).size !== delegated.length ||
      !delegated.every((permission) => scopes.includes(permission))
    )
      return yield* new SelfHostedRelayOperationError({ operation: "permissions" });
    const issued = yield* auth
      .createPairingLink({
        label: input?.label ?? "Self-hosted relay",
        ttl: Duration.minutes(10),
        scopes: delegated,
      })
      .pipe(Effect.mapError(() => new SelfHostedRelayOperationError({ operation: "pairing" })));
    const url = yield* relay
      .pairingUrl({ relayUrl: saved.relayUrl, identityFile, credential: issued.credential })
      .pipe(
        Effect.tapError(() => auth.revokePairingLink(issued.id).pipe(Effect.ignore)),
        Effect.mapError(() => new SelfHostedRelayOperationError({ operation: "pairing" })),
      );
    return {
      url,
      id: issued.id,
      credential: issued.credential,
      expiresAt: issued.expiresAt,
      ...(issued.label ? { label: issued.label } : {}),
    };
  }, lock.withPermit);

  yield* secrets.get(CONFIG_SECRET).pipe(
    Effect.flatMap((bytes) =>
      Option.isNone(bytes)
        ? Effect.void
        : decodeStoredConfig(new TextDecoder().decode(bytes.value)).pipe(
            Effect.flatMap((value) => {
              saved = value;
              return start(value);
            }),
          ),
    ),
    Effect.catch(() =>
      SubscriptionRef.set(state, {
        ...emptyStatus,
        phase: "error" as const,
        error: "Could not load relay configuration. Save it again or clear it.",
      }),
    ),
  );
  return SelfHostedRelayHost.of({ changes: SubscriptionRef.changes(state), update, forget, pair });
});

export const layer = Layer.effect(SelfHostedRelayHost, make);
