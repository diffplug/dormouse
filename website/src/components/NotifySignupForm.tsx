import { useEffect, useState, type FormEvent } from "react";
import { ACCENT_BORDER_CLASS, ACTION_TEXT_CLASS, FIELD_CLASS, FIELD_TEXT_CLASS, LINK_CLASS, MUTED_TEXT_CLASS } from "dormouse-lib/site/docs-tokens";
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
const MAILERLITE_PRIVACY_URL = "https://www.mailerlite.com/legal/privacy-policy";

type Status = "idle" | "sending" | "sent" | { error: string };

/** The first message MailerLite gave for a refused signup, if it gave one. */
function refusal(answer: unknown): string {
  const email = (answer as { errors?: { fields?: { email?: unknown } } } | null)?.errors?.fields?.email;
  return Array.isArray(email) && typeof email[0] === "string" ? email[0] : "That didn’t go through. Please try again.";
}

/**
 * The two surfaces this form appears on, side by side rather than as a
 * `variant ===` test per class. `site` is the marketing pages, painted in the
 * brand caramel a reader cannot retheme; `docs` sits inside `DocsLayout` and
 * follows the reader's picked theme through the docs tokens.
 */
const PALETTE = {
  site: {
    accent: "text-[var(--color-caramel)]",
    border: "border-[var(--color-caramel)]",
    background: "bg-[var(--color-caramel)]/15 hover:bg-[var(--color-caramel)]/25",
    muted: "opacity-50",
    input: "text-[var(--color-text)]/70 placeholder:opacity-50 focus:border-[var(--color-caramel)]",
    link: SITE_LINK_CLASS,
  },
  docs: {
    accent: ACTION_TEXT_CLASS,
    border: ACCENT_BORDER_CLASS,
    background: "bg-[var(--docs-accent)]/10 hover:bg-[var(--docs-accent)]/20",
    muted: MUTED_TEXT_CLASS,
    input: FIELD_TEXT_CLASS,
    link: LINK_CLASS,
  },
} as const;

export function NotifySignupForm({
  buttonLabel = "Notify me when Pocket ships",
  emailId = "notify-email",
  announcement = "the Dormouse launch",
  variant = "site",
}: {
  buttonLabel?: string;
  emailId?: string;
  announcement?: string;
  variant?: keyof typeof PALETTE;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const palette = PALETTE[variant];
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
      setStatus({ error: "Couldn’t reach MailerLite. Please try again." });
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
      <p role="status" className={`text-base leading-snug ${palette.accent}`}>
        Check your inbox: MailerLite sent {email} a link to confirm. You’re on the list once you click it.
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
        <label htmlFor={emailId} className={`font-display text-sm ${palette.muted}`}>
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
            className={`${FIELD_CLASS} sm:flex-1 ${palette.input}`}
          />
          <button
            type="submit"
            disabled={status === "sending"}
            className={`min-h-12 inline-flex items-center justify-center rounded-md border px-6 py-3 text-base font-display transition sm:w-auto ${palette.border} ${palette.background} ${palette.accent}`}
          >
            {buttonLabel}
          </button>
        </div>
      </form>
      {typeof status === "object" && (
        <p role="alert" className={`mt-3 text-base leading-snug ${palette.accent}`}>
          {status.error}
        </p>
      )}
      <p className={`mt-3 text-base leading-snug ${palette.muted}`}>
        This joins Dormouse’s email list, where I’ll announce {announcement}. MailerLite keeps the
        list and emails you a link to confirm (
        <a href={MAILERLITE_PRIVACY_URL} className={palette.link}>
          its privacy policy
        </a>
        ); you can unsubscribe any time.
      </p>
    </>
  );
}
