import { useEffect, useState, type FormEvent } from "react";
import { FIELD_CLASS } from "dormouse-lib/site/docs-tokens";
import { sitePath } from "../lib/site-meta";
import { SITE_LINK_CLASS } from "./site-tokens";

const EMAIL_STORAGE_PREFIX = "dormouse:notify-email:";
/**
 * The MailerLite embedded form "Dormouse signup", which adds to the "Dormouse"
 * group with double opt-in: MailerLite emails the confirmation link, since
 * this site cannot verify consent itself. Its field names and the two hidden
 * inputs are the ones MailerLite's own embed code posts. It answers JSON, so a
 * submit without JavaScript still subscribes but lands on that JSON.
 */
const SUBSCRIBE_URL = "https://assets.mailerlite.com/jsonp/2773191/forms/203349323128243736/subscribe";
const EMAIL_FIELD = "fields[email]";
const HIDDEN_FIELDS = { "ml-submit": "1", anticsrf: "true" } as const;

type Status = "idle" | "sending" | "sent" | { error: string };

/** The first message MailerLite gave for a refused signup, if it gave one. */
function refusal(answer: unknown): string {
  const email = (answer as { errors?: { fields?: { email?: unknown } } } | null)?.errors?.fields?.email;
  return Array.isArray(email) && typeof email[0] === "string" ? email[0] : "That didn’t go through. Please try again.";
}

/** The marketing pages' brand caramel, which a reader cannot retheme. */
const PALETTE = {
  accent: "text-[var(--color-caramel)]",
  border: "border-[var(--color-caramel)]",
  background: "bg-[var(--color-caramel)]/15 hover:bg-[var(--color-caramel)]/25",
  muted: "opacity-50",
  input: "text-[var(--color-text)]/70 placeholder:opacity-50 focus:border-[var(--color-caramel)]",
  link: SITE_LINK_CLASS,
} as const;

export function NotifySignupForm({
  buttonLabel = "Notify me when Pocket ships",
  emailId = "notify-email",
  announcement = "the Dormouse launch",
}: {
  buttonLabel?: string;
  emailId?: string;
  announcement?: string;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const storageKey = `${EMAIL_STORAGE_PREFIX}${emailId}`;

  useEffect(() => {
    try {
      setEmail(sessionStorage.getItem(storageKey) ?? "");
    } catch {
      // Storage can be disabled; the ordinary form remains fully functional.
    }
  }, [storageKey]);

  // With JavaScript the page stays put and says what happens next; the
  // endpoint answers any origin, and a form-encoded body needs no preflight.
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("sending");
    try {
      const response = await fetch(SUBSCRIBE_URL, {
        method: "POST",
        body: new URLSearchParams({ [EMAIL_FIELD]: email, ...HIDDEN_FIELDS }),
      });
      const answer: unknown = await response.json();
      if ((answer as { success?: unknown } | null)?.success !== true) {
        setStatus({ error: refusal(answer) });
        return;
      }
    } catch {
      setStatus({ error: "Couldn’t sign you up just now. Please try again." });
      return;
    }
    setStatus("sent");
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // Storage can be disabled; nothing was kept.
    }
  };

  if (status === "sent")
    return (
      <p role="status" className={`text-base leading-snug ${PALETTE.accent}`}>
        Check your inbox. Click the link we sent to {email} and you’re on the list.
      </p>
    );

  return (
    <>
      <form
        action={SUBSCRIBE_URL}
        method="post"
        onSubmit={submit}
        className="flex flex-col gap-2"
      >
        {Object.entries(HIDDEN_FIELDS).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <label htmlFor={emailId} className={`font-display text-sm ${PALETTE.muted}`}>
          Email
        </label>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <input
            id={emailId}
            type="email"
            name={EMAIL_FIELD}
            value={email}
            onChange={(e) => {
              const next = e.target.value;
              setEmail(next);
              try {
                sessionStorage.setItem(storageKey, next);
              } catch {
                // Storage can be disabled; React state still owns this visit.
              }
            }}
            placeholder="you@example.com"
            required
            autoComplete="email"
            className={`${FIELD_CLASS} sm:flex-1 ${PALETTE.input}`}
          />
          <button
            type="submit"
            disabled={status === "sending"}
            className={`min-h-12 inline-flex items-center justify-center rounded-md border px-6 py-3 text-base font-display transition sm:w-auto ${PALETTE.border} ${PALETTE.background} ${PALETTE.accent}`}
          >
            {buttonLabel}
          </button>
        </div>
      </form>
      {typeof status === "object" && (
        <p role="alert" className={`mt-3 text-base leading-snug ${PALETTE.accent}`}>
          {status.error}
        </p>
      )}
      <p className={`mt-3 text-base leading-snug ${PALETTE.muted}`}>
        This joins Dormouse’s email list, where I’ll announce {announcement}. You’ll get one email to
        confirm, and you can unsubscribe any time (
        <a href={sitePath("/privacy")} className={PALETTE.link}>
          privacy policy
        </a>
        ).
      </p>
    </>
  );
}
