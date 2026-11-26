import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const updateSelfHostedRelay = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "self-hosted-relay:update",
  tag: WS_METHODS.selfHostedRelayUpdate,
});
export const forgetSelfHostedRelay = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "self-hosted-relay:forget",
  tag: WS_METHODS.selfHostedRelayForget,
});
export const pairSelfHostedRelay = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "self-hosted-relay:pair",
  tag: WS_METHODS.selfHostedRelayPair,
});

import { createSelfHostedRelayAtoms } from "@t3tools/client-runtime/state/selfHostedRelay";
import { environmentCatalog } from "../connection/catalog";
export const selfHostedRelayClients = createSelfHostedRelayAtoms({
  runtime: connectionAtomRuntime,
  catalog: environmentCatalog.catalogValueAtom,
});
export const selfHostedRelayStatus = selfHostedRelayClients.status;
