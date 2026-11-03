import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as SelfHostedRelay from "./SelfHostedRelay.ts";

it.layer(
  SelfHostedRelay.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
)("self-hosted relay identity", (it) => {
  it.effect("atomically persists one identity across concurrent pairing requests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-relay-" });
      const identityFile = path.join(directory, "relay", "identity.json");
      const relay = yield* SelfHostedRelay.SelfHostedRelay;
      const input = {
        identityFile,
        relayUrl: "https://relay.example.com",
        credential: "one-time-code",
      };
      const urls = yield* Effect.all(
        Array.from({ length: 8 }, () => relay.pairingUrl(input)),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(new Set(urls).size, 1);
      const saved = yield* fs.readFileString(identityFile);
      assert.strictEqual(yield* relay.pairingUrl(input), urls[0]);
      assert.strictEqual(yield* fs.readFileString(identityFile), saved);
      assert.deepEqual(yield* fs.readDirectory(path.dirname(identityFile)), ["identity.json"]);
      const hash = new URLSearchParams(new URL(urls[0]!).hash.slice(1));
      assert.strictEqual(hash.get("token"), input.credential);
      assert.match(hash.get("route")!, /^[a-f0-9]{32}$/);
      assert.isFalse(saved.includes(input.credential));
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a persisted identity with a substituted public key without replacing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-relay-invalid-" });
      const identityFile = path.join(directory, "identity.json");
      const relay = yield* SelfHostedRelay.SelfHostedRelay;
      const input = { identityFile, relayUrl: "https://relay.example.com", credential: "code" };
      const url = yield* relay.pairingUrl(input);
      const original = yield* fs.readFileString(identityFile);
      const peer = new URLSearchParams(new URL(url).hash.slice(1)).get("peer")!;
      const tampered = original.replace(peer, "substituted-public-key");
      yield* fs.writeFileString(identityFile, tampered);
      const error = yield* relay.pairingUrl(input).pipe(Effect.flip);
      assert.strictEqual(error.operation, "identity");
      assert.strictEqual(yield* fs.readFileString(identityFile), tampered);
    }).pipe(Effect.scoped),
  );
});
