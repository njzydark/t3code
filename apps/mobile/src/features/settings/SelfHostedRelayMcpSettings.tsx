import { useAtomValue } from "@effect/atom-react";
import {
  AuthRelayReadScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type SelfHostedRelayMcpTokenResult,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View, ScrollView } from "react-native";
import * as DateTime from "effect/DateTime";
import { selfHostedRelayClients } from "../../state/selfHostedRelay";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRow } from "../../components/ui/ListRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import * as Dialog from "../../components/ui/Dialog";
import { LINK_ACCESS_CHOICES } from "../threads/LinkRequestCard";

export function SelfHostedRelayMcpSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canRead = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const query = useEnvironmentQuery(
    canRead ? selfHostedRelayClients.status({ environmentId, input: {} }) : null,
  );
  const canIssue = useAtomValue(selfHostedRelayClients.mcpToken.permissionAtom(environmentId));
  const issue = useAtomCommand(selfHostedRelayClients.mcpToken, { reportFailure: false });
  const canConfigure = useAtomValue(selfHostedRelayClients.update.permissionAtom(environmentId));
  const update = useAtomCommand(selfHostedRelayClients.update, { reportFailure: false });
  const [savingApproval, setSavingApproval] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const saveAutoApproval = async (autoApproveNewDevices: boolean) => {
    if (!query.data || !canRead || !canConfigure) return;
    setSavingApproval(true);
    setApprovalError(null);
    const result = await update({
      environmentId,
      input: {
        relayUrl: query.data.relayUrl,
        enabled: query.data.enabled,
        autoApproveNewDevices,
      },
    });
    if (result._tag !== "Success") setApprovalError(gt("Could not save device approval settings."));
    setSavingApproval(false);
  };
  const changeAutoApproval = (checked: boolean) => {
    if (!checked) return void saveAutoApproval(false);
    Dialog.confirm({
      title: gt("Automatically approve new devices?"),
      message: gt(
        "Hosts with the same registration token can grant file, command, and client-management access without confirmation. A stolen token or compromised peer can authorize devices.",
      ),
      confirmText: gt("Enable automatic approval"),
      onConfirm: () => void saveAutoApproval(true),
    });
  };
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<AuthMcpClientAccess>("read-only");
  const [issued, setIssued] = useState<SelfHostedRelayMcpTokenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await issue({ environmentId, input: { label: gt("MCP client"), access } });
    if (result._tag === "Success") setIssued(result.value);
    else setError(gt("Could not create MCP token."));
    setBusy(false);
  };
  if (!canRead || !query.data) return null;
  return (
    <SettingsSection title={gt("Self-hosted relay")}>
      <SettingsSwitchRow
        label={gt("Automatically approve new devices")}
        subtitle={
          query.data.autoApproveNewDevices === undefined
            ? gt("Update this host to manage device approvals.")
            : query.data.autoApproveNewDevices
              ? gt(
                  "Automatic device approval is on. Hosts with the same registration token can authorize devices without confirmation.",
                )
              : gt(
                  "New devices require approval. Existing clients retain access; revoke them in Authorized clients.",
                )
        }
        value={query.data.autoApproveNewDevices ?? false}
        disabled={!canConfigure || savingApproval || query.data.autoApproveNewDevices === undefined}
        onValueChange={changeAutoApproval}
      />
      <Text className="px-4 py-2 text-xs text-foreground-muted">
        {gt("This affects new requests only. Pending requests still require manual approval.")}
      </Text>
      {approvalError ? (
        <Text className="px-4 py-2 text-sm text-danger-foreground">{approvalError}</Text>
      ) : null}
      {query.data.enabled ? (
        <ListRow
          label={gt("MCP token")}
          description={gt(
            "Connect an outside agent using a URL and token. Revoke access under Authorized clients.",
          )}
          disabled={!canIssue}
          onPress={() => {
            setIssued(null);
            setError(null);
            setOpen(true);
          }}
        />
      ) : null}
      {open ? (
        <Sheet title={gt("MCP token")} onClose={() => setOpen(false)} dismissDisabled={busy}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 20 }}
          >
            <Text className="mb-4 text-sm text-foreground-muted">
              {gt("Choose what the agent may do. The token is shown only once.")}
            </Text>
            {issued ? (
              <View className="gap-3">
                <Text selectable>{issued.url}</Text>
                <Text>{gt("Expires: {date}", { date: DateTime.formatIso(issued.expiresAt) })}</Text>
                <Button
                  label={gt("Copy URL and token")}
                  onPress={() =>
                    void tryCopyTextWithHaptic(
                      JSON.stringify({ url: issued.url, token: issued.token }, null, 2),
                    ).then((copied) => {
                      if (!copied) setError(gt("Could not copy MCP token."));
                    })
                  }
                />
              </View>
            ) : (
              <>
                {LINK_ACCESS_CHOICES.map((choice) => (
                  <ListChoiceRow
                    key={choice.access}
                    label={messages(choice.label)}
                    description={messages(choice.description)}
                    selected={access === choice.access}
                    onPress={() => setAccess(choice.access)}
                  />
                ))}
                <Button
                  label={busy ? gt("Creating…") : gt("Create token")}
                  disabled={busy}
                  onPress={() => void create()}
                />
              </>
            )}
            {error ? <Text className="mt-3 text-sm text-danger-foreground">{error}</Text> : null}
          </ScrollView>
        </Sheet>
      ) : null}
    </SettingsSection>
  );
}
