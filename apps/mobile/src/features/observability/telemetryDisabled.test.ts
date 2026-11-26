import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";

import { connectionTracesEnabled, setConnectionTracesEnabled } from "./diagnosticsSetting";
import { layerFromConfig, resolveTracingConfig } from "./tracing";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";

const configured = vi.hoisted(() => ({
  relay: { url: "https://relay.example.test" },
  clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
  observability: {
    tracesUrl: "https://api.axiom.test/v1/traces",
    tracesDataset: "mobile-traces",
    tracesToken: "public-ingest-token",
  },
}));
const persistence = vi.hoisted(() => ({
  loadPreferences: vi.fn(async () => ({
    connectionTracesEnabled: true,
    crashReportsEnabled: true,
  })),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: configured } },
}));
vi.mock("../../persistence/imperative", () => persistence);

it.effect("blocks configured traces despite saved opt-in and an explicit enable", () => {
  setConnectionTracesEnabled(true);
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  return Layer.build(
    Layer.effectDiscard(
      Effect.void.pipe(Effect.withSpan("mobile.fork-disabled"), withRelayClientTracing),
    ).pipe(
      Layer.provide(
        layerFromConfig(configured.observability, {
          appVariant: "production",
          serviceInstanceId: "saved-opt-in-install",
        }).pipe(Layer.provide(layerRemoteHttpClient(fetchFn))),
      ),
    ),
  ).pipe(
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).not.toHaveBeenCalled();
        expect(persistence.loadPreferences).not.toHaveBeenCalled();
        expect(connectionTracesEnabled()).toBe(false);
        expect(resolveTracingConfig()).toBeNull();
        expect(resolveCloudPublicConfig()).toEqual({
          ...configured,
          observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
        });
      }),
    ),
  );
});
