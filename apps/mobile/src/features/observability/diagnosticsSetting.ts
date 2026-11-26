import { telemetryDisabled } from "@t3tools/shared/telemetryPolicy";

// Start off until the saved connection-traces preference loads.
let sending = false;
let changedSinceLoad = false;

export const connectionTracesEnabled = () => !telemetryDisabled && sending;
export function setConnectionTracesEnabled(enabled: boolean): void {
  changedSinceLoad = true;
  sending = !telemetryDisabled && enabled;
}

// Imported lazily so the persistence graph never runs ahead of the imports `index.ts` orders first.
if (!telemetryDisabled) {
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then((preferences) => {
      if (!changedSinceLoad) sending = preferences.connectionTracesEnabled !== false;
    })
    .catch((error: unknown) => {
      console.warn("[tracing] could not read the connection traces setting", error);
    });
}
