import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn } from "storybook/test";
import { HostedStory, frameParameters, SESSION, ACCOUNT, COMPUTERS, PASSKEYS } from "./fixtures";
import { settledFrame } from "./canvas";

const meta = {
  title: "Hosted/Account", component: HostedStory, parameters: frameParameters,
  args: { session: SESSION, accounts: [{ providerId: "github" }] },
  play: async ({ canvasElement }) => { await settledFrame(canvasElement); },
} satisfies Meta<typeof HostedStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ordinary: Story = {};
export const ProviderOnly: Story = { args: { session: { ...SESSION, user: { ...SESSION.user, email: null } } } };
export const AllProvidersConnected: Story = { args: { accounts: ["github", "google", "microsoft", "apple"].map(providerId => ({ providerId })) } };
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
export const Phone: Story = { args: { ...ACCOUNT, width: 390 } };
export const ComputersUnavailable: Story = { args: { passkeys: PASSKEYS, computers: null } };
export const PasskeysUnavailable: Story = { args: { computers: COMPUTERS, passkeys: null } };
export const LongIdentity: Story = { args: {
  ...ACCOUNT,
  session: { ...SESSION, user: { ...SESSION.user, id: "account-with-a-long-immutable-identifier-for-a-provider-only-user", email: "alexandra.long-identity@example.department.example.com" } },
  passkeys: [{ ...PASSKEYS[0], label: "Personal phone with a long descriptive passkey label" }],
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
