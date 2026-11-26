import { NodeServices, NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Analytics from "./AnalyticsService.ts";
import { allowedBy } from "../feedback/FeedbackStore.ts";
import * as OtlpEndpointCheck from "../observability/OtlpEndpointCheck.ts";

it.effect(
  "never queues usage or feedback, sends HTTP, or creates an analytics identity in the fork",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 202 })),
        );
      });
      const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-telemetry-" });
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const analytics = yield* Analytics.AnalyticsService;
        expect(yield* analytics.record("provider.request.completed", { tokens: 100 })).toBe(false);
        expect(
          yield* analytics.record("agent.feedback", { trace: "private" }, { anonymous: true }),
        ).toBe(false);
        yield* analytics.recordOwners([{ source: "device", ownerId: "test-device" }], "client");
        yield* analytics.flush;
        const endpointCheck = yield* OtlpEndpointCheck.OtlpEndpointCheck;
        expect(
          yield* endpointCheck.check({
            signal: "traces",
            url: "https://collector.example.test/v1/traces",
          }),
        ).toEqual({ _tag: "Unreachable", timedOut: false });
        expect(yield* fs.exists(config.anonymousIdPath)).toBe(false);
        expect((yield* allowedBy("auto", true, "mcp").pipe(Effect.flip))._tag).toBe(
          "FeedbackOffError",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Analytics.layer, OtlpEndpointCheck.layer).pipe(
            Layer.provideMerge(configLayer),
            Layer.provide(ManagedPolicy.layerTest()),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnvRecord({
                  T3CODE_TELEMETRY_ENABLED: "true",
                  DO_NOT_TRACK: "0",
                }),
              ),
            ),
          ),
        ),
      );
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
