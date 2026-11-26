import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  AuthMcpClientAccess,
  type SelfHostedRelayMcpTokenResult,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";
import * as DateTime from "effect/DateTime";
import { selfHostedRelayClients } from "~/state/selfHostedRelay";
import { useAtomCommand } from "~/state/use-atom-command";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";

export function SelfHostedRelayMcpTokenPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canIssue = useAtomValue(selfHostedRelayClients.mcpToken.permissionAtom(environmentId));
  const issue = useAtomCommand(selfHostedRelayClients.mcpToken, { reportFailure: false });
  const [access, setAccess] = useState<AuthMcpClientAccess>("read-only");
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<SelfHostedRelayMcpTokenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await issue({
      environmentId,
      input: { label: label.trim() || gt("MCP client"), access },
    });
    if (result._tag === "Success") setIssued(result.value);
    else setError(gt("Could not create MCP token."));
    setBusy(false);
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {gt("Choose what the agent may do. The token is shown only once.")}
      </p>
      {issued ? (
        <>
          <p className="text-sm text-muted-foreground">
            {gt("Expires: {date}", { date: DateTime.formatIso(issued.expiresAt) })}
          </p>
          <Input aria-label={gt("MCP URL")} readOnly value={issued.url} />
          <Input aria-label={gt("MCP token")} readOnly type="password" value={issued.token} />
          <Button
            onClick={() =>
              void writeTextToClipboard(
                JSON.stringify({ url: issued.url, token: issued.token }, null, 2),
              ).then(
                () => setCopied(true),
                () => setError(gt("Could not copy MCP token.")),
              )
            }
          >
            {copied ? gt("Copied") : gt("Copy URL and token")}
          </Button>
        </>
      ) : (
        <>
          <Input
            aria-label={gt("Client label")}
            placeholder={gt("MCP client")}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Select
            value={access}
            onValueChange={(value) => {
              if (value) setAccess(value);
            }}
          >
            <SelectTrigger aria-label={gt("Access")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {AuthMcpClientAccess.literals.map((level) => (
                <SelectItem key={level} value={level}>
                  {messages(accessConfig[level].label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button disabled={busy || !canIssue} onClick={() => void create()}>
            {busy ? gt("Creating…") : gt("Create token")}
          </Button>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
