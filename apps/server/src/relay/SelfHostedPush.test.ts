import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SelfHostedPush from "./SelfHostedPush.ts";
import { ServerActivation } from "../serverActivation.ts";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";

const sessionId = AuthSessionId.make("native-client");
const token = "registration-credential-".repeat(3);

const fixture = (
  enabled: boolean,
  pushEnabled = true,
  officialConnect = false,
  withThread = false,
) =>
  Effect.gen(function* () {
    const parked = yield* Deferred.make<void>();
    const completion = yield* Deferred.make<void>();
    const tombstone = yield* Deferred.make<void>();
    const project = {
      id: ProjectId.make("project"),
      title: "Project",
      workspaceRoot: "/test",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      deletedAt: null,
    } satisfies Project;
    let thread: AgentAwarenessThread | null = withThread
      ? {
          id: ThreadId.make("thread"),
          projectId: ProjectId.make("project"),
          title: "Thread",
          creationSource: "mobile",
          lineage: {
            rootThreadId: ThreadId.make("thread"),
            parentThreadId: null,
            relationshipToParent: null,
          },
          status: "running",
          activityRunStatus: null,
          pendingRuntimeRequest: null,
          pendingBackgroundTasks: [],
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          updatedAt: DateTime.makeUnsafe(1000),
          settledOverride: null,
          archivedAt: null,
          activeRunId: null,
          latestRunId: null,
          latestRunCompletedAt: null,
          hasActionableProposedPlan: false,
        }
      : null;
    const requests: Array<{
      url: string;
      authorization: string | undefined;
      payload: Record<string, unknown>;
    }> = [];
    const layer = SelfHostedPush.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ServerActivation, Deferred.await(parked)),
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: (name) =>
              Effect.succeed(
                name === "self-hosted-relay"
                  ? Option.some(
                      new TextEncoder().encode(
                        JSON.stringify({
                          relayUrl: "https://self.example.test",
                          registrationToken: token,
                          enabled,
                        }),
                      ),
                    )
                  : officialConnect &&
                      [
                        "cloud-relay-url",
                        "cloud-relay-environment-credential",
                        "cloud-publish-agent-activity",
                      ].includes(name)
                    ? Option.some(
                        new TextEncoder().encode(
                          name === "cloud-publish-agent-activity"
                            ? "true"
                            : "official-connect-configured",
                        ),
                      )
                    : Option.none(),
              ),
          }),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            listSessions: () =>
              Effect.succeed([
                {
                  sessionId,
                  subject: "test",
                  scopes: [AuthOrchestrationReadScope],
                  method: "bearer-access-token",
                  client: { deviceType: "mobile" },
                  issuedAt: DateTime.makeUnsafe(0),
                  expiresAt: DateTime.makeUnsafe(1000),
                  lastConnectedAt: null,
                  connected: true,
                  current: true,
                },
              ]),
          }),
          Layer.mock(SessionStore.SessionStore)({
            streamChanges: Stream.never,
            cookieName: "test",
            legacyCookieName: undefined,
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("self-environment")),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            streamDomainEvents: Stream.never,
            getAgentAwarenessSnapshot: () =>
              Effect.succeed({ snapshotSequence: 0, threads: thread ? [thread] : [] }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome(project),
            snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              const body = request.body;
              const payload =
                body._tag === "Uint8Array"
                  ? (JSON.parse(new TextDecoder().decode(body.body)) as Record<string, unknown>)
                  : {};
              requests.push({
                url: request.url,
                authorization: request.headers.authorization,
                payload,
              });
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify(
                      payload.operation === "capabilities"
                        ? { enabled: true, bundleId: "test.app", apsEnvironment: "sandbox" }
                        : { ok: true },
                    ),
                    { status: pushEnabled ? 200 : 404 },
                  ),
                ),
              ).pipe(
                Effect.tap(() =>
                  payload.operation !== "publish"
                    ? Effect.void
                    : payload.state === null
                      ? Deferred.succeed(tombstone, undefined)
                      : (payload.state as Record<string, unknown>).phase === "completed"
                        ? Deferred.succeed(completion, undefined)
                        : Effect.void,
                ),
              );
            }),
          ),
        ),
      ),
    );
    return {
      layer,
      requests,
      completion: Deferred.await(completion),
      tombstone: Deferred.await(tombstone),
      updateThread: (patch: Partial<AgentAwarenessThread>) => {
        if (thread) thread = { ...thread, ...patch };
      },
      enableConnect: () => {
        officialConnect = true;
      },
    };
  });

describe("optional self-hosted push adapter", () => {
  it.effect("delivers a held completion before the settled thread's tombstone", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true, true, false, true);
      yield* TestClock.setTime(0);
      yield* Effect.gen(function* () {
        const push = yield* SelfHostedPush.SelfHostedPush;
        const registration = {
          operation: "register" as const,
          registration: {
            deviceId: "device",
            label: "Device",
            platform: "ios" as const,
            iosMajorVersion: 18,
            preferences: {
              notificationsEnabled: true,
              liveActivitiesEnabled: true,
              notifyOnApproval: true,
              notifyOnInput: true,
              notifyOnCompletion: true,
              notifyOnFailure: true,
            },
          },
        };
        yield* push.request(sessionId, registration);
        f.updateThread({ status: "completed", latestRunCompletedAt: DateTime.makeUnsafe(1000) });
        yield* push.request(sessionId, registration);
        f.updateThread({ settledOverride: "settled" });
        yield* TestClock.adjust("5 seconds");
        yield* f.completion;
        yield* TestClock.adjust("5 seconds");
        yield* f.tombstone;
        const states = f.requests
          .filter((request) => request.payload.operation === "publish")
          .map((request) => request.payload.state);
        expect(states).toMatchObject([{ phase: "running" }, { phase: "completed" }, null]);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect("detaches existing self-hosted subscriptions when Connect takes over", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      yield* Effect.gen(function* () {
        const push = yield* SelfHostedPush.SelfHostedPush;
        yield* push.request(sessionId, { operation: "snapshot", deviceId: "device" });
        f.enableConnect();
        expect(yield* push.request(sessionId, { operation: "capabilities" })).toEqual({
          enabled: false,
        });
        expect(f.requests.at(-1)?.payload).toEqual({
          operation: "capabilities",
          environmentId: "self-environment",
          activeSessionIds: [],
        });
        expect(f.requests).toHaveLength(2);
      }).pipe(Effect.provide(f.layer));
    }),
  );
  it.effect(
    "leaves an environment's existing official Connect notification backend untouched",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true, true, true);
        yield* Effect.gen(function* () {
          const push = yield* SelfHostedPush.SelfHostedPush;
          expect(yield* push.request(sessionId, { operation: "capabilities" })).toEqual({
            enabled: false,
          });
          expect(f.requests).toEqual([]);
        }).pipe(Effect.provide(f.layer));
      }),
  );
  it.effect("does not contact any push backend when self-hosting is disabled", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      yield* Effect.gen(function* () {
        const push = yield* SelfHostedPush.SelfHostedPush;
        expect(yield* push.request(sessionId, { operation: "capabilities" })).toEqual({
          enabled: false,
        });
        expect(f.requests).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect(
    "uses only the self-hosted origin and host credential, binding the caller's session",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        yield* Effect.gen(function* () {
          const push = yield* SelfHostedPush.SelfHostedPush;
          yield* push.request(sessionId, { operation: "snapshot", deviceId: "device" });
          expect(f.requests).toEqual([
            {
              url: "https://self.example.test/v1/push",
              authorization: `Bearer ${token}`,
              payload: {
                operation: "snapshot",
                deviceId: "device",
                sessionId,
                environmentId: "self-environment",
                activeSessionIds: [sessionId],
              },
            },
          ]);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "treats older and push-disabled relays as unsupported without using official Connect",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true, false);
        yield* Effect.gen(function* () {
          const push = yield* SelfHostedPush.SelfHostedPush;
          expect(yield* push.request(sessionId, { operation: "capabilities" })).toEqual({
            enabled: false,
          });
          expect(f.requests).toHaveLength(1);
        }).pipe(Effect.provide(f.layer));
      }),
  );
});
