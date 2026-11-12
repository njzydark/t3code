// @effect-diagnostics nodeBuiltinImport:off -- Verify that the scoped loopback listener is actually closed.
import * as NodeNet from "node:net";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as BrowserTunnels from "./BrowserTunnels.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";

it.live("reuses a port across page paths and releases it when the desktop scope closes", () =>
  Effect.gen(function* () {
    const opened: string[] = [];
    const scope = yield* Scope.make();
    const services = yield* Layer.buildWithScope(
      BrowserTunnels.layer.pipe(
        Layer.provide(
          Layer.mock(ElectronShell.ElectronShell, {
            openExternal: (url) =>
              Effect.sync(() => {
                opened.push(String(url));
                return true;
              }),
          }),
        ),
      ),
      scope,
    );
    const tunnels = yield* BrowserTunnels.BrowserTunnels.pipe(Effect.provideContext(services));
    const expiresAt = (yield* Clock.currentTimeMillis) + 3_600_000;
    const wsUrl = "ws://127.0.0.1:1/api/preview-tunnel/ws?wsTicket=fixture-only-grant";
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    expect(yield* tunnels.open({ url: "http://localhost:8088/a?x=1#part", wsUrl, expiresAt })).toBe(
      true,
    );
    expect(yield* tunnels.open({ url: "http://localhost:8088/b", wsUrl, expiresAt })).toBe(true);
    expect(new URL(opened[0]!).origin).toBe(new URL(opened[1]!).origin);
    expect(
      new URL(opened[0]!).pathname + new URL(opened[0]!).search + new URL(opened[0]!).hash,
    ).toBe("/a?x=1#part");
    yield* Scope.close(scope, Exit.void);
    const port = Number(new URL(opened[0]!).port);
    const closed = yield* Effect.promise(
      () =>
        new Promise<boolean>((resolve) => {
          const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
          socket.once("error", (error: NodeJS.ErrnoException) =>
            resolve(error.code === "ECONNREFUSED"),
          );
          socket.once("connect", () => {
            socket.destroy();
            resolve(false);
          });
        }),
    );
    expect(closed).toBe(true);
  }).pipe(Effect.scoped),
);
