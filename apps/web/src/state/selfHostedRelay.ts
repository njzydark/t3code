import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const selfHostedRelayStatus = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "self-hosted-relay:status",
    tag: WS_METHODS.selfHostedRelaySubscribe,
    idleTtlMs: 0,
  },
);
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
