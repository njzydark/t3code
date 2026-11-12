import * as Schema from "effect/Schema";

export const SELF_HOSTED_RELAY_CONFIG_SECRET = "self-hosted-relay";
export const StoredSelfHostedRelayConfig = Schema.fromJsonString(
  Schema.Struct({
    relayUrl: Schema.String,
    registrationToken: Schema.String,
    enabled: Schema.Boolean,
  }),
);
