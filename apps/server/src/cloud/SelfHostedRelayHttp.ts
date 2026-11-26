import { SELF_HOSTED_RELAY_CONNECT_PATH } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SelfHostedRelayHost } from "./SelfHostedRelayHost.ts";
import { SignedGroupGrant } from "./selfHostedRelayGroupAuth.ts";

const decodeGrant = Schema.decodeUnknownEffect(SignedGroupGrant);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* SelfHostedRelayHost;
    return HttpRouter.add(
      "POST",
      SELF_HOSTED_RELAY_CONNECT_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const grant = yield* request.json.pipe(Effect.flatMap(decodeGrant));
        const result = yield* host.authorize(request, grant);
        return HttpServerResponse.jsonUnsafe(result, { headers: { "cache-control": "no-store" } });
      }).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(32768)),
        Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 })),
      ),
    );
  }),
);
