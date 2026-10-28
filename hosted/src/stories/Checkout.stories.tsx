import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn } from "storybook/test";
import { hostedMeta, SESSION, NO_PLAN, FOUNDING } from "./fixtures";
import { settledFrame } from "./canvas";

const meta = {
  ...hostedMeta, title: "Hosted/Checkout",
  args: { view: "checkout", session: SESSION, billing: NO_PLAN },
} satisfies Meta<typeof hostedMeta.component>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Founding: Story = {};
export const Yearly: Story = { args: { checkoutPlan: "yearly" } };
export const Monthly: Story = { args: { checkoutPlan: "monthly" } };
/** Past the ladder's last step, founding is off sale. */
export const FoundingClosed: Story = { args: { billing: { ...NO_PLAN, founding: null } } };
export const Phone: Story = { args: { phone: true } };
export const Light: Story = { args: { light: true } };
export const SignedOut: Story = { args: { session: null, billing: null } };
export const Closed: Story = { args: { billing: "closed" } };
export const Unavailable: Story = { args: { billing: null } };
export const AlreadySubscribed: Story = { args: { billing: FOUNDING } };
export const Opening: Story = { args: { busy: "checkout" } };
export const Refused: Story = { args: { error: { read: false, message: "The terms have changed. Reload this page to read them." } } };
/** The purchase action stays off until both agreements are ticked. */
export const Agreeing: Story = {
  args: { purchase: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = await settledFrame(canvasElement);
    const pay = canvas.getByRole("button", { name: "Continue to payment" });
    await expect(pay).toBeDisabled();
    await canvas.user.click(canvas.getByLabelText(/I agree to the/));
    await expect(pay).toBeDisabled();
    await canvas.user.click(canvas.getByLabelText(/renews automatically/));
    await canvas.user.click(pay);
    await expect(args.purchase).toHaveBeenCalledWith("founding");
    canvas.document.defaultView!.scrollTo(0, 0);
  },
};
