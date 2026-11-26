import * as DateTime from "effect/DateTime";
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  SELF_HOSTED_RELAY_CONNECT_PATH,
  SelfHostedRelayAuthorization,
  type SelfHostedRelayConnectInput,
  type SelfHostedRelayConnectResult,
  mcpClientScopes,
  SelfHostedRelayDirectory,
  type SelfHostedRelayMcpTokenInput,
  type SelfHostedRelayMcpTokenResult,
  SelfHostedRelayOperationError,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type SelfHostedRelayPairResult,
  type SelfHostedRelayStatus,
  type SelfHostedRelayUpdate,
} from "@t3tools/contracts";
import { relayPublicBaseUrl, validateRelayAddress } from "@t3tools/relay-transport/protocol";
import { createNodeRelayClient } from "@t3tools/relay-transport/node";
import * as Mac from "effect/crypto/Mac";
import * as Digest from "effect/crypto/Digest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { verifyRequestDpopProof } from "../auth/dpop.ts";
import { relayRequestVerificationCode } from "../auth/utils.ts";
import {
  SignedGroupGrant,
  signGroupGrant,
  verifyGroupGrant,
  encodeSignedGroupGrant,
} from "./selfHostedRelayGroupAuth.ts";
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
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";

import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import * as SelfHostedRelay from "./SelfHostedRelay.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { allowsRemoteClients } from "../policy/managedLimits.ts";
import {
  SELF_HOSTED_RELAY_CONFIG_SECRET as CONFIG_SECRET,
  StoredSelfHostedRelayConfig as StoredConfig,
} from "./selfHostedRelayConfig.ts";

type StoredConfig = typeof StoredConfig.Type;
const encodeStoredConfig = Schema.encodeEffect(StoredConfig);
const decodeStoredConfig = Schema.decodeEffect(StoredConfig);
const decodeDirectory = Schema.decodeUnknownEffect(SelfHostedRelayDirectory);
const decodeGroupCredential = Schema.decodeUnknownSync(
  Schema.toCodecJson(SelfHostedRelayAuthorization),
);
const standardScopes: ReadonlySet<AuthEnvironmentScope> = new Set(AuthStandardClientScopes);
const emptyStatus: SelfHostedRelayStatus = {
  relayUrl: "",
  enabled: false,
  autoApproveNewDevices: false,
  hasRegistrationToken: false,
  phase: "disabled",
  error: null,
};

export class SelfHostedRelayHost extends Context.Service<
  SelfHostedRelayHost,
  {
    readonly connect: (
      scopes: ReadonlyArray<AuthEnvironmentScope>,
      input: SelfHostedRelayConnectInput,
    ) => Effect.Effect<SelfHostedRelayConnectResult, SelfHostedRelayOperationError>;
    readonly authorize: (
      request: HttpServerRequest.HttpServerRequest,
      grant: SignedGroupGrant,
    ) => Effect.Effect<SelfHostedRelayAuthorization, SelfHostedRelayOperationError>;
    readonly changes: Stream.Stream<SelfHostedRelayStatus>;
    readonly directory: Stream.Stream<SelfHostedRelayDirectory>;
    readonly mcpToken: (
      scopes: ReadonlyArray<AuthEnvironmentScope>,
      input: SelfHostedRelayMcpTokenInput,
    ) => Effect.Effect<SelfHostedRelayMcpTokenResult, SelfHostedRelayOperationError>;
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
  const mac = yield* Mac.Mac;
  const digest = yield* Digest.Digest;
  const relay = yield* SelfHostedRelay.SelfHostedRelay;
  const http = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
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
      autoApproveNewDevices: value.autoApproveNewDevices ?? false,
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
        return {
          relayUrl: address.relayUrl,
          registrationToken,
          enabled: input.enabled,
          autoApproveNewDevices:
            input.autoApproveNewDevices ?? saved?.autoApproveNewDevices ?? false,
        };
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

  const mcpToken = Effect.fn("SelfHostedRelayHost.mcpToken")(function* (
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    input: SelfHostedRelayMcpTokenInput,
  ) {
    if (!saved?.enabled)
      return yield* new SelfHostedRelayOperationError({ operation: "unavailable" });
    if (!mcpClientScopes(input.access).every((scope) => scopes.includes(scope)))
      return yield* new SelfHostedRelayOperationError({ operation: "permissions" });
    const issued = yield* auth
      .issueMcpClientSession({
        label: input.label,
        access: input.access,
        peerLink: false,
        client: { deviceType: "bot" },
      })
      .pipe(Effect.mapError(() => new SelfHostedRelayOperationError({ operation: "storage" })));
    return {
      url: `${relayPublicBaseUrl(saved.relayUrl, yield* environment.getEnvironmentId)}/mcp`,
      token: issued.token,
      expiresAt: DateTime.toUtc(issued.expiresAt),
    };
  });
  const readDirectory = Effect.gen(function* () {
    const config = saved;
    if (!config?.enabled) return { relayUrl: "", environments: [] };
    const response = yield* HttpClientRequest.get(
      new URL("/v1/environments", config.relayUrl).href,
    ).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${config.registrationToken}`),
      http.execute,
      Effect.timeout("10 seconds"),
    );
    if (response.status !== 200) return { relayUrl: config.relayUrl, environments: [] };
    const body = yield* response.json;
    return yield* decodeDirectory({
      ...(typeof body === "object" && body !== null ? body : {}),
      relayUrl: config.relayUrl,
    });
  }).pipe(Effect.orElseSucceed(() => ({ relayUrl: saved?.relayUrl ?? "", environments: [] })));
  const connect = Effect.fn("SelfHostedRelayHost.connect")(function* (
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    input: SelfHostedRelayConnectInput,
  ) {
    const config = saved;
    if (!config?.enabled || !allowsRemoteClients(policy))
      return yield* new SelfHostedRelayOperationError({ operation: "unavailable" });
    if (!scopes.includes(AuthAccessWriteScope))
      return yield* new SelfHostedRelayOperationError({ operation: "permissions" });
    const delegated = AuthStandardClientScopes.filter((permission) => scopes.includes(permission));
    const directory = yield* readDirectory;
    const target = directory.environments.find(
      (entry) => entry.environmentId === input.environmentId,
    );
    if (!target || directory.relayUrl !== config.relayUrl)
      return yield* new SelfHostedRelayOperationError({ operation: "unavailable" });
    const grant = yield* signGroupGrant(config.registrationToken, {
      environmentId: target.environmentId,
      scopes: delegated,
      proof: input.proof,
    }).pipe(Effect.provideService(Mac.Mac, mac));
    const authorization = yield* Effect.acquireUseRelease(
      Effect.sync(createNodeRelayClient),
      (client) =>
        Effect.tryPromise({
          try: async (signal) => {
            const endpoint = client.register({ ...target, relayUrl: config.relayUrl });
            const response = await client.fetch(
              endpoint.httpBaseUrl + SELF_HOSTED_RELAY_CONNECT_PATH,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: encodeSignedGroupGrant(grant),
                signal,
              },
            );
            if (response.status !== 200) {
              await response.body?.cancel();
              throw new Error("Group authorization refused.");
            }
            return decodeGroupCredential(await response.json());
          },
          catch: () => new SelfHostedRelayOperationError({ operation: "pairing" }),
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(() => new SelfHostedRelayOperationError({ operation: "pairing" })),
        ),
      (client) => Effect.sync(() => client.dispose()),
    );
    return { environment: target, relayUrl: config.relayUrl, ...authorization };
  });

  const authorize = Effect.fn("SelfHostedRelayHost.authorize")(
    function* (request: HttpServerRequest.HttpServerRequest, signed: SignedGroupGrant) {
      const config = saved;
      if (!config?.enabled)
        return yield* new SelfHostedRelayOperationError({ operation: "unavailable" });
      const grant = yield* verifyGroupGrant(config.registrationToken, signed);
      if (
        grant.environmentId !== (yield* environment.getEnvironmentId) ||
        new Set(grant.scopes).size !== grant.scopes.length ||
        !grant.scopes.every((permission) => standardScopes.has(permission))
      )
        return yield* new SelfHostedRelayOperationError({ operation: "permissions" });
      // Consuming the client's proof persists replay protection across host restarts.
      const thumbprint = yield* verifyRequestDpopProof({ request, proof: grant.proof });
      const requiresApproval = config.autoApproveNewDevices !== true;
      const issued = yield* auth.createPairingLink({
        scopes: grant.scopes,
        authorizationSource: requiresApproval ? "relay-approved" : "relay-auto",
        ttl: requiresApproval ? Duration.minutes(10) : Duration.minutes(2),
        proofKeyThumbprint: thumbprint,
        ...(requiresApproval ? { requiresConnectApproval: true } : {}),
      });
      return {
        credential: issued.credential,
        ...(requiresApproval
          ? {
              approval: {
                verificationCode: relayRequestVerificationCode(issued.id, thumbprint),
                expiresAt: issued.expiresAt,
              },
            }
          : {}),
      };
    },
    Effect.provideService(Mac.Mac, mac),
    Effect.provideService(Digest.Digest, digest),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.mapError(() => new SelfHostedRelayOperationError({ operation: "pairing" })),
    lock.withPermit,
  );
  const directory = Stream.fromEffectSchedule(readDirectory, Schedule.spaced("30 seconds"));

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
  return SelfHostedRelayHost.of({
    directory,
    connect,
    authorize,
    mcpToken,
    changes: SubscriptionRef.changes(state),
    update,
    forget,
    pair,
  });
});

export const layer = Layer.effect(SelfHostedRelayHost, make);
