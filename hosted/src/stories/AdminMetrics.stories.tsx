import type { Meta, StoryObj } from "@storybook/react";
import type { AdminMetricsBody, MetricRow } from "../../server/metric-labels";
import { AdminMetricsPage, type AdminMetricsState } from "../AdminMetrics";
import { HostedFrame } from "./HostedFrame";
import { settledFrame } from "./canvas";

const TODAY = "2026-10-28";
const day = (back: number) => {
  const date = new Date(`${TODAY}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
};

/** A launch month: counts that grow toward today, a quiet weekend, a day with none. */
const recent: MetricRow[] = Array.from({ length: 30 }, (_, i) => 29 - i).flatMap((back): MetricRow[] => {
  const grown = 30 - back;
  if (back === 12) return [];
  return [
    { day: day(back), event: "enroll.approved", label: "remote", count: 1 + (grown % 4) },
    ...(back % 3 === 0 ? [{ day: day(back), event: "enroll.approved" as const, label: "voice", count: 1 }] : []),
    { day: day(back), event: "burrow.enrolled", label: "", count: 1 + (grown % 3) },
    { day: day(back), event: "voice.speak", label: "ok", count: grown * 9 },
    ...(back < 6 ? [{ day: day(back), event: "voice.speak" as const, label: "capped", count: 6 - back }] : []),
    ...(back === 20 ? [{ day: day(back), event: "voice.speak" as const, label: "error", count: 14 }] : []),
    ...(back < 6 ? [{ day: day(back), event: "voice.fallback-cap" as const, label: "", count: 1 }] : []),
    { day: day(back), event: "push.sent", label: "", count: grown * 31 + (back % 7 < 2 ? 0 : 40) },
    { day: day(back), event: "pocket.signin", label: "", count: Math.ceil(grown / 2) },
  ];
});
const totals = Object.values(
  recent.reduce<Record<string, Omit<MetricRow, "day">>>((sums, { event, label, count }) => {
    const key = `${event}/${label}`;
    sums[key] = { event, label, count: (sums[key]?.count ?? 0) + count * 2 };
    return sums;
  }, {}),
);
const BODY: AdminMetricsBody = { days: 30, today: TODAY, recent, totals };

function AdminMetricsStory({ state, phone, light }: { state: AdminMetricsState; phone?: boolean; light?: boolean }) {
  return (
    <HostedFrame phone={phone} light={light}>
      <AdminMetricsPage state={state} retry={() => {}} />
    </HostedFrame>
  );
}

const meta = {
  title: "Hosted/Admin metrics",
  component: AdminMetricsStory,
  parameters: { layout: "fullscreen" },
  args: { state: { kind: "ok", body: BODY } },
  play: async ({ canvasElement }) => {
    await settledFrame(canvasElement);
  },
} satisfies Meta<typeof AdminMetricsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Counts: Story = {};
export const Phone: Story = { args: { phone: true } };
export const Light: Story = { args: { light: true } };
export const NothingCounted: Story = { args: { state: { kind: "ok", body: { ...BODY, recent: [], totals: [] } } } };
export const Loading: Story = { args: { state: { kind: "loading" } } };
export const SignedOut: Story = { args: { state: { kind: "signed-out" } } };
export const NotFound: Story = { args: { state: { kind: "not-found" } } };
export const Unavailable: Story = { args: { state: { kind: "failed", message: "Metrics are temporarily unavailable. Try again." } } };
