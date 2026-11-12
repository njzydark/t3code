import { AuthPreviewOperateScope, PreviewTunnelTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as PreviewTunnel from "./PreviewTunnel.ts";

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const tunnels = yield* PreviewTunnel.PreviewTunnel;
    yield* router.add(
      "POST",
      "/api/preview-tunnel",
      Effect.gen(function* () {
        const owner = yield* authenticateMediaRequest(AuthPreviewOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const target = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(PreviewTunnelTarget)),
        );
        const grant = yield* tunnels.create(target, owner.sessionId);
        return HttpServerResponse.jsonUnsafe(grant, { headers: { "cache-control": "no-store" } });
      }).pipe(
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Unable to open browser tunnel.", { status: 403 }),
        ),
      ),
    );
    yield* router.add(
      "DELETE",
      "/api/preview-tunnel",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = new URL(request.url, "http://localhost").searchParams.get("wsTicket") ?? "";
        yield* tunnels.revoke(token);
        return HttpServerResponse.empty({ status: 204 });
      }),
    );
    yield* router.add(
      "GET",
      "/api/preview-tunnel/ws",
      Effect.scoped(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const token = new URL(request.url, "http://localhost").searchParams.get("wsTicket") ?? "";
          const socket = yield* request.upgrade;
          yield* tunnels.bridge(token, socket).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                const writer = yield* socket.writer;
                yield* writer.write(new Socket.CloseEvent(1008, "Browser tunnel unavailable"));
              }),
            ),
          );
          return HttpServerResponse.empty();
        }),
      ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty())),
    );
  }),
);
