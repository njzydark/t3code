import { AuthAccessReadScope, AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import * as DateTime from "effect/DateTime";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeConnectDevice } from "../connection/connectDeviceApproval";
import { SettingsSection } from "./components/SettingsSection";

export function AuthorizedClientsSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const access = useEnvironmentQuery(
    canRead ? authEnvironment.accessChanges({ environmentId, input: null }) : null,
  );
  const revoke = useAtomCommand(authEnvironment.revokeClient, { reportFailure: false });
  const approve = useAtomCommand(authEnvironment.approveConnectDevice, { reportFailure: false });
  const deny = useAtomCommand(authEnvironment.revokePairingLink, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<{ readonly _tag: string }>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    if (result._tag !== "Success") setError(gt("Could not update device access."));
    setBusy(false);
  };
  if (!canRead || access.data?.type !== "snapshot") return null;
  const { clientSessions, pairingLinks } = access.data.payload;
  const pending = pairingLinks.filter((link) => link.connectDeviceRequest !== undefined);
  return (
    <SettingsSection title={gt("Authorized clients")}>
      {pending.map((link) => {
        const request = link.connectDeviceRequest!;
        // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- client is device metadata in the access snapshot, not an RPC client
        const name = describeConnectDevice(request.client, messages);
        const product =
          request.source === "self-hosted-relay" ? gt("Self-hosted relay") : "T3 Connect";
        const description = gt(
          "{device} wants to connect through {product}. Approve only if it shows code {code}.",
          {
            device: name,
            product,
            code: request.verificationCode,
          },
        );
        const requestedAccess = gt("Requested access: {scopes}", {
          scopes: (link.permissions ?? link.scopes)
            .map((scope) => {
              const option = AUTH_SCOPE_OPTIONS.find((option) => option.scope === scope);
              return option ? messages(option.title) : scope;
            })
            .join(", "),
        });
        return (
          <ListRow
            key={link.id}
            label={gt("Waiting for approval · {code}", { code: request.verificationCode })}
            description={description}
            meta={
              <View className="gap-1">
                <Text className="text-xs text-foreground-muted">
                  {gt("Requested {date}", { date: DateTime.formatIso(link.createdAt) })}
                </Text>
                <Text className="text-xs text-foreground-muted">{requestedAccess}</Text>
              </View>
            }
            disabled={!canWrite || busy}
            onPress={() =>
              Dialog.alert(gt("Approve this device?"), `${description}\n\n${requestedAccess}`, [
                { text: gt("Cancel"), style: "cancel" },
                {
                  text: gt("Deny"),
                  style: "destructive",
                  onPress: () => void run(() => deny({ environmentId, input: { id: link.id } })),
                },
                {
                  text: gt("Approve"),
                  onPress: () =>
                    void run(() => approve({ environmentId, input: { pairingLinkId: link.id } })),
                },
              ])
            }
          />
        );
      })}
      {clientSessions.map((session) => {
        const source = session.authorizationSource;
        const badge =
          source === "relay-auto"
            ? gt("Automatically approved")
            : source === "relay-approved"
              ? gt("Manually approved")
              : source === "pairing-link"
                ? gt("Pairing link")
                : null;
        // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- client is device metadata in the access snapshot, not an RPC client
        const name = describeConnectDevice(session.client, messages, session.subject);
        return (
          <ListRow
            key={session.sessionId}
            label={name}
            description={
              session.current
                ? gt("This device")
                : session.connected
                  ? gt("Connected")
                  : gt("Disconnected")
            }
            meta={
              badge ? (
                <View className="self-start rounded-md border border-border px-1.5 py-0.5">
                  <Text className="text-xs text-foreground-muted">{badge}</Text>
                </View>
              ) : null
            }
            detail={session.current ? undefined : gt("Revoke")}
            disabled={session.current || !canWrite || busy}
            onPress={() =>
              Dialog.confirm({
                title: gt("Revoke {name}?", { name }),
                message: gt("This client will lose access to this host."),
                confirmText: gt("Revoke"),
                destructive: true,
                onConfirm: () =>
                  void run(() =>
                    revoke({ environmentId, input: { sessionId: session.sessionId } }),
                  ),
              })
            }
          />
        );
      })}
      {clientSessions.length === 0 && pending.length === 0 ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          {gt("No authorized clients.")}
        </Text>
      ) : null}
      {error ? <Text className="px-4 py-2 text-sm text-danger-foreground">{error}</Text> : null}
    </SettingsSection>
  );
}
