import {
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthPairingCredentialResult,
  type SelfHostedRelayStatus,
  managedCapabilityDenial,
  type ManagedPolicySummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { AuthorizedClientsHeaderAction } from "./AuthorizedClientsSettings";

const localId = EnvironmentId.make("local");
const serviceId = EnvironmentId.make("service");

const state = vi.hoisted(() => ({
  primaryEnvironmentId: null as string | null,
  policies: new Map<string, unknown>(),
  relay: null as SelfHostedRelayStatus | null,
  create: vi.fn(),
  pair: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => state.primaryEnvironmentId) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map(
      [...state.policies].map(([environmentId, managedPolicy]) => [
        environmentId,
        { managedPolicy },
      ]),
    )) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    command.label === "self-hosted-relay:pair" ? state.pair : state.create) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((id: string) => id === serviceId) as never,
  readEnvironmentScope: ((id: string) => id === serviceId) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: state.relay, error: null, isPending: false })) as never,
}));
vi.mock(import("../../state/selfHostedRelay"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    pairSelfHostedRelay: {
      ...actual.pairSelfHostedRelay,
      permissionAtom: (() => allowed) as never,
    },
  };
});

const remoteClientsOff: ManagedPolicySummary = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: { clients: ["desktop"] },
};

function setup(policies: ReadonlyArray<readonly [EnvironmentId, ManagedPolicySummary]>) {
  state.primaryEnvironmentId = localId;
  state.policies = new Map(policies);
  state.relay = null;
  state.create.mockReset();
  state.pair.mockReset();
}

const renderHeader = (environmentId: EnvironmentId) =>
  render(
    <AuthorizedClientsHeaderAction
      environmentId={environmentId}
      onPairingLinkCreated={() => {}}
      clientSessions={null}
      isRevokingOtherClients={false}
      onRevokeOtherClients={() => {}}
      delegatableScopes={[]}
    />,
  );

describe("AuthorizedClientsHeaderAction", () => {
  const denial = managedCapabilityDenial(remoteClientsOff, "remoteClients")!;

  it("follows the selected service's policy, not the primary's", async () => {
    setup([[serviceId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("group", { name: denial })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("leaves pairing open on an unmanaged service when the primary is managed", async () => {
    setup([[localId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
    expect(screen.getByRole("group", { name: denial }).query()).toBeNull();
  });

  it.each(["direct", "relay"] as const)(
    "shares a newly created %s link for the selected environment",
    async (connectionType) => {
      setup([]);
      state.relay = {
        relayUrl: "https://relay.example.test",
        enabled: true,
        hasRegistrationToken: true,
        phase: "connected",
        error: null,
      };
      const credential: AuthPairingCredentialResult = {
        id: "new-pairing-link",
        credential: "one-time-code",
        expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
      };
      const url =
        "https://relay.example.test/pair#relay=1&route=1234567890abcdef1234567890abcdef&peer=12D3KooWTestHostIdentityForRelay&token=one-time-code";
      state.create.mockResolvedValue({ _tag: "Success", value: credential });
      state.pair.mockResolvedValue({ _tag: "Success", value: { ...credential, url } });
      const onCreated = vi.fn();
      await using screen = await render(
        <AuthorizedClientsHeaderAction
          environmentId={serviceId}
          onPairingLinkCreated={onCreated}
          clientSessions={null}
          isRevokingOtherClients={false}
          onRevokeOtherClients={() => {}}
          delegatableScopes={AuthStandardClientScopes}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Create link", exact: true }));
      if (connectionType === "relay") {
        await userEvent.click(screen.getByRole("combobox", { name: "Connection type" }));
        await userEvent.click(
          screen.getByRole("option", { name: "Self-hosted relay", exact: true }),
        );
      }
      await userEvent.click(
        screen.getByRole("dialog").getByRole("button", { name: "Create link", exact: true }),
      );
      await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
      const expectedInput = {
        environmentId: serviceId,
        input: { scopes: [...AuthStandardClientScopes] },
      };
      if (connectionType === "relay") {
        expect(state.pair).toHaveBeenCalledWith(expectedInput);
        expect(state.create).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalledWith({ ...credential, url }, url);
      } else {
        expect(state.create).toHaveBeenCalledWith(expectedInput);
        expect(state.pair).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalledWith(credential, undefined);
      }
    },
  );
});
