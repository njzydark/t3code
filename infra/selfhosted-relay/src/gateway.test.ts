// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- A real host, public HTTP client and Rust relay exercise the adapter boundary.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { connectHost } from "@t3tools/relay-transport/node";
import { generateIdentity } from "@t3tools/relay-transport/secure";
import { createRelayBroker } from "../test/broker.ts";

async function fixture() {
  const first = "first-group-fixture-token-".repeat(2);
  const second = "second-group-fixture-token-".repeat(2);
  const broker = await createRelayBroker({ registrationToken: "", tokens: { first, second } });
  const controllers: AbortController[] = [];
  const tasks: Promise<void>[] = [];
  const servers: NodeHttp.Server[] = [];
  const seen: Array<{
    url: string;
    host: string | undefined;
    prefix: string | string[] | undefined;
  }> = [];
  const host = async (environmentId: string, token: string, route: string) => {
    const server = NodeHttp.createServer(async (req, res) => {
      if (req.url === "/.well-known/t3/environment") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ environmentId, label: environmentId }));
        return;
      }
      seen.push({
        url: req.url ?? "",
        host: req.headers.host,
        prefix: req.headers["x-forwarded-prefix"],
      });
      if (req.headers.authorization !== "Bearer fixture-mcp-session") {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      if (req.url === "/mcp?events=1") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        res.end("data: second\n\n");
        return;
      }
      let count = 0;
      for await (const bytes of req) count += bytes.length;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ environmentId, method: req.method, bytes: count }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const identity = await generateIdentity();
    const controller = new AbortController();
    controllers.push(controller);
    const ready = Promise.withResolvers<void>();
    const task = connectHost({
      address: { relayUrl: broker.url, route, peerId: identity.peerId },
      registrationToken: token,
      privateKey: identity.privateKey,
      target: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
      signal: controller.signal,
      publishEnvironment: true,
      onConnected: () => ready.resolve(),
    });
    tasks.push(task);
    await Promise.race([ready.promise, task]);
  };
  try {
    await host("mac-a", first, "1".repeat(32));
    await host("mac-b", first, "2".repeat(32));
    await host("other", second, "3".repeat(32));
    return {
      broker,
      first,
      second,
      seen,
      async [Symbol.asyncDispose]() {
        for (const c of controllers) c.abort();
        await Promise.all(tasks);
        await broker.close();
        for (const s of servers) {
          s.closeAllConnections();
          await new Promise<void>((resolve) => s.close(() => resolve()));
        }
      },
    };
  } catch (error) {
    for (const c of controllers) c.abort();
    await Promise.allSettled(tasks);
    await broker.close();
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
    throw error;
  }
}

describe("single-origin relay discovery and public gateway", () => {
  it("isolates token groups and forwards only allowlisted MCP/peer routes with streaming and host authentication", async () => {
    await using test = await fixture();
    const base = test.broker.url;
    const directory = async (token: string) => {
      const response = await fetch(base + "/v1/environments", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ environments: Array<{ environmentId: string }> }>;
    };
    expect((await directory(test.first)).environments.map((e) => e.environmentId)).toEqual([
      "mac-a",
      "mac-b",
    ]);
    expect((await directory(test.second)).environments.map((e) => e.environmentId)).toEqual([
      "other",
    ]);
    expect(
      (await fetch(base + "/v1/environments", { headers: { authorization: "Bearer wrong" } }))
        .status,
    ).toBe(401);
    const path = base + "/v1/environments/mac-a";
    const denied = await fetch(path + "/mcp", { method: "POST" });
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe("unauthorized");
    const headers = { authorization: "Bearer fixture-mcp-session" };
    const uploaded = await fetch(path + "/mcp", {
      method: "POST",
      headers,
      body: new Uint8Array(512 * 1024),
    });
    expect(await uploaded.json()).toEqual({
      environmentId: "mac-a",
      method: "POST",
      bytes: 512 * 1024,
    });
    const streamed = await fetch(path + "/mcp?events=1", { headers });
    expect(streamed.headers.get("content-type")).toBe("text/event-stream");
    expect(await streamed.text()).toBe("data: first\n\ndata: second\n\n");
    const peer = await fetch(path + "/api/links/thread/history", { headers });
    expect(peer.status).toBe(200);
    await peer.text();
    for (const p of [
      "/api/auth/session",
      "/api/auth/pairing-token",
      "/api/webhooks/test",
      "/other",
    ]) {
      expect((await fetch(path + p, { headers })).status).toBe(404);
    }
    expect((await fetch(base + "/v1/environments/missing/mcp", { headers })).status).toBe(404);
    expect(
      test.seen.every(
        (request) =>
          request.host === new URL(base).host && request.prefix === "/v1/environments/mac-a",
      ),
    ).toBe(true);
  });
});
