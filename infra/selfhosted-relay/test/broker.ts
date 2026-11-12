// @effect-diagnostics nodeBuiltinImport:off -- Subprocess fixture for the Rust broker interoperability tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";

const manifest = NodeURL.fileURLToPath(new URL("../Cargo.toml", import.meta.url));
const executableName =
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The subprocess fixture must launch the actual host binary, not an Effect-provided platform.
  NodeOS.platform() === "win32" ? "t3-selfhosted-relay.exe" : "t3-selfhosted-relay";
const executable = NodeURL.fileURLToPath(
  new URL(`../target/debug/${executableName}`, import.meta.url),
);
const built = NodeUtil.promisify(NodeChildProcess.execFile)("cargo", [
  "build",
  "--locked",
  "--manifest-path",
  manifest,
]);
await built;

export async function createRelayBroker(input: {
  readonly registrationToken: string;
  readonly webRoot?: string;
}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "0",
    T3_RELAY_REGISTRATION_TOKEN: input.registrationToken,
  };
  delete env.T3_RELAY_WEB_ROOT;
  delete env.T3_RELAY_PUSH_ENABLED;
  if (input.webRoot) env.T3_RELAY_WEB_ROOT = input.webRoot;
  const child = NodeChildProcess.spawn(executable, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 || signal === "SIGTERM"
        ? resolve()
        : reject(new Error(`Relay exited: ${code ?? signal}`)),
    );
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  const lines = NodeReadline.createInterface({ input: child.stdout });
  const ready = new Promise<string>((resolve) => {
    lines.on("line", (line) => {
      const prefix = "T3 self-hosted relay listening on ";
      if (line.startsWith(prefix)) resolve(line.slice(prefix.length));
    });
  });
  try {
    const url = await Promise.race([
      ready,
      exited.then(() => {
        throw new Error(`Relay exited before readiness: ${stderr}`);
      }),
    ]);
    return {
      url,
      async close() {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
        lines.close();
      },
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited.catch(() => {});
    lines.close();
    throw error;
  }
}
