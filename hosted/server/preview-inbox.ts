import { queryDatabase } from "pgstencil/postgres";
import type { EmailMessage, EmailSender } from "pgstencil";
import { escape } from "@pgstencil/auth/email";

export interface InboxMessage extends EmailMessage {
  id: string;
  capturedAt: string;
}

// Each operation closes its pool; mail survives Worker isolate replacement.
export function postgresInbox(url: string): EmailSender & {
  all(): Promise<InboxMessage[]>;
  get(id: string): Promise<InboxMessage | undefined>;
} {
  const read = async (id?: string) => {
    const rows = await queryDatabase<{
      id: string;
      captured_at: Date;
      message: EmailMessage;
    }>(
      url,
      `SELECT id, captured_at, message FROM preview.email_messages
      WHERE captured_at > now() - interval '24 hours'
      ${id ? "AND id = $1" : ""} ORDER BY id DESC LIMIT 100`,
      id ? [id] : [],
    );
    return rows.map((row) => ({
      ...row.message,
      id: row.id,
      capturedAt: row.captured_at.toISOString(),
    }));
  };
  return {
    async send(message) {
      await queryDatabase(
        url,
        `WITH expired AS (
        DELETE FROM preview.email_messages WHERE captured_at <= now() - interval '24 hours'
      ) INSERT INTO preview.email_messages (message) VALUES ($1::jsonb)`,
        [JSON.stringify(message)],
      );
    },
    all: () => read(),
    get: async (id) => (await read(id))[0],
  };
}

function page(body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview inbox · Dormouse</title></head><body><main>${body}</main></body></html>`;
}
export function inboxPage(messages: InboxMessage[]) {
  return page(
    `<h1>Preview inbox</h1><p>Public test inbox for this PR. Use disposable addresses. Nothing is sent to a real mailbox. Latest 100 messages from the last 24 hours.</p><nav><a href="/">Sign in</a> · <a href="/dev/emails">Refresh inbox</a></nav><ol>${messages.map((mail) => `<li><a href="/dev/emails/${mail.id}">${escape(mail.subject)}</a> — ${escape(mail.to.join(", "))} — ${escape(mail.capturedAt)}</li>`).join("")}</ol>`,
  );
}
export function messagePage(mail: InboxMessage) {
  // Render escaped text only: never execute captured HTML or email links.
  return page(
    `<a href="/dev/emails">Back to inbox</a><h1>${escape(mail.subject)}</h1><p>To ${escape(mail.to.join(", "))}</p><pre>${escape(mail.text)}</pre>`,
  );
}
