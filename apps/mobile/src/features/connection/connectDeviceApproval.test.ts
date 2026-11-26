import type { AuthPairingLink } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { connectDeviceApprovalPrompts, createApprovalPromptQueue } from "./connectDeviceApproval";

const link = (id: string, createdAtMs: number, request?: AuthPairingLink["connectDeviceRequest"]) =>
  ({
    id,
    scopes: [],
    subject: "cloud-connect",
    createdAt: DateTime.makeUnsafe(createdAtMs),
    expiresAt: DateTime.makeUnsafe(createdAtMs + 600_000),
    ...(request ? { connectDeviceRequest: request } : {}),
  }) as unknown as AuthPairingLink;

describe("connectDeviceApprovalPrompts", () => {
  it.each(["t3-connect", "self-hosted-relay"] as const)(
    "distinguishes requested access for %s devices with identical metadata",
    (source) => {
      const request = {
        verificationCode: "ABCD-EFGH",
        ...(source === "self-hosted-relay" ? { source } : {}),
        client: { deviceType: "desktop" as const, label: "Work laptop", os: "macOS" },
      };
      const prompts = connectDeviceApprovalPrompts({
        environmentLabel: "Mac mini",
        pairingLinks: [
          { ...link("read", 1_000, request), scopes: ["filesystem:read"] },
          {
            ...link("manage", 2_000, request),
            scopes: ["filesystem:read"],
            permissions: ["access:write", "terminal:operate"],
          },
        ],
        shownIds: new Set(),
      });

      expect(prompts[0]?.message).toContain("Requested access: Read files");
      expect(prompts[0]?.message).not.toContain("Manage access");
      expect(prompts[1]?.message).toContain("Requested access: Manage access, Use terminals");
      expect(prompts[1]?.message).not.toContain("Read files");
    },
  );

  it("prompts once per waiting device, oldest first, and skips ordinary pairing links", () => {
    const pairingLinks = [
      link("newer", 2_000, { verificationCode: "WXYZ-2345" }),
      link("plain", 500),
      link("older", 1_000, {
        verificationCode: "ABCD-EFGH",
        client: { deviceType: "desktop", browser: "Chrome", os: "macOS" },
      }),
      link("relay", 1_500, {
        verificationCode: "RELY-5678",
        source: "self-hosted-relay",
        client: { deviceType: "desktop", label: "Work laptop", os: "macOS" },
      }),
    ];

    const prompts = connectDeviceApprovalPrompts({
      environmentLabel: "Mac mini",
      pairingLinks,
      shownIds: new Set(["newer"]),
    });

    expect(prompts.map((prompt) => prompt.pairingLinkId)).toEqual(["older", "relay"]);
    expect(prompts[0]?.message).toContain("Chrome on macOS wants to connect to Mac mini");
    expect(prompts[0]?.message).toContain("ABCD-EFGH");
    expect(prompts[0]?.message).toContain("through T3 Connect");
    expect(prompts[1]?.message).toContain("Work laptop · macOS");
    expect(prompts[1]?.message).toContain("through Self-hosted relay");
    expect(prompts[1]?.message).toContain("RELY-5678");
  });
});

describe("createApprovalPromptQueue", () => {
  it("shows one prompt at a time and offers a failed one again before the rest", () => {
    const shown: string[] = [];
    const answers: Array<(outcome: "done" | "retry" | "later") => void> = [];
    const queue = createApprovalPromptQueue<{ pairingLinkId: string }>((prompt, answer) => {
      shown.push(prompt.pairingLinkId);
      answers.push(answer);
    });

    queue.offer([{ pairingLinkId: "a" }, { pairingLinkId: "b" }]);
    queue.offer([{ pairingLinkId: "a" }]);
    expect(shown).toEqual(["a"]);

    answers.at(-1)!("retry");
    expect(shown).toEqual(["a", "a"]);
    answers.at(-1)!("done");
    expect(shown).toEqual(["a", "a", "b"]);
  });

  it("waits for the next offer when another dialog replaced the prompt", () => {
    const shown: string[] = [];
    const answers: Array<(outcome: "done" | "retry" | "later") => void> = [];
    const queue = createApprovalPromptQueue<{ pairingLinkId: string }>((prompt, answer) => {
      shown.push(prompt.pairingLinkId);
      answers.push(answer);
    });

    queue.offer([{ pairingLinkId: "a" }]);
    answers.at(-1)!("later");
    expect(shown).toEqual(["a"]);
    queue.offer([]);
    expect(shown).toEqual(["a", "a"]);
  });

  it("offers a dropped host's on-screen prompt again once the host is back", () => {
    const shown: string[] = [];
    const answers: Array<(outcome: "done" | "retry" | "later") => void> = [];
    const queue = createApprovalPromptQueue<{ pairingLinkId: string; host: string }>(
      (prompt, answer) => {
        shown.push(prompt.pairingLinkId);
        answers.push(answer);
      },
    );

    queue.offer([{ pairingLinkId: "a", host: "mini" }]);
    queue.drop((prompt) => prompt.host === "mini");
    answers.at(-1)!("retry");
    expect(shown).toEqual(["a"]);
    queue.offer([{ pairingLinkId: "a", host: "mini" }]);
    expect(shown).toEqual(["a", "a"]);
  });

  it("drops a host's waiting prompts so they cannot hold up other hosts", () => {
    const shown: string[] = [];
    const answers: Array<(outcome: "done" | "retry" | "later") => void> = [];
    const queue = createApprovalPromptQueue<{ pairingLinkId: string; host: string }>(
      (prompt, answer) => {
        shown.push(prompt.pairingLinkId);
        answers.push(answer);
      },
    );

    queue.offer([
      { pairingLinkId: "a", host: "mini" },
      { pairingLinkId: "b", host: "mini" },
      { pairingLinkId: "c", host: "laptop" },
    ]);
    queue.drop((prompt) => prompt.host === "mini");
    answers.at(-1)!("done");
    expect(shown).toEqual(["a", "c"]);
    // A dropped host's request can be offered again once the host is back.
    expect(queue.known.has("b")).toBe(false);
  });
});
