import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn } from "storybook/test";
import { hostedMeta, SESSION, COMPUTERS, PASSKEYS } from "./fixtures";
import { settledFrame } from "./canvas";

const meta = {
  ...hostedMeta, title: "Hosted/Natural Voice",
  args: { session: SESSION, enabled: [], hostedVoice: { entitled: true, on: true } },
} satisfies Meta<typeof hostedMeta.component>;
export default meta;
type Story = StoryObj<typeof meta>;
export const On: Story = {};
export const Off: Story = { args: { hostedVoice: { entitled: true, on: false } } };
export const NoPlan: Story = { args: { hostedVoice: { entitled: false, on: true } } };
export const NotAvailable: Story = { args: { hostedVoice: { entitled: false, on: false } } };
export const RemoteUnaffected: Story = { args: { hostedVoice: { entitled: true, on: false }, computers: COMPUTERS, passkeys: PASSKEYS } };
export const ConfirmTurnOff: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await settledFrame(canvasElement);
    await canvas.user.click(canvas.getByRole("button", { name: "Turn off Natural Voice" }));
    await expect(canvas.getByRole("dialog")).toBeVisible();
    await settledFrame(canvasElement);
  },
};
export const ConfirmDark: Story = { ...ConfirmTurnOff, args: { dark: true } };
export const TurningOff: Story = {
  args: { busy: "voice-off" },
  play: async ({ canvasElement }) => {
    const canvas = await settledFrame(canvasElement);
    // A request became busy after the already-open confirmation was submitted.
    canvas.document.querySelector("dialog")!.showModal();
    await expect(canvas.getByRole("button", { name: "Turning off…" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Cancel" })).toBeDisabled();
  },
};
export const TurnedOff: Story = { args: { ...Off.args, notice: { text: "Natural Voice is off. Your computers use the system voice." } } };
export const TurnOffFailed: Story = { args: { error: { read: false, message: "Natural Voice is temporarily unavailable. Try again." } } };
export const CancelAndConfirm: Story = {
  args: { turnOffVoice: fn(async () => {}) },
  play: async ({ canvasElement, args }) => {
    const canvas = await settledFrame(canvasElement);
    await canvas.user.click(canvas.getByRole("button", { name: "Turn off Natural Voice" }));
    await canvas.user.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(canvas.queryByRole("dialog")).toBeNull();
    await expect(args.turnOffVoice).not.toHaveBeenCalled();
    await canvas.user.click(canvas.getByRole("button", { name: "Turn off Natural Voice" }));
    await canvas.user.click(canvas.getByRole("button", { name: "Turn off" }));
    await expect(args.turnOffVoice).toHaveBeenCalledOnce();
  },
};
