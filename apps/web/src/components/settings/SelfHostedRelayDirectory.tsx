import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import type { SelfHostedRelayCandidate } from "@t3tools/client-runtime/state/selfHostedRelay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { useState } from "react";
import { selfHostedRelayClients } from "~/state/selfHostedRelay";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";

function DiscoveredEnvironment({ candidate }: { readonly candidate: SelfHostedRelayCandidate }) {
  const gt = useGT();
  const connect = useAtomCommand(selfHostedRelayClients.connect, { reportFailure: false });
  const cancel = useAtomCommand(selfHostedRelayClients.cancelConnect, { reportFailure: false });
  const approval = useAtomValue(selfHostedRelayClients.approval(candidate.environmentId));
  const allowed = useAtomValue(selfHostedRelayClients.connect.permissionAtom(candidate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsRow
      title={candidate.label}
      description={
        error ??
        (busy && approval
          ? gt("Waiting for approval on {host}. Compare code {code} on both devices.", {
              host: candidate.label,
              code: approval.verificationCode,
            })
          : candidate.relayUrl)
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !allowed}
            onClick={async () => {
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
          >
            {busy ? gt("Connecting…") : gt("Connect")}
          </Button>
          {busy && approval ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await cancel(candidate.environmentId);
              }}
            >
              {gt("Cancel")}
            </Button>
          ) : null}
        </div>
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
