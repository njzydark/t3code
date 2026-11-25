import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";

export const layer = (relayUrl: string, proofUrl?: (url: string) => string) =>
  ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }).pipe(
    Layer.provideMerge(
      DpopProof.layerSigner({
        keyStore: "indexed-db",
        loadOrCreateKey: loadOrCreateProofKey(),
        ...(proofUrl ? { proofUrl } : {}),
      }),
    ),
  );
