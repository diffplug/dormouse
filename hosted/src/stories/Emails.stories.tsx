import type { Meta, StoryObj } from "@storybook/react";
import type { PriceCatalog } from "../../server/billing";
import { alertMessage } from "../../server/billing-alert-message";
import { noticeMessage, type Kind, type NoticeContext, type Pending } from "../../server/notice-message";
import type { Plan } from "../../server/policy-constants";
import { EmailFrame } from "./EmailFrame";
import { signInEmail } from "./email-fixtures";

/**
 * Every email Hosted sends, one representative each. A new billing notice
 * fails to compile until `EVERY_NOTICE` names its story; any other new email
 * gets a story here in the same change.
 */
const meta = {
  title: "Hosted/Emails",
  component: EmailFrame,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EmailFrame>;
export default meta;
type Story = StoryObj<typeof meta>;

const CONTEXT: NoticeContext = {
  origin: "https://hosted.dormouse.sh",
  catalog: {
    prices: new Map([
      ["price_founding", { plan: "founding", usd: 50 }],
      ["price_yearly", { plan: "yearly", usd: 100 }],
      ["price_monthly", { plan: "monthly", usd: 10 }],
    ]),
    usable: [{
      id: "yearly-2028",
      plan: "yearly",
      fromPriceId: "price_yearly",
      toPriceId: "price_yearly_2028",
      fromUsd: 100,
      toUsd: 120,
      effectiveAt: new Date("2028-01-01T00:00:00Z"),
    }],
  } as unknown as PriceCatalog,
};

const BLANK: Omit<Pending, "kind"> = {
  id: "notice",
  userId: "user",
  renewsAt: new Date("2028-03-01T00:00:00Z"),
  priceId: null,
  priceChangeId: null,
  withdrawalId: null,
  withdrawalPlan: null,
  contractStartedAt: null,
  submittedAt: null,
  consentPlan: null,
  shownUsd: null,
  termsVersion: null,
  consentedAt: null,
};

const notice = (kind: Kind, plan: Plan | null, fields: Partial<Pending> = {}): Story => ({
  args: noticeMessage("buyer@example.test", { ...BLANK, ...fields, kind }, plan, CONTEXT),
});

export const Purchase = notice("purchase", "founding", {
  consentPlan: "founding",
  shownUsd: 50,
  termsVersion: "2026-10-30",
  consentedAt: new Date("2027-03-01T17:30:00Z"),
});
export const Renewal = notice("renewal", "founding", { priceId: "price_founding" });
export const AnnualReminder = notice("annual", "monthly", { priceId: "price_monthly" });
export const PriceChange = notice("price_change", "yearly", { priceId: "price_yearly", priceChangeId: "yearly-2028" });
export const DisputeSuspended = notice("dispute_suspended", null);
export const DisputeRestored = notice("dispute_restored", null);
export const Withdrawal = notice("withdrawal", "founding", {
  withdrawalId: "e7a40e59-bc8d-404c-b29c-5a32b0c40bef",
  withdrawalPlan: "founding",
  contractStartedAt: new Date("2027-03-01T17:30:00Z"),
  submittedAt: new Date("2027-03-05T09:12:00Z"),
});
export const SignInCode: Story = { args: signInEmail("buyer@example.test", "12345678") };
/** To the operator, not a customer. */
export const BillingAlert: Story = {
  args: alertMessage(
    [
      { text: "Withdrawal e7a40e59-bc8d-404c-b29c-5a32b0c40bef: submitted 2027-03-05, its refund is due by 2027-03-19", overdue: true },
      { text: "Withdrawal e7a40e59-bc8d-404c-b29c-5a32b0c40bef: paid outside Stripe, refund by hand, then mark it settled: invoice in_123 (1190 of 1190 usd)", overdue: false },
    ],
    new Date("2027-03-06T12:00:00Z"),
    true,
  ),
};

const EVERY_NOTICE = {
  purchase: Purchase,
  renewal: Renewal,
  annual: AnnualReminder,
  price_change: PriceChange,
  dispute_suspended: DisputeSuspended,
  dispute_restored: DisputeRestored,
  withdrawal: Withdrawal,
} satisfies Record<Kind, Story>;
void EVERY_NOTICE;
