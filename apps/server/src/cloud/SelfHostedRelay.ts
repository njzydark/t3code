import { buildRelayPairingUrl } from "@t3tools/relay-transport";
import { validateRelayAddress } from "@t3tools/relay-transport/protocol";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";

const Identity = Schema.Struct({
  version: Schema.Literal(1),
  route: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  peerId: Schema.String,
  privateKey: Schema.String,
});
type Identity = typeof Identity.Type;
const IdentityJson = Schema.fromJsonString(Identity);
const decodeIdentity = Schema.decodeUnknownEffect(IdentityJson);
const encodeIdentity = Schema.encodeEffect(IdentityJson);

export class SelfHostedRelayError extends Schema.TaggedError<SelfHostedRelayError>()(
  "SelfHostedRelayError",
  {
    operation: Schema.Literals(["identity", "configuration", "connect"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    switch (this.operation) {
      case "identity":
        return "Could not load or create the self-hosted relay identity.";
      case "configuration":
        return "Invalid self-hosted relay configuration. Use an HTTPS relay origin and a loopback HTTP target.";
      case "connect":
        return "The self-hosted relay connection failed.";
    }
  }
}
const isSelfHostedRelayError = Schema.is(SelfHostedRelayError);

export class SelfHostedRelay extends Context.Service<
  SelfHostedRelay,
  {
    readonly run: (input: {
      readonly relayUrl: string;
      readonly target: string;
      readonly identityFile: string;
      readonly registrationToken: string;
      readonly onStatus?: (phase: "connected" | "reconnecting") => Effect.Effect<void>;
    }) => Effect.Effect<void, SelfHostedRelayError>;
    readonly pairingUrl: (input: {
      readonly relayUrl: string;
      readonly identityFile: string;
      readonly credential: string;
    }) => Effect.Effect<string, SelfHostedRelayError>;
  }
>()("t3/cloud/SelfHostedRelay") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;

  const readIdentity = Effect.fn("SelfHostedRelay.readIdentity")(function* (file: string) {
    const identity = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeIdentity));
    yield* Effect.tryPromise({
      try: async () => {
        const { peerIdForPrivateKey } = await import("@t3tools/relay-transport/secure");
        if (peerIdForPrivateKey(identity.privateKey) !== identity.peerId)
          throw new Error("Relay identity keys do not match.");
      },
      catch: (cause) => new SelfHostedRelayError({ operation: "identity", cause }),
    });
    return identity;
  });
  const identity = Effect.fn("SelfHostedRelay.identity")(
    function* (file: string) {
      if (yield* fs.exists(file)) return yield* readIdentity(file);
      const generated = yield* Effect.tryPromise({
        try: async () => (await import("@t3tools/relay-transport/secure")).generateIdentity(),
        catch: (cause) => new SelfHostedRelayError({ operation: "identity", cause }),
      });
      const route = Array.from(yield* random.randomBytes(16), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const value: Identity = { version: 1, route, ...generated };
      const text = yield* encodeIdentity(value);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${yield* random.uuidV4()}.tmp`;
      yield* fs.writeFileString(temp, text, { flag: "wx", mode: 0o600 });
      yield* fs.link(temp, file).pipe(
        Effect.catch((cause) =>
          fs
            .exists(file)
            .pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(cause)))),
        ),
        Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
      );
      return yield* readIdentity(file);
    },
    Effect.mapError((cause) =>
      isSelfHostedRelayError(cause)
        ? cause
        : new SelfHostedRelayError({ operation: "identity", cause }),
    ),
  );

  const pairingUrl = Effect.fn("SelfHostedRelay.pairingUrl")(function* (input: {
    readonly relayUrl: string;
    readonly identityFile: string;
    readonly credential: string;
  }) {
    const host = yield* identity(input.identityFile);
    return yield* Effect.try({
      try: () =>
        buildRelayPairingUrl(
          { relayUrl: input.relayUrl, route: host.route, peerId: host.peerId },
          input.credential,
        ),
      catch: (cause) => new SelfHostedRelayError({ operation: "configuration", cause }),
    });
  });

  const run = Effect.fn("SelfHostedRelay.run")(function* (
    input: Parameters<SelfHostedRelay["Service"]["run"]>[0],
  ) {
    const host = yield* identity(input.identityFile);
    const address = yield* Effect.try({
      try: () =>
        validateRelayAddress({ relayUrl: input.relayUrl, route: host.route, peerId: host.peerId }),
      catch: (cause) => new SelfHostedRelayError({ operation: "configuration", cause }),
    });
    const { connectHost, validateLocalTarget } = yield* Effect.promise(
      () => import("@t3tools/relay-transport/node"),
    );
    yield* Effect.try({
      try: () => {
        validateLocalTarget(input.target);
        if (input.registrationToken.length < 32)
          throw new Error("Relay registration token is too short.");
      },
      catch: (cause) => new SelfHostedRelayError({ operation: "configuration", cause }),
    });
    yield* Effect.logInfo("Connecting this T3 environment to the self-hosted relay.", {
      relay: new URL(address.relayUrl).host,
      route: address.route,
    });
    const states = yield* Queue.unbounded<"connected" | "reconnecting">();
    yield* Queue.take(states).pipe(
      Effect.flatMap((phase) => input.onStatus?.(phase) ?? Effect.void),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.tryPromise({
      try: (signal) =>
        connectHost({
          address,
          target: input.target,
          privateKey: host.privateKey,
          registrationToken: input.registrationToken,
          signal,
          onConnected: () => {
            Queue.offerUnsafe(states, "connected");
          },
        }),
      catch: (cause) => new SelfHostedRelayError({ operation: "connect", cause }),
    }).pipe(
      Effect.tapError(() => Queue.offer(states, "reconnecting")),
      Effect.tapError(() =>
        Effect.logWarning(
          "Self-hosted relay disconnected; retrying in 3 seconds. Check the relay URL, registration token and host availability.",
        ),
      ),
      Effect.retry(Schedule.spaced("3 seconds")),
    );
  }, Effect.scoped);
  return SelfHostedRelay.of({ run, pairingUrl });
});

export const layer = Layer.effect(SelfHostedRelay, make);
