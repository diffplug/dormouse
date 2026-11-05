// The text of the billing alert, apart from the database and mail that send it,
// so `hosted/src/stories/Emails.stories.tsx` can show it.
// Rules: docs/specs/hosted.md -> "Billing alert".
import { escape } from "@pgstencil/auth/email";
import type { EmailMessage } from "pgstencil";
import { SUPPORT_EMAIL } from "../../website/src/lib/hosted-withdrawal";
import { NOTICE_FROM } from "./notice-message";

/** How many lines one mail carries. */
const MAX_LINES = 50;

export interface AlertLine {
  text: string;
  overdue: boolean;
}

export function alertMessage(lines: readonly AlertLine[], now: Date, recorded: boolean): EmailMessage {
  const shown = lines.slice(0, MAX_LINES);
  const overdue = shown.filter((line) => line.overdue).map((line) => line.text);
  const errors = shown.filter((line) => !line.overdue).map((line) => line.text);
  const sections = [
    ...(overdue.length ? [["Overdue", overdue] as const] : []),
    ...(errors.length ? [["Errors", errors] as const] : []),
  ];
  const intro = `The account Worker's billing cron failed at ${now.toISOString()}. It tries again every 10 minutes; each distinct error is mailed at most once a day.`;
  const notes = [
    ...(lines.length > shown.length ? [`${lines.length - shown.length} more are not listed here.`] : []),
    ...(recorded ? [] : ["The database could not be reached to limit this alert, so it goes in the day's first run only."]),
    `What to do: hosted/README.md -> "Billing alert".`,
  ];
  return {
    from: NOTICE_FROM,
    to: [SUPPORT_EMAIL],
    subject: overdue.length ? `Dormouse Hosted billing: ${overdue.length} overdue, cron failing` : "Dormouse Hosted billing: cron failing",
    text: [intro, ...sections.map(([title, items]) => `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`), ...notes].join("\n\n"),
    html: `<html lang="en"><body><p>${escape(intro)}</p>${sections
      .map(([title, items]) => `<h2>${title}</h2><ul>${items.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`)
      .join("")}${notes.map((note) => `<p>${escape(note)}</p>`).join("")}</body></html>`,
  };
}
