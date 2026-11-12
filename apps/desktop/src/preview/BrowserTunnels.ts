import { DesktopBrowserTunnelInput } from "@t3tools/contracts";
import { createLoopbackTunnel } from "@t3tools/relay-transport/tunnel";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ElectronShell from "../electron/ElectronShell.ts";

class BrowserTunnelError extends Schema.TaggedError<BrowserTunnelError>()("BrowserTunnelError", {
  cause: Schema.Defect(),
}) {}

export class BrowserTunnels extends Context.Service<
  BrowserTunnels,
  {
    readonly open: (input: DesktopBrowserTunnelInput) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/preview/BrowserTunnels") {}

const make = Effect.gen(function* () {
  const opening = yield* Semaphore.make(1);
  const scope = yield* Scope.Scope;
  const shell = yield* ElectronShell.ElectronShell;
  const tunnels = new Map<string, Awaited<ReturnType<typeof createLoopbackTunnel>>>();
  return BrowserTunnels.of({
    open: Effect.fn("BrowserTunnels.open")(
      function* (input) {
        const url = new URL(input.url);
        const now = yield* Clock.currentTimeMillis;
        if (
          url.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          url.username ||
          url.password ||
          input.expiresAt <= now ||
          input.expiresAt > now + 3_660_000
        )
          return false;
        let tunnel = tunnels.get(input.wsUrl);
        if (!tunnel) {
          if (tunnels.size >= 16) return false;
          tunnel = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => createLoopbackTunnel(input),
              catch: (cause) => new BrowserTunnelError({ cause }),
            }),
            (opened) => Effect.promise(() => opened.close()),
          ).pipe(Effect.provideService(Scope.Scope, scope));
          tunnels.set(input.wsUrl, tunnel);
          const opened = tunnel;
          yield* Effect.sleep(Math.min(input.expiresAt - now, 3_600_000)).pipe(
            Effect.ensuring(
              Effect.promise(() => opened.close()).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    tunnels.delete(input.wsUrl);
                  }),
                ),
              ),
            ),
            Effect.forkIn(scope),
          );
        }
        url.hostname = "127.0.0.1";
        url.port = String(tunnel.port);
        return yield* shell.openExternal(url.href);
      },
      opening.withPermits(1),
      (effect) => effect.pipe(Effect.orElseSucceed(() => false)),
    ),
  });
});
export const layer = Layer.effect(BrowserTunnels, make);
