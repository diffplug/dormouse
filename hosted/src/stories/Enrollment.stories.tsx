import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn } from "storybook/test";
import { hostedMeta, SESSION, ACCOUNT, ENROLLMENT, NO_PLAN } from "./fixtures";
import { settledFrame } from "./canvas";

const meta = {
  ...hostedMeta, title: "Hosted/Enrollment",
  args: { session: SESSION, enrolling: ENROLLMENT },
} satisfies Meta<typeof hostedMeta.component>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Remote: Story = {};
export const Voice: Story = { args: { enrolling: { ...ENROLLMENT, purpose: "voice" } } };
export const StaleRemote: Story = { args: { fresh: false } };
export const StaleVoice: Story = { args: { ...Voice.args, fresh: false } };
export const NoPlan: Story = {
  args: { noPlan: true, signOut: fn(async () => {}) },
  play: async ({ canvasElement, args }) => {
    const canvas = await settledFrame(canvasElement);
    await expect(canvas.queryByLabelText("Type the two digits Dormouse is showing")).toBeNull();
    await canvas.user.click(canvas.getByRole("button", { name: "Use another account" }));
    await expect(args.signOut).toHaveBeenCalledOnce();
  },
};
export const NoPlanVoice: Story = { args: { ...Voice.args, noPlan: true } };
/** Billing open: the plans link opens checkout on this origin, in another tab. */
export const NoPlanCheckoutOpen: Story = {
  args: { noPlan: true, billing: NO_PLAN },
  play: async ({ canvasElement }) => {
    const canvas = await settledFrame(canvasElement);
    await expect(canvas.getByRole("link", { name: "See Hosted plans" })).toHaveAttribute("href", "/checkout?ref=hosted-no-plan");
  },
};
export const InvalidLink: Story = { args: { enrolling: { code: null } } };
export const InvalidLinkSignedOut: Story = { args: { session: null, enrolling: { code: null } } };
export const Approving: Story = { args: { busy: "approve" } };
export const ApprovingVoice: Story = { args: { ...Voice.args, busy: "approve" } };
export const ApprovalRefused: Story = { args: { error: { read: false, message: "That code is already approved." } } };
export const RefusedLight: Story = { args: { ...ApprovalRefused.args, light: true } };
export const ConfirmDigits: Story = {
  args: { approve: fn(async () => {}) },
  play: async ({ canvasElement, args }) => {
    const canvas = await settledFrame(canvasElement);
    const button = canvas.getByRole("button", { name: "Approve" });
    await expect(button).toBeDisabled();
    const digits = canvas.getByLabelText("Type the two digits Dormouse is showing");
    await canvas.user.type(digits, "4x");
    await expect(digits).toHaveValue("4");
    await expect(button).toBeDisabled();
    await canvas.user.type(digits, "7");
    await expect(button).toBeEnabled();
    await canvas.user.click(button);
    await expect(args.approve).toHaveBeenCalledWith(ENROLLMENT.code, "47");
  },
};
export const CancelApproval: Story = {
  args: { clearEnrollment: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = await settledFrame(canvasElement);
    await canvas.user.click(canvas.getByRole("button", { name: "Don’t approve" }));
    await expect(args.clearEnrollment).toHaveBeenCalledOnce();
  },
};
const account = { ...ACCOUNT, enrolling: null };
export const RemoteWaiting: Story = { args: { ...account, notice: { text: "Approved 7KQM-X4TD. Waiting for Dormouse on your computer to finish enrolling…" } } };
export const VoiceWaiting: Story = { args: { ...account, hostedVoice: { entitled: true, on: false }, notice: { text: "Approved 7KQM-X4TD. Waiting for Dormouse on your computer to turn on Natural Voice…" } } };
export const RemoteComplete: Story = { args: { ...account, notice: { text: "Your computer is enrolled." } } };
export const VoiceComplete: Story = { args: { ...account, hostedVoice: { entitled: true, on: true }, notice: { text: "Natural Voice is on." } } };
export const RemoteDelayed: Story = { args: { ...account, notice: { text: "Approved 7KQM-X4TD, but Dormouse on your computer has not finished enrolling yet. Keep Dormouse open on your computer; this page updates when you come back to it." } } };
export const VoiceDelayed: Story = { args: { ...account, notice: { text: "Approved 7KQM-X4TD, but Dormouse on your computer has not turned on Natural Voice yet. Keep Dormouse open on your computer; this page updates when you come back to it." } } };
export const Mismatch: Story = { args: { ...account, notice: { error: true, text: "The digits you typed for 7KQM-X4TD were not the ones Dormouse showed on your computer, so nothing was approved. Start again from Dormouse on your computer." } } };
