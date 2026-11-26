import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AnalyticsDevice, CloudSession } from "../platform/capabilities.ts";
import { appendClientConnectionParams, readClientOwnerParams } from "./remote.ts";

it.effect(
  "does not read or attach analytics owner identities while preserving client access metadata",
  () =>
    Effect.gen(function* () {
      const owners = yield* readClientOwnerParams.pipe(
        Effect.provideService(AnalyticsDevice, {
          id: Effect.die("must not create an analytics device id"),
        }),
        Effect.provideService(CloudSession, {
          identity: Effect.die("must not read the account for analytics"),
          clerkToken: Effect.die("unused"),
        }),
      );
      expect(owners).toEqual({});
      const url = new URL("https://host.example.test/ws");
      appendClientConnectionParams(
        url,
        { label: "My Mac", deviceType: "desktop", surface: "desktop" },
        "direct",
        { connect: "account-hash", device: "device-hash" },
      );
      expect(url.searchParams.has("clientOwner")).toBe(false);
      expect(url.searchParams.has("clientDevice")).toBe(false);
      expect(url.searchParams.get("clientSurface")).toBe("desktop");
      expect(url.searchParams.get("clientDeviceType")).toBe("desktop");
    }),
);
