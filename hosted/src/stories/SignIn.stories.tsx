import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn } from "storybook/test";
import { HostedStory, frameParameters, ENROLLMENT } from "./fixtures";
import { settledFrame } from "./canvas";

const meta = {
  title: "Hosted/Sign-in", component: HostedStory,
  parameters: frameParameters,
  play: async ({ canvasElement }) => { await settledFrame(canvasElement); },
} satisfies Meta<typeof HostedStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { loading: true } };
export const ComingSoon: Story = { args: { comingSoon: true } };
export const EmailOnly: Story = { args: { enabled: [] } };
export const Providers: Story = {};
export const Phone: Story = { args: { width: 390 } };
export const Dark: Story = { args: { dark: true } };
export const CodeEntry: Story = { args: { email: "alex@example.com", enterCode: true, notice: { text: "Code sent. Check your inbox. It expires in 10 minutes." } } };
export const SendingCode: Story = { args: { email: "alex@example.com", busy: "email" } };
export const VerifyingCode: Story = { args: { email: "alex@example.com", code: "12345678", enterCode: true, busy: "verify" } };
export const OpeningProvider: Story = { args: { busy: "github" } };
export const SignedOut: Story = { args: { notice: { text: "Signed out of this browser. Your other devices stay signed in." } } };
export const CallbackFailed: Story = { args: { error: { read: false, message: "Sign-in or connection was not completed. Try again, or sign in with your existing method and connect the provider from your account." } } };
export const ConnectionFailed: Story = { args: { error: { read: true, message: "Could not connect. Check your connection and try again." }, refresh: fn(async () => {}) },
  play: async ({ canvasElement, args }) => {
    const canvas = await settledFrame(canvasElement);
    await canvas.user.click(canvas.getByRole("button", { name: "Retry connection" }));
    await expect(args.refresh).toHaveBeenCalledOnce();
  },
};
export const CodeRejected: Story = { args: { ...CodeEntry.args, error: { read: false, message: "That did not work. Check your details and try again. If connecting a provider, sign in again first." } } };
export const RateLimited: Story = { args: { error: { read: false, message: "Too many attempts. Wait a minute before trying again." } } };
export const PrelaunchRefused: Story = { args: { error: { read: false, message: "That did not work. Check your details and try again. If connecting a provider, sign in again first." } } };
export const EnrollmentEntry: Story = { args: { enrolling: ENROLLMENT } };
export const VoiceEntry: Story = { args: { enrolling: { ...ENROLLMENT, purpose: "voice" } } };
export const EnrollmentComingSoon: Story = { args: { enrolling: ENROLLMENT, comingSoon: true } };
export const EditExistingCode: Story = {
  args: { email: "alex@example.com" },
  play: async ({ canvasElement }) => {
    const canvas = await settledFrame(canvasElement);
    await canvas.user.click(canvas.getByRole("button", { name: "I already have a code" }));
    const code = canvas.getByLabelText("8-digit sign-in code");
    await canvas.user.type(code, "12a345678");
    await expect(code).toHaveValue("12345678");
    await expect(canvas.getByLabelText("Email address")).toHaveAttribute("readonly");
    await canvas.user.click(canvas.getByRole("button", { name: "Change email" }));
    await expect(canvas.queryByLabelText("8-digit sign-in code")).toBeNull();
    await expect(canvas.getByLabelText("Email address")).not.toHaveAttribute("readonly");
    await settledFrame(canvasElement);
  },
};
