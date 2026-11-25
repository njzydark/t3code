import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { buildRelayPairingUrl } from "@t3tools/relay-transport";
import { selfHostedRelayClients } from "../../state/selfHostedRelay";
import { appAtomRegistry } from "../../state/atom-registry";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ListRow } from "../../components/ui/ListRow";
import { linkedEnvironmentPrefillAtom } from "./linkedEnvironmentPrefill";

export function SelfHostedRelayDirectory() {
  const gt = useGT();
  const navigation = useNavigation();
  const candidates = useAtomValue(selfHostedRelayClients.candidates);
  if (candidates.length === 0) return null;
  return (
    <SettingsSection title={gt("Self-hosted relay")}>
      {candidates.map((candidate) => (
        <ListRow
          key={candidate.environmentId}
          label={candidate.label}
          description={candidate.relayUrl}
          onPress={() => {
            appAtomRegistry.set(linkedEnvironmentPrefillAtom, {
              environmentId: candidate.environmentId,
              label: candidate.label,
              host: buildRelayPairingUrl(candidate, ""),
            });
            navigation.navigate("SettingsEnvironmentNew", { linked: candidate.environmentId });
          }}
        />
      ))}
    </SettingsSection>
  );
}
