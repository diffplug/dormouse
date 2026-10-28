import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn } from "storybook/test";
import { hostedMeta, SESSION, NO_PLAN, FOUNDING } from "./fixtures";
import { settledFrame } from "./canvas";

const meta = {
  ...hostedMeta, title: "Hosted/Billing",
  args: { view: "billing", session: SESSION, billing: FOUNDING },
} satisfies Meta<typeof hostedMeta.component>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Back from Stripe: the durable confirmation and the founders opt-in, unticked. */
export const Confirmed: Story = { args: { confirmed: true } };
export const Returning: Story = {};
export const Phone: Story = { args: { confirmed: true, phone: true } };
export const Light: Story = { args: { confirmed: true, light: true } };
export const Monthly: Story = {
  args: { billing: { ...FOUNDING, plan: "monthly", price: 10, until: "2026-11-21T12:00:00Z", founder: { offered: false, name: null } } },
};
export const Ending: Story = { args: { billing: { ...FOUNDING, renews: false } } };
export const FounderShown: Story = { args: { billing: { ...FOUNDING, founder: { offered: true, name: "Alex" } } } };
export const NoPlan: Story = { args: { billing: NO_PLAN } };
export const ConfirmFailed: Story = { args: { billing: NO_PLAN, error: { read: false, message: "Checkout not found." } } };
export const Closed: Story = { args: { billing: "closed" } };
export const SavingFounder: Story = { args: { billing: { ...FOUNDING, founder: { offered: true, name: "Alex" } }, busy: "founder" } };
export const JoinFounders: Story = {
  args: { confirmed: true, saveFounder: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = await settledFrame(canvasElement);
    const shown = canvas.getByLabelText("Show me in the founders row on the Hosted page");
    await expect(shown).not.toBeChecked();
    await canvas.user.click(shown);
    const name = canvas.getByLabelText("Name to show");
    await expect(name).toHaveValue("Alex");
    await canvas.user.clear(name);
    await expect(canvas.getByRole("button", { name: "Save" })).toBeDisabled();
    await canvas.user.type(name, "Alex D.");
    await canvas.user.click(canvas.getByRole("button", { name: "Save" }));
    await expect(args.saveFounder).toHaveBeenCalledWith(true, "Alex D.");
    canvas.document.defaultView!.scrollTo(0, 0);
  },
};
