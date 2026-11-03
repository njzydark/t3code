import * as Schema from "effect/Schema";
import { AuthPairingCredentialResult } from "./auth.ts";

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
