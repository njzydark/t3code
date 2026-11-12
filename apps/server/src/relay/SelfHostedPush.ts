import {
  AuthOrchestrationReadScope,
  SelfHostedPushError,
  SelfHostedPushResponse,
  isListedThreadLineage,
  type AuthSessionId,
  type SelfHostedPushRequest,
  type ThreadId,
} from "@t3tools/contracts";
import { validateRelayAddress } from "@t3tools/relay-transport/protocol";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SessionStore from "../auth/SessionStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  SELF_HOSTED_RELAY_CONFIG_SECRET,
  StoredSelfHostedRelayConfig,
} from "../cloud/selfHostedRelayConfig.ts";
import { readAgentActivityPublishingActive } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  makeAgentAwarenessPublishWorker,
  resolveAgentAwarenessRelayActiveThreadIds,
  resolveAgentAwarenessRelayPublishSnapshot,
  shouldPublishAgentAwarenessEvent,
} from "./AgentAwarenessRelay.ts";

export class SelfHostedPush extends Context.Service<
  SelfHostedPush,
  {
    readonly request: (
      sessionId: AuthSessionId,
      input: SelfHostedPushRequest,
    ) => Effect.Effect<SelfHostedPushResponse, SelfHostedPushError>;
  }
>()("t3/relay/SelfHostedPush") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const client = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const startedAt = yield* Clock.currentTimeMillis;
  const decodeConfig = Schema.decodeUnknownEffect(StoredSelfHostedRelayConfig);
  const decodeResponse = Schema.decodeUnknownEffect(SelfHostedPushResponse);
  const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const isPushError = Schema.is(SelfHostedPushError);
  const sendLock = yield* Semaphore.make(1);
  let previousConfig: typeof StoredSelfHostedRelayConfig.Type | null = null;
  const readConfig = Effect.gen(function* () {
    const stored = yield* secrets.get(SELF_HOSTED_RELAY_CONFIG_SECRET);
    if (Option.isNone(stored)) return null;
    const config = yield* decodeConfig(new TextDecoder().decode(stored.value));
    if (!config.enabled) return null;
    // An environment already publishing through Connect keeps its existing notification backend.
    if (yield* readAgentActivityPublishingActive(secrets)) return null;
    yield* Effect.try({
      try: () =>
        validateRelayAddress({
          relayUrl: config.relayUrl,
          route: "0".repeat(32),
          peerId: "0".repeat(32),
        }),
      catch: (cause) => new SelfHostedPushError({ operation: "configuration", cause }),
    });
    return config;
  }).pipe(
    Effect.mapError((cause) => new SelfHostedPushError({ operation: "configuration", cause })),
  );
  let cachedConfig: string | null = null;
  let available = false;
  const published = new Map<ThreadId, string>();
  const confirmAfter = new Map<ThreadId, number>();
  const heldCompletions = new Set<ThreadId>();
  let confirmLater: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const sendTo = Effect.fn("SelfHostedPush.sendTo")(
    function* (
      config: typeof StoredSelfHostedRelayConfig.Type,
      input: object,
      activeSessionIds: ReadonlyArray<AuthSessionId>,
    ) {
      const response = yield* HttpClientRequest.post(
        new URL("/v1/push", config.relayUrl).href,
      ).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${config.registrationToken}`),
        HttpClientRequest.bodyJson({
          ...input,
          environmentId: yield* environment.getEnvironmentId,
          activeSessionIds,
        }),
        Effect.flatMap(client.execute),
        Effect.timeout("10 seconds"),
      );
      if (response.status === 404) return { enabled: false };
      if (response.status < 200 || response.status >= 300) {
        return yield* new SelfHostedPushError({
          operation: "request",
          status: response.status,
          cause: undefined,
        });
      }
      return yield* response.json.pipe(Effect.flatMap(decodeResponse));
    },
    Effect.mapError((cause) =>
      isPushError(cause) ? cause : new SelfHostedPushError({ operation: "request", cause }),
    ),
  );
  const send = Effect.fn("SelfHostedPush.send")(function* (input: object) {
    const config = yield* readConfig;
    if (
      previousConfig &&
      (previousConfig.relayUrl !== config?.relayUrl ||
        previousConfig.registrationToken !== config?.registrationToken)
    ) {
      yield* sendTo(previousConfig, { operation: "capabilities" }, []).pipe(
        Effect.catch(() =>
          Effect.logWarning(
            "Could not detach the previous self-hosted push backend; revoke its registrations if it remains offline.",
          ),
        ),
      );
    }
    previousConfig = config;
    if (!config) return { enabled: false };
    const activeSessions = yield* auth.listSessions();
    return yield* sendTo(
      config,
      input,
      activeSessions
        .filter((session) => session.scopes.includes(AuthOrchestrationReadScope))
        .map((session) => session.sessionId),
    );
  }, sendLock.withPermit);

  const publish = Effect.fn("SelfHostedPush.publish")(
    function* (threadId: ThreadId) {
      if (!available) return;
      const thread = (yield* threads.getAgentAwarenessSnapshot(threadId)).threads[0];
      const visible = thread && thread.archivedAt === null && isListedThreadLineage(thread.lineage);
      const project = visible ? yield* projects.getById(thread.projectId) : Option.none();
      const state = resolveAgentAwarenessRelayPublishSnapshot({
        environmentId: yield* environment.getEnvironmentId,
        thread: visible ? Option.some(thread) : Option.none(),
        project,
        pendingSubagentRequest: null,
      }).state;
      const identity = state ? yield* encodeIdentity({ ...state, updatedAt: "" }) : "null";
      if (published.get(threadId) === identity) return;
      if (state === null && !published.has(threadId) && !heldCompletions.has(threadId)) return;
      if (state === null || state.phase === "completed") {
        if (state?.phase === "completed") heldCompletions.add(threadId);
        const now = yield* Clock.currentTimeMillis;
        const deadline = confirmAfter.get(threadId);
        if (deadline === undefined) {
          confirmAfter.set(threadId, now + 5_000);
          yield* confirmLater(threadId);
          return;
        }
        if (now < deadline) return;
        if (
          state === null &&
          heldCompletions.has(threadId) &&
          visible &&
          thread.settledOverride === "settled"
        ) {
          const completion = resolveAgentAwarenessRelayPublishSnapshot({
            environmentId: yield* environment.getEnvironmentId,
            thread: Option.some({ ...thread, settledOverride: null }),
            project,
            pendingSubagentRequest: null,
          }).state;
          if (completion?.phase === "completed") {
            const result = yield* send({ operation: "publish", threadId, state: completion });
            if (!result.ok) return;
            published.set(threadId, yield* encodeIdentity({ ...completion, updatedAt: "" }));
            heldCompletions.delete(threadId);
            confirmAfter.set(threadId, now + 5_000);
            yield* confirmLater(threadId);
            return;
          }
        }
      }
      confirmAfter.delete(threadId);
      heldCompletions.delete(threadId);
      const result = yield* send({ operation: "publish", threadId, state });
      if (!result.ok) return;
      published.set(threadId, identity);
    },
    Effect.catch(() =>
      Effect.logWarning("Self-hosted push publication failed; reconciliation will retry."),
    ),
  );
  const worker = yield* makeAgentAwarenessPublishWorker(publish);
  confirmLater = (threadId) =>
    Effect.sleep("5 seconds").pipe(
      Effect.andThen(worker.enqueue(threadId)),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  const enqueueActive = Effect.gen(function* () {
    const snapshot = yield* threads.getAgentAwarenessSnapshot();
    if (snapshot.threads.length === 0) return;
    const projectSnapshot = yield* projects.snapshot;
    const ids = resolveAgentAwarenessRelayActiveThreadIds({
      environmentId: yield* environment.getEnvironmentId,
      startedAt,
      projects: projectSnapshot.projects,
      threads: snapshot.threads,
    });
    for (const id of ids) {
      published.delete(id);
      yield* worker.enqueue(id);
    }
    yield* worker.drain;
  });

  const reconcile = Effect.gen(function* () {
    const config = yield* readConfig;
    const identity = config ? `${config.relayUrl}|${config.registrationToken}` : null;
    if (cachedConfig !== identity) {
      cachedConfig = identity;
      published.clear();
      available = false;
    }
    const capabilities = yield* send({ operation: "capabilities" });
    available = capabilities.enabled === true;
    if (!available) return;
    yield* enqueueActive;
  }).pipe(Effect.catch(() => Effect.logWarning("Self-hosted push reconciliation failed.")));

  yield* forkParked(reconcile.pipe(Effect.repeat(Schedule.spaced("60 seconds"))));
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      available && shouldPublishAgentAwarenessEvent(event)
        ? worker.enqueue(event.threadId)
        : Effect.void,
    ),
  );
  yield* forkParked(
    Stream.runForEach(sessions.streamChanges, (change) =>
      change.type === "clientRemoved"
        ? send({ operation: "capabilities" }).pipe(Effect.ignore)
        : Effect.void,
    ),
  );

  return SelfHostedPush.of({
    request: Effect.fn("SelfHostedPush.request")(
      function* (sessionId, input) {
        const result = yield* send({ ...input, sessionId });
        if (input.operation === "register" && result.ok) {
          available = true;
          // Registration on a running environment must not wait for another agent event.
          yield* enqueueActive;
        }
        return result;
      },
      Effect.mapError((cause) =>
        isPushError(cause) ? cause : new SelfHostedPushError({ operation: "registration", cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(SelfHostedPush, make);
