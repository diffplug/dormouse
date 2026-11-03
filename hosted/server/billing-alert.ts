// Rules: docs/specs/hosted.md -> "Billing alert".
import { escape } from "@pgstencil/auth/email";
import { SystemTime, type EmailMessage, type EmailSender, type Time } from "pgstencil";
import { queryDatabase } from "pgstencil/postgres";
import { SUPPORT_EMAIL } from "../../website/src/lib/hosted-withdrawal";

/** A failure that says a promised acknowledgement or settlement is overdue; the alert leads with these. */
export class BillingOverdue extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A line mailed this recently is not a reason to mail again. */
const ALERT_EVERY_MS = DAY_MS;
/** One send attempt holds its lines this long, under the cron's period, so a failed send is retried on the next run. */
const LEASE_MS = 5 * 60 * 1000;
/** The account cron's period (`hosted/wrangler.jsonc`): without the table, only the run in the day's first such window mails. */
const CRON_PERIOD_MS = 10 * 60 * 1000;
/** How many lines one mail carries, and how long each may be. */
const MAX_LINES = 50;
const MAX_LINE_CHARS = 500;

/**
 * A failure's text with what must never reach a mailbox masked: Stripe and
 * webhook keys, which Stripe's own auth errors quote in part, connection URLs,
 * which carry a password, and any whole token shaped like a card number.
 * Stripe and invoice ids, UUIDs, and amounts stay: they are what the operator
 * acts on.
 */
function scrubbed(text: string): string {
  return text
    .replace(/\b(?:sk|rk|whsec)_[\w*]+/g, "[secret]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/]*:[^\s/]*@\S*/gi, "[connection url]")
    .replace(/(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g, "[number]")
    .slice(0, MAX_LINE_CHARS);
}

interface AlertLine {
  text: string;
  overdue: boolean;
}

/**
 * The distinct lines `failure` carries, overdue ones first, each from a
 * message alone, never a stack or a cause. An `AggregateError` is its errors.
 */
export function alertLines(failure: unknown): AlertLine[] {
  const leaves = (error: unknown): unknown[] => (error instanceof AggregateError ? error.errors.flatMap(leaves) : [error]);
  const lines = new Map<string, AlertLine>();
  for (const leaf of leaves(failure)) {
    const text = scrubbed(leaf instanceof Error ? leaf.message : String(leaf));
    if (!lines.has(text)) lines.set(text, { text, overdue: leaf instanceof BillingOverdue });
  }
  return [...lines.values()].sort((a, b) => Number(b.overdue) - Number(a.overdue));
}

const fingerprint = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

function alertMessage(lines: readonly AlertLine[], now: Date, recorded: boolean): EmailMessage {
  const shown = lines.slice(0, MAX_LINES);
  const overdue = shown.filter((line) => line.overdue).map((line) => line.text);
  const errors = shown.filter((line) => !line.overdue).map((line) => line.text);
  const sections = [
    ...(overdue.length ? [["Overdue", overdue] as const] : []),
    ...(errors.length ? [["Errors", errors] as const] : []),
  ];
  const paragraphs = [
    `The account Worker's billing cron failed at ${now.toISOString()}. It tries again every 10 minutes; each distinct error is mailed at most once a day.`,
    ...(lines.length > shown.length ? [`${lines.length - shown.length} more are not listed here.`] : []),
    ...(recorded ? [] : ["The database could not be reached to limit this alert, so it goes in the day's first run only."]),
    `What to do: hosted/README.md -> "Billing alert".`,
  ];
  return {
    from: `Dormouse Hosted <${SUPPORT_EMAIL}>`,
    to: [SUPPORT_EMAIL],
    subject: overdue.length ? `Dormouse Hosted billing: ${overdue.length} overdue, cron failing` : "Dormouse Hosted billing: cron failing",
    text: [
      paragraphs[0],
      ...sections.map(([title, items]) => `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`),
      ...paragraphs.slice(1),
    ].join("\n\n"),
    html: `<html lang="en"><body><p>${escape(paragraphs[0]!)}</p>${sections
      .map(([title, items]) => `<h2>${title}</h2><ul>${items.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`)
      .join("")}${paragraphs
      .slice(1)
      .map((paragraph) => `<p>${escape(paragraph)}</p>`)
      .join("")}</body></html>`,
  };
}

/**
 * Mails `failure`'s lines to support when any has not gone out in the last
 * {@link ALERT_EVERY_MS}. The lines are leased in the statement that decides,
 * and stamped only once the mail is accepted. Without the table, the day's
 * first run mails. Throws when it cannot send; the caller keeps its failure.
 */
export async function alertBillingFailure(
  failure: unknown,
  databaseUrl: string,
  mail: () => EmailSender,
  time: Time = new SystemTime(),
) {
  const now = time.now();
  const lines = alertLines(failure);
  const fingerprints = await Promise.all(lines.map((line) => fingerprint(line.text)));
  let due: boolean;
  let recorded = true;
  try {
    const claimed = await queryDatabase(
      databaseUrl,
      `INSERT INTO dormouse_billing_alerts AS a (fingerprint, "attemptedAt")
      SELECT unnest($1::text[]), $2::timestamptz
      ON CONFLICT (fingerprint) DO UPDATE SET "attemptedAt" = EXCLUDED."attemptedAt"
      WHERE (a."sentAt" IS NULL OR a."sentAt" <= $3::timestamptz) AND a."attemptedAt" <= $4::timestamptz
      RETURNING fingerprint`,
      [fingerprints, now, new Date(now.getTime() - ALERT_EVERY_MS), new Date(now.getTime() - LEASE_MS)],
    );
    due = claimed.length > 0;
  } catch (error) {
    console.error("The billing alert could not read its record", error);
    recorded = false;
    due = now.getTime() % DAY_MS < CRON_PERIOD_MS;
  }
  if (!due) return;
  await mail().send(alertMessage(lines, now, recorded));
  if (recorded)
    await queryDatabase(
      databaseUrl,
      `WITH stale AS (
        DELETE FROM dormouse_billing_alerts WHERE GREATEST("attemptedAt", "sentAt") <= $3::timestamptz)
      UPDATE dormouse_billing_alerts SET "sentAt" = $2::timestamptz WHERE fingerprint = ANY ($1::text[])`,
      [fingerprints, now, new Date(now.getTime() - 2 * ALERT_EVERY_MS)],
    );
}
