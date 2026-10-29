import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn } from "storybook/test";
import { providers } from "../api";
import { hostedMeta, SESSION, ACCOUNT, COMPUTERS, PASSKEYS, NO_PLAN, FOUNDING } from "./fixtures";
import { settledFrame } from "./canvas";

const meta = {
  ...hostedMeta, title: "Hosted/Account",
  args: { session: SESSION, accounts: [{ providerId: "github" }] },
} satisfies Meta<typeof hostedMeta.component>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ordinary: Story = {};
export const ProviderOnly: Story = { args: { session: { ...SESSION, user: { ...SESSION.user, email: null } } } };
export const AllProvidersConnected: Story = { args: { accounts: providers.map((providerId) => ({ providerId })) } };
export const StaleLogin: Story = { args: { fresh: false },
  play: async ({ canvasElement }) => {
    const canvas = await settledFrame(canvasElement);
    for (const button of canvas.getAllByRole("button", { name: /^Connect / })) await expect(button).toBeDisabled();
  },
};
export const ConnectingProvider: Story = { args: { busy: "google" } };
export const SigningOut: Story = { args: { busy: "logout" } };
export const EmptyServices: Story = { args: { computers: [], passkeys: [], hostedVoice: { entitled: true, on: false } } };
export const Populated: Story = { args: ACCOUNT };
export const Phone: Story = { args: { ...ACCOUNT, phone: true } };
export const ComputersUnavailable: Story = { args: { passkeys: PASSKEYS, computers: null } };
export const PasskeysUnavailable: Story = { args: { computers: COMPUTERS, passkeys: null } };
export const LongIdentity: Story = { args: {
  ...ACCOUNT,
  session: { ...SESSION, user: { ...SESSION.user, id: "account-with-a-long-immutable-identifier-for-a-provider-only-user", email: "alexandra.long-identity@example.department.example.com" } },
  passkeys: [{ ...PASSKEYS[0], label: "Personal phone with a long descriptive passkey label" }],
} };
/** A hostname is one unbroken word, up to the 64 characters Hosted keeps. */
export const LongComputerName: Story = { args: {
  ...ACCOUNT,
  phone: true,
  computers: [{ ...COMPUTERS[0], label: "build-agent-0042.eu-central-1.compute.internal.example (VS Code)" }, COMPUTERS[1]],
} };
export const RemovingComputer: Story = { args: { ...ACCOUNT, busy: `remove-${COMPUTERS[0].burrowId}` } };
export const RemovingPasskey: Story = { args: { ...ACCOUNT, busy: `passkey-${PASSKEYS[0].credentialId}` } };
export const RemovalFailed: Story = { args: { ...ACCOUNT, error: { read: false, message: "Computers and passkeys are temporarily unavailable. Try again." } } };
export const SavedButRefreshFailed: Story = { args: { ...ACCOUNT, error: { read: true, message: "Your change is saved, but this page could not reload to show it. Retry, or come back to this page later." } } };
export const RemoveActions: Story = {
  args: { ...ACCOUNT, removeOne: fn(async () => {}), removeKey: fn(async () => {}) },
  play: async ({ canvasElement, args }) => {
    const canvas = await settledFrame(canvasElement);
    await canvas.user.click(canvas.getAllByRole("button", { name: "Remove" })[0]);
    await expect(args.removeOne).toHaveBeenCalledWith(COMPUTERS[0].burrowId);
    await canvas.user.click(canvas.getAllByRole("button", { name: "Remove" })[COMPUTERS.length]);
    await expect(args.removeKey).toHaveBeenCalledWith(PASSKEYS[0].credentialId);
    canvas.document.defaultView!.scrollTo(0, 0);
  },
};
export const PlanNone: Story = { args: { ...ACCOUNT, billing: NO_PLAN } };
export const PlanFounding: Story = { args: { ...ACCOUNT, billing: FOUNDING } };
export const PlanFounderShown: Story = { args: { ...ACCOUNT, billing: { ...FOUNDING, founder: { offered: true, name: "Alex" } } } };
export const PlanEnding: Story = { args: { ...ACCOUNT, billing: { ...FOUNDING, renews: false } } };
/** A failed renewal keeps Manage billing, so the card can be fixed. */
export const PlanPaymentFailed: Story = {
  args: { ...ACCOUNT, billing: { ...FOUNDING, active: false, entitled: false, founder: { offered: false, name: null } } },
};
/** Only the `ADMIN_EMAIL` comp can stay entitled on a lapsed plan. */
export const PlanPaymentFailedAdminComp: Story = {
  args: { ...ACCOUNT, billing: { ...FOUNDING, active: false, founder: { offered: false, name: null } } },
};
export const PlanSuspended: Story = { args: { ...ACCOUNT, billing: { ...FOUNDING, entitled: false, suspended: true } } };
/** Only the `ADMIN_EMAIL` comp is entitled without a plan. */
export const PlanAdminComp: Story = { args: { ...ACCOUNT, billing: { ...NO_PLAN, entitled: true } } };
export const LapsedFounder: Story = { args: { ...ACCOUNT, billing: { ...NO_PLAN, founder: { offered: false, name: "Alex" } } } };
export const PlanPhone: Story = { args: { ...ACCOUNT, billing: FOUNDING, phone: true } };
