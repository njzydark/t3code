import type { AuthPairingLink } from "@t3tools/contracts";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { describeConnectDeviceClient } from "./settings/ConnectionsSettings.logic";

export function connectDeviceApprovalRequests(pairingLinks: ReadonlyArray<AuthPairingLink>) {
  return pairingLinks.flatMap((link) => {
    const request = link.connectDeviceRequest;
    if (!request) return [];
    return [
      {
        id: link.id,
        expiresAt: link.expiresAt,
        description: m(
          msg(
            "{device} wants to connect through {product}. Approve only if it shows code {code}. Requested access: {scopes}",
            {
              device: describeConnectDeviceClient(request),
              product:
                request.source === "self-hosted-relay" ? m(msg("Self-hosted relay")) : "T3 Connect",
              code: request.verificationCode,
              scopes: (link.permissions ?? link.scopes)
                .map((scope) => {
                  const option = AUTH_SCOPE_OPTIONS.find((option) => option.scope === scope);
                  return option ? m(option.title) : scope;
                })
                .join(", "),
            },
          ),
        ),
      },
    ];
  });
}
