import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react-native";
import type { SelfHostedRelayCandidate } from "@t3tools/client-runtime/state/selfHostedRelay";
import { useState } from "react";
import { selfHostedRelayClients } from "../../state/selfHostedRelay";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ListRow } from "../../components/ui/ListRow";

function DiscoveredEnvironment({ candidate }: { readonly candidate: SelfHostedRelayCandidate }) {
  const gt = useGT();
  const connect = useAtomCommand(selfHostedRelayClients.connect, { reportFailure: false });
  const allowed = useAtomValue(
    selfHostedRelayClients.connect.permissionAtom(candidate.viaEnvironmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <ListRow
      label={candidate.label}
      description={
        error
          ? gt(
              "Could not connect. Check that both machines are online and running the latest T3 Code.",
            )
          : candidate.relayUrl
      }
      detail={busy ? gt("Connecting…") : gt("Connect")}
      disabled={busy || !allowed}
      onPress={async () => {
        setBusy(true);
        setError(false);
        const result = await connect(candidate);
        setError(result._tag !== "Success");
        setBusy(false);
      }}
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
