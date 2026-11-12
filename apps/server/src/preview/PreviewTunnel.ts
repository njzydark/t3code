import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { type AuthSessionId, PreviewTunnelError, PreviewTunnelTarget } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Semaphore from "effect/Semaphore";

import * as SessionStore from "../auth/SessionStore.ts";

const isTunnelTarget = Schema.is(PreviewTunnelTarget);
const LIFETIME_MS = 60 * 60 * 1000;

export class PreviewTunnel extends Context.Service<
  PreviewTunnel,
  {
    readonly create: (
      target: PreviewTunnelTarget,
      owner: AuthSessionId,
    ) => Effect.Effect<{ token: string; expiresAt: number }, PreviewTunnelError>;
    readonly revoke: (token: string) => Effect.Effect<void>;
    readonly bridge: (
      token: string,
      socket: Socket.Socket,
    ) => Effect.Effect<void, PreviewTunnelError, Scope.Scope>;
  }
>()("t3/preview/PreviewTunnel") {}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const creating = yield* Semaphore.make(1);
  const sessions = yield* SessionStore.SessionStore;
  const grants = new Map<
    string,
    {
      target: PreviewTunnelTarget;
      owner: AuthSessionId;
      expiresAt: number;
      validationTicket: string;
      revoked: Deferred.Deferred<void>;
    }
  >();
  const invalid = () =>
    new PreviewTunnelError({ message: "The browser tunnel is unavailable or has expired." });
  return PreviewTunnel.of({
    create: Effect.fn("PreviewTunnel.create")(function* (target, owner) {
      if (!isTunnelTarget(target)) return yield* invalid();
      const now = yield* Clock.currentTimeMillis;
      for (const [token, grant] of grants) if (grant.expiresAt <= now) grants.delete(token);
      if (grants.size >= 64)
        return yield* new PreviewTunnelError({ message: "Too many browser tunnels are open." });
      const token = (yield* random.uuidV4()) + (yield* random.uuidV4());
      const expiresAt = now + LIFETIME_MS;
      const credential = yield* sessions
        .issueWebSocketToken(owner, { ttl: Duration.hours(1), audience: "media" })
        .pipe(Effect.mapError(() => invalid()));
      const revoked = yield* Deferred.make<void>();
      grants.set(token, { target, owner, expiresAt, validationTicket: credential.token, revoked });
      return { token, expiresAt };
    }, creating.withPermits(1)),
    revoke: Effect.fn("PreviewTunnel.revoke")(function* (token) {
      const grant = grants.get(token);
      grants.delete(token);
      if (grant) yield* Deferred.succeed(grant.revoked, undefined);
    }),
    bridge: Effect.fn("PreviewTunnel.bridge")(
      function* (token, socket) {
        const grant = grants.get(token);
        const now = yield* Clock.currentTimeMillis;
        if (!grant || grant.expiresAt <= now) return yield* invalid();
        yield* sessions.verifyWebSocketToken(grant.validationTicket);
        const local = yield* NodeSocket.makeNet({
          host: grant.target.hostname === "localhost" ? "127.0.0.1" : grant.target.hostname,
          port: grant.target.port,
          openTimeout: "5 seconds",
          noDelay: true,
        });
        const localReader = yield* local.reader;
        const localWriter = yield* local.writer;
        const remoteReader = yield* socket.reader;
        const remoteWriter = yield* socket.writer;
        const forward = (reader: Socket.Reader, writer: Socket.Writer) =>
          Effect.forever(
            reader.pull.pipe(
              Effect.flatMap((chunks) =>
                Effect.forEach(chunks, (chunk) => writer.write(chunk), { discard: true }),
              ),
            ),
          );
        yield* Effect.raceFirst(
          Effect.raceFirst(forward(localReader, remoteWriter), forward(remoteReader, localWriter)),
          Effect.raceFirst(sessions.awaitInvalidation(grant.owner), Deferred.await(grant.revoked)),
        ).pipe(
          Effect.timeoutOrElse({ duration: grant.expiresAt - now, orElse: () => Effect.void }),
          Effect.catchIf(
            (error) =>
              Socket.isSocketError(error) &&
              error.reason._tag === "SocketCloseError" &&
              error.reason.code === 1000,
            () => Effect.void,
          ),
        );
      },
      (effect) => effect.pipe(Effect.mapError(() => invalid())),
    ),
  });
});

export const layer = Layer.effect(PreviewTunnel, make);
