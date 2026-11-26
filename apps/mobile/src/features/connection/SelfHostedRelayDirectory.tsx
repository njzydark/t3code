import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react-native";
import type { SelfHostedRelayCandidate } from "@t3tools/client-runtime/state/selfHostedRelay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "../../i18n/messages";
import { useState } from "react";
import { selfHostedRelayClients } from "../../state/selfHostedRelay";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ListRow } from "../../components/ui/ListRow";

function DiscoveredEnvironment({ candidate }: { readonly candidate: SelfHostedRelayCandidate }) {
  const gt = useGT();
  const connect = useAtomCommand(selfHostedRelayClients.connect, { reportFailure: false });
  const cancel = useAtomCommand(selfHostedRelayClients.cancelConnect, { reportFailure: false });
  const approval = useAtomValue(selfHostedRelayClients.approval(candidate.environmentId));
  const allowed = useAtomValue(selfHostedRelayClients.connect.permissionAtom(candidate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ListRow
        label={candidate.label}
        description={
          error ??
          (busy && approval
            ? gt("Waiting for approval on {host}. Compare code {code} on both devices.", {
                host: candidate.label,
                code: approval.verificationCode,
              })
            : candidate.relayUrl)
        }
        detail={busy ? gt("Connecting…") : gt("Connect")}
        disabled={busy || !allowed}
        onPress={async () => {
          setBusy(true);
          setError(null);
          const result = await connect(candidate);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const cause = squashAtomCommandFailure(result);
            setError(
              cause instanceof Error
                ? (thrownErrorMessage(cause, m) ?? cause.message)
                : gt(
                    "Could not connect. Check that both machines are online and running the latest T3 Code.",
                  ),
            );
          }
          setBusy(false);
        }}
      />
      {busy && approval ? (
        <ListRow label={gt("Cancel")} onPress={() => void cancel(candidate.environmentId)} />
      ) : null}
    </>
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
