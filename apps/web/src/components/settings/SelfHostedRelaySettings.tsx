import { SelfHostedRelayMcpSettings } from "./SelfHostedRelayMcpSettings";
import { T, msg, useGT, useMessages } from "gt-react";
import { m } from "~/i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthRelayReadScope,
  type EnvironmentId,
  type SelfHostedRelayStatus,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import {
  forgetSelfHostedRelay,
  selfHostedRelayStatus,
  updateSelfHostedRelay,
} from "~/state/selfHostedRelay";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : m(msg("The relay operation failed."));
}

const phaseLabel: Record<SelfHostedRelayStatus["phase"], string> = {
  disabled: msg("Disconnected"),
  connecting: msg("Connecting…"),
  connected: msg("Connected"),
  reconnecting: msg("Reconnecting…"),
  error: msg("Connection error"),
};

export function SelfHostedRelaySettings({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const searchableSetting = useSearchableSetting();
  const canRead = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const query = useEnvironmentQuery(
    canRead ? selfHostedRelayStatus({ environmentId, input: {} }) : null,
  );
  const canEdit = useAtomValue(updateSelfHostedRelay.permissionAtom(environmentId));
  const save = useAtomCommand(updateSelfHostedRelay, { reportFailure: false });
  const forget = useAtomCommand(forgetSelfHostedRelay, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = query.data;
  const dirty = relayUrl !== data?.relayUrl || token.length > 0;
  const canSave =
    canEdit &&
    !busy &&
    data !== null &&
    relayUrl.trim().length > 0 &&
    (token.length >= 32 || (token.length === 0 && data.hasRegistrationToken));
  const status = data
    ? data.hasRegistrationToken
      ? resolveMessage(phaseLabel[data.phase])
      : data.phase === "error"
        ? resolveMessage(phaseLabel.error)
        : gt("Not configured")
    : gt("Loading…");

  const handleOpenChange = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    setRelayUrl(data?.relayUrl ?? "");
    setToken("");
    setError(null);
  };
  const update = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    const result = await save({
      environmentId,
      input: {
        relayUrl: enabled ? relayUrl : (data?.relayUrl ?? relayUrl),
        enabled,
        ...(enabled && token ? { registrationToken: token } : {}),
      },
    });
    if (result._tag === "Success") {
      setToken("");
      setOpen(false);
    } else setError(failureMessage(result));
    setBusy(false);
  };
  const clear = async () => {
    if (
      !(await requestConfirmDialog(
        gt(
          "Remove the saved relay URL and registration token and disconnect this host? Paired devices are not revoked, and the host identity is kept.",
        ),
      ))
    )
      return;
    setBusy(true);
    setError(null);
    const result = await forget({ environmentId, input: {} });
    if (result._tag === "Success") {
      setToken("");
      setOpen(false);
    } else setError(failureMessage(result));
    setBusy(false);
  };

  if (!canRead) return null;
  return (
    <>
      <SettingsRow
        {...searchableSetting("self-hosted-relay")}
        description={
          query.error ??
          (data?.hasRegistrationToken
            ? `${status} · ${data.relayUrl}`
            : (data?.error ??
              gt(
                "Let other devices reach this host through your own relay. No inbound host port is needed.",
              )))
        }
        control={
          <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger render={<Button size="sm" variant="outline" disabled={!data} />}>
              {data?.hasRegistrationToken ? gt("Configure") : gt("Set up")}
            </DialogTrigger>
            <DialogPopup className="max-w-lg">
              <DialogHeader>
                <DialogTitle>
                  <T>Self-hosted relay</T>
                </DialogTitle>
                <DialogDescription>
                  {gt(
                    "Connect {environmentLabel} to your own relay. This does not enable LAN access or use T3 Connect. The connector runs with T3 and reconnects on startup.",
                    { environmentLabel },
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-4">
                  <p role="status" className="text-sm text-muted-foreground">
                    {status}
                    {data?.error ? `: ${data.error}` : ""}
                  </p>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium">
                      <T>Relay URL</T>
                    </span>
                    <Input
                      aria-label={gt("Self-hosted relay URL")}
                      type="url"
                      value={relayUrl}
                      placeholder="https://relay.example.com"
                      disabled={!canEdit || busy}
                      onChange={(event) => setRelayUrl(event.target.value)}
                    />
                    <span className="block text-xs text-muted-foreground">
                      <T>Use an HTTPS origin. HTTP is allowed only for loopback testing.</T>
                    </span>
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium">
                      <T>Host registration token</T>
                    </span>
                    <Input
                      aria-label={gt("Relay registration token")}
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      value={token}
                      maxLength={1024}
                      placeholder={
                        data?.hasRegistrationToken
                          ? gt("Saved on this host; leave blank to keep")
                          : gt("At least 32 characters")
                      }
                      disabled={!canEdit || busy}
                      onChange={(event) => setToken(event.target.value)}
                    />
                    <span className="block text-xs text-muted-foreground">
                      <T>
                        Required. Must match T3_RELAY_REGISTRATION_TOKEN on your relay server. This
                        admits hosts to the relay; devices use pairing links instead. Stored
                        privately on this host.
                      </T>
                    </span>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    <T>
                      To connect another device, use Create link under Authorized clients and choose
                      Self-hosted relay.
                    </T>
                  </p>
                  {error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  ) : null}
                </div>
              </DialogPanel>
              <DialogFooter variant="bare">
                <div className="flex w-full flex-wrap items-center justify-between gap-2">
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost-muted"
                          aria-label={gt("Relay connection actions")}
                          disabled={!canEdit || busy || !data}
                        />
                      }
                    >
                      <EllipsisIcon className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="start">
                      <MenuItem disabled={!data?.enabled} onClick={() => void update(false)}>
                        <T>Disconnect relay</T>
                      </MenuItem>
                      <MenuItem
                        variant="destructive"
                        disabled={!data?.hasRegistrationToken && data?.phase !== "error"}
                        onClick={() => void clear()}
                      >
                        <T>Remove relay configuration</T>
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => handleOpenChange(false)}
                    >
                      <T>Cancel</T>
                    </Button>
                    <Button
                      disabled={!canSave || (data?.phase === "connected" && !dirty)}
                      onClick={() => void update(true)}
                    >
                      {busy
                        ? gt("Saving…")
                        : data?.enabled
                          ? gt("Save and reconnect")
                          : gt("Save and connect")}
                    </Button>
                  </div>
                </div>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        }
      />
      {data?.enabled ? <SelfHostedRelayMcpSettings environmentId={environmentId} /> : null}
    </>
  );
}
