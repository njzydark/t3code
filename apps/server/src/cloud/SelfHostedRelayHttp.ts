import {
  SELF_HOSTED_RELAY_CONNECT_PATH,
  SELF_HOSTED_RELAY_CANCEL_PATH,
  SelfHostedRelayAuthorization,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SelfHostedRelayHost } from "./SelfHostedRelayHost.ts";
import { SignedGroupGrant } from "./selfHostedRelayGroupAuth.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { verifyRequestDpopProof } from "../auth/dpop.ts";

const decodeGrant = Schema.decodeUnknownEffect(SignedGroupGrant);
const encodeAuthorization = Schema.encodeSync(Schema.toCodecJson(SelfHostedRelayAuthorization));
const decodeCancellation = Schema.decodeUnknownEffect(
  Schema.Struct({
    credential: Schema.String.check(Schema.isMaxLength(1024)),
    proof: Schema.String.check(Schema.isMaxLength(8192)),
  }),
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* SelfHostedRelayHost;
    const auth = yield* EnvironmentAuth;
    return Layer.mergeAll(
      HttpRouter.add(
        "POST",
        SELF_HOSTED_RELAY_CONNECT_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const grant = yield* request.json.pipe(Effect.flatMap(decodeGrant));
          const result = yield* host.authorize(request, grant);
          return HttpServerResponse.jsonUnsafe(encodeAuthorization(result), {
            headers: { "cache-control": "no-store" },
          });
        }).pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(32768)),
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 })),
        ),
      ),
      HttpRouter.add(
        "POST",
        SELF_HOSTED_RELAY_CANCEL_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.json.pipe(Effect.flatMap(decodeCancellation));
          const thumbprint = yield* verifyRequestDpopProof({ request, proof: input.proof });
          const cancelled = yield* auth.cancelPendingPairing(input.credential, thumbprint);
          return HttpServerResponse.empty({ status: cancelled ? 204 : 403 });
        }).pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(32768)),
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 })),
        ),
      ),
    );
  }),
);
