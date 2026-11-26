import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";
import { DEFAULT_SIGNAL_EXPORT } from "./observability.ts";
import * as OtelEnvironment from "./otelEnvironment.ts";
import * as RelayTracing from "./relayTracing.ts";

it.effect("refuses telemetry opt-ins and every configured OTLP endpoint in the fork", () =>
  Effect.gen(function* () {
    const env = {
      T3CODE_TELEMETRY_ENABLED: "true",
      T3CODE_OTEL_SDK_DISABLED: "false",
      OTEL_SDK_DISABLED: "false",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
    };
    expect(OtelEnvironment.isRelayTracingEnabled(env)).toBe(false);
    const resolved = yield* OtelEnvironment.load.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    );
    expect(resolved.disabled).toBe(true);
    for (const signal of ["traces", "metrics", "logs"] as const) {
      expect(
        OtelEnvironment.resolveSignalEndpoint(
          OtelEnvironment.none,
          signal,
          { url: `https://collector.example.test/v1/${signal}`, export: DEFAULT_SIGNAL_EXPORT },
          {
            bootstrapUrl: "https://bootstrap.example.test",
            settingsUrl: "https://saved.example.test",
          },
        ),
      ).toBeUndefined();
    }
  }),
);

it.effect("does not export relay spans with valid credentials and an enabled preference", () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 202 }));
  const tracing = RelayTracing.layer(
    {
      tracesUrl: "https://collector.example.test/v1/traces",
      tracesDataset: "test",
      tracesToken: "test-token",
    },
    { serviceName: "test", runtime: "test", serviceInstanceId: "test", client: "test" },
    { isEnabled: () => true },
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return Effect.void.pipe(
    Effect.withSpan("relay.operation"),
    RelayTracing.withRelayClientTracing,
    Effect.provide(tracing),
    Effect.andThen(Effect.sync(() => expect(fetch).not.toHaveBeenCalled())),
  );
});
