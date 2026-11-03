import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Command, Flag } from "effect/cli";

import * as SelfHostedRelay from "../cloud/SelfHostedRelay.ts";
import { expandHomePath } from "../os-jank.ts";
import { runWithEnvironmentAuth } from "./auth.ts";
import { authScopesFlag } from "./authScopes.ts";
import { authLocationFlags } from "./config.ts";

const relayFlags = {
  url: Flag.String("url").pipe(Flag.withDescription("Self-hosted relay HTTPS origin.")),
  identityFile: Flag.String("identity-file").pipe(
    Flag.withDefault("~/.t3/relay/identity.json"),
    Flag.withDescription("Persistent host identity. Use a separate file for each T3 environment."),
  ),
};

const connect = Command.make("connect", {
  ...relayFlags,
  target: Flag.String("target").pipe(
    Flag.withDescription("Running local T3 server origin, for example http://127.0.0.1:3773."),
  ),
}).pipe(
  Command.withDescription(
    "Keep an outbound encrypted tunnel to your self-hosted relay. T3 must already be running.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const token = yield* Config.Redacted("T3_RELAY_REGISTRATION_TOKEN");
      const relay = yield* SelfHostedRelay.SelfHostedRelay;
      yield* relay.run({
        relayUrl: flags.url,
        target: flags.target,
        identityFile: yield* expandHomePath(flags.identityFile),
        registrationToken: Redacted.value(token),
      });
    }).pipe(Effect.provide(SelfHostedRelay.layer)),
  ),
);

const pair = Command.make("pair", {
  ...relayFlags,
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
}).pipe(
  Command.withDescription("Print a one-time relay pairing link for this T3 environment."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const relay = yield* SelfHostedRelay.SelfHostedRelay;
      const identityFile = yield* expandHomePath(flags.identityFile);
      yield* runWithEnvironmentAuth(flags, (auth) =>
        Effect.gen(function* () {
          const issued = yield* auth.createPairingLink({
            scopes: flags.scopes,
            label: "Self-hosted relay",
            ttl: Duration.minutes(10),
          });
          const url = yield* relay.pairingUrl({
            relayUrl: flags.url,
            identityFile,
            credential: issued.credential,
          });
          yield* Console.log(url);
        }),
      );
    }).pipe(Effect.provide(SelfHostedRelay.layer)),
  ),
);

export const relayCommand = Command.make("relay").pipe(
  Command.withDescription("Connect through your own encrypted relay without a T3 Connect account."),
  Command.withSubcommands([connect, pair]),
);
