import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
} from "@t3tools/shared/desktopBootstrapToken";

import * as ServerConfig from "../config.ts";
import { MCP_APPROVAL_SUBJECT_PREFIX } from "../persistence/AuthPairingLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

const layerServerConfig = (
  overrides?: Partial<
    Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken" | "desktopBootstrapSecret">
  >,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-bootstrap-test-" })),
  );

const layerPairingGrantStore = (
  overrides?: Partial<
    Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken" | "desktopBootstrapSecret">
  >,
) =>
  PairingGrantStore.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerServerConfig(overrides)),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("PairingGrantStore.layer", (it) => {
  it.effect("keeps Relay approvals isolated from T3 Connect trust and other scopes", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const proofKeyThumbprint = "relay-device";
      yield* grants.trustConnectDevice(proofKeyThumbprint, { deviceType: "desktop" });
      const first = yield* grants.issueOneTimeToken({
        proofKeyThumbprint,
        requiresConnectApproval: true,
        authorizationSource: "relay-approved",
        scopes: ["orchestration:read"],
      });
      const expanded = yield* grants.issueOneTimeToken({
        proofKeyThumbprint,
        requiresConnectApproval: true,
        authorizationSource: "relay-approved",
        scopes: ["orchestration:read", "access:write"],
      });
      const pending = yield* grants.listActive();
      expect(pending.map((link) => link.id)).toContain(first.id);
      expect(
        pending.find((link) => link.id === first.id)?.connectDeviceRequest?.verificationCode,
      ).not.toBe(
        pending.find((link) => link.id === expanded.id)?.connectDeviceRequest?.verificationCode,
      );
      expect(
        (yield* Effect.flip(grants.consume(first.credential, { proofKeyThumbprint })))._tag,
      ).toBe("BootstrapCredentialConnectApprovalPendingError");
      expect(yield* grants.approveConnectRequest(first.id)).toBe(true);
      expect((yield* grants.consume(first.credential, { proofKeyThumbprint })).scopes).toEqual([
        "orchestration:read",
      ]);
      expect(
        (yield* Effect.flip(grants.consume(expanded.credential, { proofKeyThumbprint })))._tag,
      ).toBe("BootstrapCredentialConnectApprovalPendingError");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("approves only a Relay request without trusting the device globally", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const proofKeyThumbprint = "untrusted-relay-device";
      const issued = yield* grants.issueOneTimeToken({
        proofKeyThumbprint,
        requiresConnectApproval: true,
        authorizationSource: "relay-approved",
      });
      expect(yield* grants.approveConnectRequest(issued.id)).toBe(true);
      expect(yield* grants.listConnectDevices()).toEqual([]);
      expect(yield* grants.isConnectDeviceTrusted(proofKeyThumbprint)).toBe(false);
      expect(yield* grants.revoke(issued.id)).toBe(true);
      expect(
        (yield* Effect.flip(grants.consume(issued.credential, { proofKeyThumbprint })))._tag,
      ).toBe("UnavailableBootstrapCredentialError");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect(
    "publishes Relay requests with the first client description and removes approvals",
    () =>
      Effect.gen(function* () {
        const grants = yield* PairingGrantStore.PairingGrantStore;
        const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
        yield* grants.streamChanges.pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const issued = yield* grants.issueOneTimeToken({
          proofKeyThumbprint: "relay-client-metadata",
          requiresConnectApproval: true,
          authorizationSource: "relay-approved",
        });
        const created = yield* Queue.take(changes);
        expect(created).toMatchObject({
          type: "pairingLinkUpserted",
          pairingLink: { connectDeviceRequest: { source: "self-hosted-relay" } },
        });
        const client = { deviceType: "mobile" as const, os: "iOS" };
        yield* grants.recordConnectRequestClient(issued.id, client);
        const described = yield* Queue.take(changes);
        yield* grants.recordConnectRequestClient(issued.id, { deviceType: "desktop", os: "other" });
        const [listed] = yield* grants.listActive();
        expect(listed?.connectDeviceRequest?.verificationCode).toBeDefined();
        expect(listed?.connectDeviceRequest?.client).toEqual(client);
        expect(described).toEqual({ type: "pairingLinkUpserted", pairingLink: listed });
        expect(yield* grants.approveConnectRequest(issued.id)).toBe(true);
        expect(yield* Queue.take(changes)).toEqual({ type: "pairingLinkRemoved", id: issued.id });
        expect(yield* Queue.size(changes)).toBe(0);
        expect(yield* grants.listActive()).toEqual([]);
        expect(yield* grants.approveConnectRequest(issued.id)).toBe(false);
        const approvedBeforeDescription = yield* grants.issueOneTimeToken({
          proofKeyThumbprint: "relay-approved-before-description",
          requiresConnectApproval: true,
          authorizationSource: "relay-approved",
        });
        yield* Queue.take(changes);
        yield* grants.approveConnectRequest(approvedBeforeDescription.id);
        expect(yield* Queue.take(changes)).toEqual({
          type: "pairingLinkRemoved",
          id: approvedBeforeDescription.id,
        });
        yield* grants.recordConnectRequestClient(approvedBeforeDescription.id, client);
        expect(yield* Queue.size(changes)).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layerPairingGrantStore())),
  );

  it.effect("rejects denied, cancelled and expired Relay credentials", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const proofKeyThumbprint = "relay-cancellation";
      const issue = () =>
        grants.issueOneTimeToken({
          proofKeyThumbprint,
          requiresConnectApproval: true,
          authorizationSource: "relay-approved",
          ttl: Duration.minutes(10),
        });
      for (const action of ["deny", "cancel", "approve-then-cancel", "expire"] as const) {
        const issued = yield* issue();
        if (action === "approve-then-cancel") {
          expect(yield* grants.approveConnectRequest(issued.id)).toBe(true);
        }
        if (action === "deny") {
          expect(yield* grants.revoke(issued.id)).toBe(true);
        } else if (action === "expire") {
          yield* TestClock.adjust(Duration.minutes(10));
          expect(yield* grants.cancelPendingPairing(issued.credential, proofKeyThumbprint)).toBe(
            false,
          );
        } else {
          expect(yield* grants.cancelPendingPairing(issued.credential, proofKeyThumbprint)).toBe(
            true,
          );
          expect(yield* grants.cancelPendingPairing(issued.credential, proofKeyThumbprint)).toBe(
            false,
          );
        }
        expect(yield* grants.approveConnectRequest(issued.id)).toBe(false);
        expect(
          (yield* Effect.flip(grants.consume(issued.credential, { proofKeyThumbprint })))._tag,
        ).toBe(
          action === "expire"
            ? "ExpiredBootstrapCredentialError"
            : "UnavailableBootstrapCredentialError",
        );
      }
      expect(yield* grants.listActive()).toEqual([]);
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("allows cancellation only for the owning key's unspent Relay approval grant", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const proofKeyThumbprint = "relay-owner";
      const relay = yield* grants.issueOneTimeToken({
        proofKeyThumbprint,
        requiresConnectApproval: true,
        authorizationSource: "relay-approved",
      });
      expect(yield* grants.cancelPendingPairing(relay.credential, "other-client")).toBe(false);
      expect(yield* grants.approveConnectRequest(relay.id)).toBe(true);
      yield* grants.consume(relay.credential, { proofKeyThumbprint });
      expect(yield* grants.cancelPendingPairing(relay.credential, proofKeyThumbprint)).toBe(false);
      for (const input of [
        {},
        { proofKeyThumbprint },
        {
          proofKeyThumbprint,
          requiresConnectApproval: true,
          authorizationSource: "pairing-link" as const,
        },
        { requiresConnectApproval: true },
        {
          proofKeyThumbprint,
          requiresConnectApproval: true,
          authorizationSource: "relay-approved" as const,
          subject: "cloud-connect",
        },
      ]) {
        const issued = yield* grants.issueOneTimeToken(input);
        expect(yield* grants.cancelPendingPairing(issued.credential, proofKeyThumbprint)).toBe(
          false,
        );
      }
      expect(yield* grants.cancelPendingPairing("unknown", proofKeyThumbprint)).toBe(false);
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("accepts lowercase one-time tokens exactly once", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* bootstrapCredentials.issueOneTimeToken({ label: "Julius iPhone" });
      const first = yield* bootstrapCredentials.consume(issued.credential.toLowerCase());
      const second = yield* Effect.flip(bootstrapCredentials.consume(issued.credential));

      expect(first.method).toBe("one-time-token");
      expect(first.scopes).toEqual(AuthStandardClientScopes);
      expect(first.subject).toBe("one-time-token");
      expect(first.label).toBe("Julius iPhone");
      expect(issued.label).toBe("Julius iPhone");
      expect(second._tag).toBe("UnknownBootstrapCredentialError");
      expect(second.message).toContain("Unknown bootstrap credential");
    }).pipe(
      Effect.provide(layerPairingGrantStore()),
      Effect.provideService(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size).fill(8)),
      ),
    ),
  );

  it.effect("accepts a one-time token typed in hyphen- or space-separated groups", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* bootstrapCredentials.issueOneTimeToken();
      const formatted = issued.credential.match(/.{1,4}/g)!.join("-");
      const consumed = yield* bootstrapCredentials.consume(formatted.toLowerCase());
      const second = yield* bootstrapCredentials.issueOneTimeToken();
      const spaced = yield* bootstrapCredentials.consume(
        second.credential.match(/.{1,4}/g)!.join(" "),
      );

      expect(consumed.method).toBe("one-time-token");
      expect(spaced.method).toBe("one-time-token");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("atomically consumes a one-time token when multiple requests race", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken();
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          Effect.result(
            bootstrapCredentials.consume(token.credential, {
              requestedScopes: ["orchestration:read"],
            }),
          ),
        ),
        {
          concurrency: "unbounded",
        },
      );

      const successes = results.filter((result) => result._tag === "Success");
      const failures = results.filter((result) => result._tag === "Failure");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(7);
      for (const failure of failures) {
        expect(failure.failure._tag).toBe("UnknownBootstrapCredentialError");
        expect(failure.failure.message).toContain("Unknown bootstrap credential");
      }
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("requires the bound proof key thumbprint when present", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken({
        proofKeyThumbprint: "client-proof-key-thumbprint",
        scopes: ["orchestration:read"],
      });

      const missing = yield* Effect.flip(bootstrapCredentials.consume(token.credential));
      const wrong = yield* Effect.flip(
        bootstrapCredentials.consume(token.credential, {
          proofKeyThumbprint: "other-proof-key-thumbprint",
          requestedScopes: ["access:write"],
        }),
      );
      const forbiddenScope = yield* Effect.flip(
        bootstrapCredentials.consume(token.credential, {
          proofKeyThumbprint: "client-proof-key-thumbprint",
          requestedScopes: ["access:write"],
        }),
      );
      const consumed = yield* bootstrapCredentials.consume(token.credential, {
        proofKeyThumbprint: "client-proof-key-thumbprint",
        requestedScopes: ["orchestration:read"],
      });

      expect(missing.message).toContain("proof key mismatch");
      expect(wrong.message).toContain("proof key mismatch");
      expect(forbiddenScope._tag).toBe("BootstrapCredentialScopeNotGrantedError");
      expect(consumed.proofKeyThumbprint).toBe("client-proof-key-thumbprint");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("matches a seeded desktop bootstrap credential exactly", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const exact = yield* bootstrapCredentials.consume("abcdefghjkmn");
      const otherCase = yield* Effect.flip(bootstrapCredentials.consume("ABCDEFGHJKMN"));

      expect(exact.method).toBe("desktop-bootstrap");
      expect(otherCase._tag).toBe("UnknownBootstrapCredentialError");
    }).pipe(
      Effect.provide(
        layerPairingGrantStore({
          desktopBootstrapToken: "abcdefghjkmn",
        }),
      ),
    ),
  );

  it.effect("reports seeded desktop bootstrap credentials as expired after their ttl", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;

      yield* TestClock.adjust(Duration.hours(12));
      const stillValid = yield* bootstrapCredentials.consume("desktop-bootstrap-token");
      expect(stillValid.method).toBe("desktop-bootstrap");

      yield* TestClock.adjust(Duration.hours(13));
      const expired = yield* Effect.flip(bootstrapCredentials.consume("desktop-bootstrap-token"));

      expect(expired._tag).toBe("ExpiredBootstrapCredentialError");
      expect(expired.message).toContain("Bootstrap credential expired");
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerPairingGrantStore({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("accepts rotating desktop bootstrap tokens derived from the desktop secret", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const window = DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS;

      yield* TestClock.adjust(Duration.days(5));
      const now = 5 * 24 * 60 * 60 * 1000;
      const current = yield* bootstrapCredentials.consume(
        yield* currentDesktopBootstrapToken("desktop-secret", now).pipe(
          Effect.provide(NodeCrypto.layerMac),
        ),
      );
      expect(current.method).toBe("desktop-bootstrap");

      const staleToken = yield* currentDesktopBootstrapToken(
        "desktop-secret",
        now - 2 * window,
      ).pipe(Effect.provide(NodeCrypto.layerMac));
      const stale = yield* Effect.flip(bootstrapCredentials.consume(staleToken));
      expect(stale._tag).toBe("UnknownBootstrapCredentialError");

      const launch = yield* Effect.flip(bootstrapCredentials.consume("desktop-bootstrap-token"));
      expect(launch._tag).toBe("UnknownBootstrapCredentialError");
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerPairingGrantStore({
            desktopBootstrapToken: "desktop-bootstrap-token",
            desktopBootstrapSecret: "desktop-secret",
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("keeps credentials out of pairing lists and change events", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
      yield* grants.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );
      // An app approval code sends no update, issued or spent; the next belongs to a plain code.
      const approval = yield* grants.issueOneTimeToken({ mcpApproval: "auto" });
      yield* grants.consume(approval.credential, {
        allowedSubject: `${MCP_APPROVAL_SUBJECT_PREFIX}auto`,
      });
      for (const input of [{}, { label: "Synthetic phone" }]) {
        const issued = yield* grants.issueOneTimeToken(input);
        const change = yield* Queue.take(changes);
        expect(change?.type).toBe("pairingLinkUpserted");
        if (change?.type !== "pairingLinkUpserted")
          throw new Error("Expected a pairing link update");
        expect(change.pairingLink.id).toBe(issued.id);
        expect(change.pairingLink).not.toHaveProperty("credential");
        const listed = (yield* grants.listActive()).find((link) => link.id === issued.id);
        expect(listed).toEqual(change.pairingLink);
        const consumed = yield* grants.consume(issued.credential);
        expect(consumed.scopes).toEqual(change.pairingLink.scopes);
        expect(yield* Queue.take(changes)).toEqual({ type: "pairingLinkRemoved", id: issued.id });
      }
    }).pipe(Effect.scoped, Effect.provide(layerPairingGrantStore())),
  );
});
