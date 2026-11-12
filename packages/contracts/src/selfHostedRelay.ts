import * as Schema from "effect/Schema";
import { AuthPairingCredentialResult } from "./auth.ts";
import { RelayAgentActivityAggregateState, RelayDeviceRegistrationRequest } from "./relay.ts";

export const SelfHostedPushRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("capabilities") }),
  Schema.Struct({
    operation: Schema.Literal("register"),
    registration: RelayDeviceRegistrationRequest,
  }),
  Schema.Struct({
    operation: Schema.Literal("activity"),
    deviceId: Schema.String,
    activityPushToken: Schema.String,
  }),
  Schema.Struct({ operation: Schema.Literal("unregister"), deviceId: Schema.String }),
  Schema.Struct({ operation: Schema.Literal("snapshot"), deviceId: Schema.String }),
]);
export type SelfHostedPushRequest = typeof SelfHostedPushRequest.Type;
export const SelfHostedPushResponse = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  bundleId: Schema.optional(Schema.String),
  apsEnvironment: Schema.optional(Schema.Literals(["sandbox", "production"])),
  aggregate: Schema.optional(Schema.NullOr(RelayAgentActivityAggregateState)),
  ok: Schema.optional(Schema.Boolean),
});
export type SelfHostedPushResponse = typeof SelfHostedPushResponse.Type;
export class SelfHostedPushError extends Schema.TaggedError<SelfHostedPushError>()(
  "SelfHostedPushError",
  {
    operation: Schema.Literals(["configuration", "request", "registration"]),
    status: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "The self-hosted push service is unavailable or does not match this app's push identity.";
  }
}

export const SelfHostedRelayStatus = Schema.Struct({
  relayUrl: Schema.String,
  enabled: Schema.Boolean,
  hasRegistrationToken: Schema.Boolean,
  phase: Schema.Literals(["disabled", "connecting", "connected", "reconnecting", "error"]),
  error: Schema.NullOr(Schema.String),
});
export type SelfHostedRelayStatus = typeof SelfHostedRelayStatus.Type;

export const SelfHostedRelayUpdate = Schema.Struct({
  relayUrl: Schema.String.check(Schema.isMaxLength(2048)),
  enabled: Schema.Boolean,
  registrationToken: Schema.optional(
    Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(1024)),
  ),
});
export type SelfHostedRelayUpdate = typeof SelfHostedRelayUpdate.Type;

export const SelfHostedRelayPairResult = Schema.Struct({
  ...AuthPairingCredentialResult.fields,
  url: Schema.String,
});
export type SelfHostedRelayPairResult = typeof SelfHostedRelayPairResult.Type;

export class SelfHostedRelayOperationError extends Schema.TaggedError<SelfHostedRelayOperationError>()(
  "SelfHostedRelayOperationError",
  {
    operation: Schema.Literals([
      "configuration",
      "storage",
      "pairing",
      "unavailable",
      "policy",
      "permissions",
    ]),
  },
) {
  override get message() {
    switch (this.operation) {
      case "configuration":
        return "Enter a secure relay origin and a registration token of at least 32 characters.";
      case "storage":
        return "Could not read or save the self-hosted relay configuration.";
      case "pairing":
        return "Could not create the self-hosted relay pairing link.";
      case "unavailable":
        return "Connect the self-hosted relay before creating a pairing link.";
      case "policy":
        return "Your organization's policy does not allow remote clients.";
      case "permissions":
        return "Choose at least one permission, without duplicates, that your current session can grant.";
    }
  }
}
