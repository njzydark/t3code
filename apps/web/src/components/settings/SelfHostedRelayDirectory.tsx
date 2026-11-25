import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { useGT } from "gt-react";
import { buildRelayPairingUrl } from "@t3tools/relay-transport";
import { selfHostedRelayClients } from "~/state/selfHostedRelay";
import { addEnvironmentPrefillAtom } from "~/state/linkedThreadView";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";

export function SelfHostedRelayDirectory() {
  const gt = useGT();
  const candidates = useAtomValue(selfHostedRelayClients.candidates);
  const setPrefill = useAtomSet(addEnvironmentPrefillAtom);
  if (candidates.length === 0) return null;
  return (
    <SettingsSection title={gt("Self-hosted relay")}>
      {candidates.map((candidate) => (
        <SettingsRow
          key={candidate.environmentId}
          title={candidate.label}
          description={candidate.relayUrl}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setPrefill({
                  environmentId: candidate.environmentId,
                  label: candidate.label,
                  host: buildRelayPairingUrl(candidate, ""),
                })
              }
            >
              {gt("Pair")}
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
