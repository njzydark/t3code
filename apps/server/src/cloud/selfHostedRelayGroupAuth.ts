import {
  AuthEnvironmentScope,
  EnvironmentId,
  SelfHostedRelayOperationError,
} from "@t3tools/contracts";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

const GroupGrant = Schema.Struct({
  environmentId: EnvironmentId,
  proof: Schema.String.check(Schema.isMaxLength(8192)),
  scopes: Schema.Array(AuthEnvironmentScope).check(Schema.isMinLength(1)),
});
export const SignedGroupGrant = Schema.Struct({
  payload: Schema.String.check(Schema.isMaxLength(16384)),
  signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type SignedGroupGrant = typeof SignedGroupGrant.Type;
const decodeGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(GroupGrant));
const encodeGrant = Schema.encodeEffect(Schema.fromJsonString(GroupGrant));
export const encodeSignedGroupGrant = Schema.encodeSync(Schema.fromJsonString(SignedGroupGrant));
const utf8 = (value: string) => new TextEncoder().encode(value);

const signature = Effect.fn("selfHostedRelayGroupAuth.signature")(function* (
  secret: string,
  payload: string,
) {
  const mac = yield* Mac.Mac;
  const key = yield* Mac.key(Mac.hmacSha256, utf8(secret));
  return Hex.encode(yield* mac.sign(key, utf8(`t3-selfhost-group-connect-v1:${payload}`)));
}, Effect.orDie);

export const signGroupGrant = Effect.fn("selfHostedRelayGroupAuth.sign")(function* (
  secret: string,
  grant: typeof GroupGrant.Type,
) {
  const payload = yield* encodeGrant(grant).pipe(Effect.orDie);
  return { payload, signature: yield* signature(secret, payload) };
});

export const verifyGroupGrant = Effect.fn("selfHostedRelayGroupAuth.verify")(function* (
  secret: string,
  signed: SignedGroupGrant,
) {
  if (!Mac.timingSafeEqual(utf8(yield* signature(secret, signed.payload)), utf8(signed.signature)))
    return yield* new SelfHostedRelayOperationError({ operation: "permissions" });
  return yield* decodeGrant(signed.payload).pipe(
    Effect.mapError(() => new SelfHostedRelayOperationError({ operation: "permissions" })),
  );
});
