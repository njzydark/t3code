// @effect-diagnostics nodeBuiltinImport:off -- Filesystem and network fixture for the standalone broker.
// @effect-diagnostics globalFetch:off -- Exercise the standalone Node broker without the Effect HTTP runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { createRelayBroker } from "../test/broker.ts";

it("serves the web app and worker, while refusing symlinks outside the web root", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-relay-web-"));
  const webRoot = NodePath.join(directory, "web");
  await NodeFSP.mkdir(webRoot);
  await NodeFSP.writeFile(NodePath.join(webRoot, "index.html"), "<!doctype html><title>T3</title>");
  await NodeFSP.writeFile(NodePath.join(webRoot, "relay-worker.js"), "self.test = true;");
  await NodeFSP.mkdir(NodePath.join(webRoot, "assets"));
  await NodeFSP.writeFile(NodePath.join(webRoot, "assets/app.js"), "export {};");
  await NodeFSP.writeFile(NodePath.join(webRoot, "assets/app.js.map"), "private source map");
  await NodeFSP.writeFile(NodePath.join(directory, "private.txt"), "private configuration");
  await NodeFSP.symlink(
    NodePath.join(directory, "private.txt"),
    NodePath.join(webRoot, "escape.txt"),
  );
  const broker = await createRelayBroker({
    registrationToken: "static-test-registration-credential",
    webRoot,
  });
  try {
    const base = broker.url;
    const page = await fetch(`${base}/pair`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("<title>T3</title>");
    expect((await fetch(base)).status).toBe(200);
    const worker = await fetch(`${base}/relay-worker.js`, { method: "HEAD" });
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toContain("javascript");
    expect(worker.headers.get("cache-control")).toBe("no-store");
    expect(Number(worker.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await worker.text()).toBe("");
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await fetch(`${base}/assets/app.js.map`)).status).toBe(404);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e%2fprivate.txt`)).status).toBe(400);
    expect((await fetch(`${base}/%5cprivate.txt`)).status).toBe(400);
    expect((await fetch(`${base}/%00private.txt`)).status).toBe(400);
    expect((await fetch(`${base}/%ff`)).status).toBe(400);
    const escaped = await fetch(`${base}/escape.txt`);
    expect(escaped.status).toBe(404);
    expect(await escaped.text()).not.toContain("private configuration");
    await NodeFSP.rm(NodePath.join(webRoot, "index.html"));
    expect((await fetch(`${base}/pair`)).status).toBe(404);
  } finally {
    await broker.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("exposes health but no web app in core mode", async () => {
  const broker = await createRelayBroker({
    registrationToken: "core-test-registration-credential",
  });
  try {
    const health = await fetch(`${broker.url}/healthz`);
    expect(await health.json()).toEqual({ ok: true });
    expect((await fetch(broker.url)).status).toBe(404);
    expect((await fetch(`${broker.url}/pair`)).status).toBe(404);
    expect((await fetch(`${broker.url}/relay-worker.js`)).status).toBe(404);
  } finally {
    await broker.close();
  }
});
