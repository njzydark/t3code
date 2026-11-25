import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

export const layer = (relayUrl: string, proofUrl?: (url: string) => string) =>
  ManagedRelay.layer({
    relayUrl,
    clientId: RelayMobileClientId,
    accessTokenStore: managedRelayAccessTokenStore,
  }).pipe(
    Layer.provideMerge(
      DpopProof.layerSigner({
        keyStore: "expo-secure-store",
        loadOrCreateKey: loadOrCreateProofKey(),
        ...(proofUrl ? { proofUrl } : {}),
      }),
    ),
  );
