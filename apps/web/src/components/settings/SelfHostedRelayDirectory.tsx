import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import type { SelfHostedRelayCandidate } from "@t3tools/client-runtime/state/selfHostedRelay";
import { useState } from "react";
import { selfHostedRelayClients } from "~/state/selfHostedRelay";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";

function DiscoveredEnvironment({ candidate }: { readonly candidate: SelfHostedRelayCandidate }) {
  const gt = useGT();
  const connect = useAtomCommand(selfHostedRelayClients.connect, { reportFailure: false });
  const allowed = useAtomValue(
    selfHostedRelayClients.connect.permissionAtom(candidate.viaEnvironmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <SettingsRow
      title={candidate.label}
      description={
        error
          ? gt(
              "Could not connect. Check that both machines are online and running the latest T3 Code.",
            )
          : candidate.relayUrl
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !allowed}
          onClick={async () => {
            setBusy(true);
            setError(false);
            const result = await connect(candidate);
            setError(result._tag !== "Success");
            setBusy(false);
          }}
        >
          {busy ? gt("Connecting…") : gt("Connect")}
        </Button>
      }
    />
  );
}

export function SelfHostedRelayDirectory() {
  const gt = useGT();
  const candidates = useAtomValue(selfHostedRelayClients.candidates);
  if (candidates.length === 0) return null;
  return (
    <SettingsSection title={gt("Self-hosted relay")}>
      {candidates.map((candidate) => (
        <DiscoveredEnvironment key={candidate.environmentId} candidate={candidate} />
      ))}
    </SettingsSection>
  );
}
