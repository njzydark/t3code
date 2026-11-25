import { createSelfHostedRelayAtoms } from "@t3tools/client-runtime/state/selfHostedRelay";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "../connection/catalog";
export const selfHostedRelayClients = createSelfHostedRelayAtoms({
  runtime: connectionAtomRuntime,
  catalog: environmentCatalog.catalogValueAtom,
});
