import type { AuthPairingLink } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { connectDeviceApprovalRequests } from "./ConnectDeviceApprovalCoordinator.logic";

it.each(["t3-connect", "self-hosted-relay"] as const)(
  "distinguishes requested access for %s devices with identical metadata",
  (source) => {
    const base = {
      id: "request",
      subject: "cloud-connect",
      scopes: ["filesystem:read"],
      createdAt: DateTime.makeUnsafe(1_000),
      expiresAt: DateTime.makeUnsafe(601_000),
      connectDeviceRequest: {
        verificationCode: "ABCD-EFGH",
        ...(source === "self-hosted-relay" ? { source } : {}),
        client: { deviceType: "desktop", label: "Work laptop", os: "macOS" },
      },
    } satisfies AuthPairingLink;
    const [read] = connectDeviceApprovalRequests([base]);
    const [manage] = connectDeviceApprovalRequests([
      { ...base, permissions: ["access:write", "terminal:operate"] },
    ]);

    expect(read?.description).toContain("Requested access: Read files");
    expect(read?.description).not.toContain("Manage access");
    expect(manage?.description).toContain("Requested access: Manage access, Use terminals");
    expect(manage?.description).not.toContain("Read files");
    expect(manage?.description).toContain("ABCD-EFGH");
  },
);
