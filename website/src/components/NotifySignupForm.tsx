import { useEffect, useState, type FormEvent } from "react";
import { LINK_CLASS, MUTED_TEXT_CLASS } from "./docs-tokens";
import { SITE_LINK_CLASS } from "./site-tokens";

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const EMAIL_STORAGE_PREFIX = "dormouse:notify-email:";
const SUBSCRIBE_URL = "https://nedshed.dev/subscribe";

export function NotifySignupForm({
  buttonLabel = "Notify me when Pocket ships",
  emailId = "notify-email",
  announcement = "the Dormouse launch",
  variant = "site",
}: {
  buttonLabel?: string;
  emailId?: string;
  announcement?: string;
  variant?: "site" | "docs";
}) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const accentClass = variant === "docs" ? "text-[var(--docs-accent)]" : "text-[var(--color-caramel)]";
  const accentBorderClass = variant === "docs" ? "border-[var(--docs-accent)]" : "border-[var(--color-caramel)]";
  const accentBackgroundClass = variant === "docs"
    ? "bg-[var(--docs-accent)]/10 hover:bg-[var(--docs-accent)]/20"
    : "bg-[var(--color-caramel)]/15 hover:bg-[var(--color-caramel)]/25";
  const mutedClass = variant === "docs" ? MUTED_TEXT_CLASS : "opacity-50";

  useEffect(() => {
    try {
      setEmail(sessionStorage.getItem(`${EMAIL_STORAGE_PREFIX}${emailId}`) ?? "");
    } catch {
      // Storage can be disabled; the ordinary form remains fully functional.
    }
  }, [emailId]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    if (!EMAIL_REGEX.test(email)) {
      e.preventDefault();
      setMessage("Please enter a valid email");
    }
  }

  return (
    <>
      <form
        action={SUBSCRIBE_URL}
        method="get"
        onSubmit={handleSubmit}
        className="flex flex-col gap-2"
      >
        <label htmlFor={emailId} className={`font-display text-sm ${mutedClass}`}>
          Email
        </label>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <input
            id={emailId}
            type="email"
            name="email"
            value={email}
            onChange={(e) => {
              const next = e.target.value;
              setEmail(next);
              try {
                sessionStorage.setItem(`${EMAIL_STORAGE_PREFIX}${emailId}`, next);
              } catch {
                // Storage can be disabled; React state still owns this visit.
              }
              if (message) setMessage("");
            }}
            placeholder="you@example.com"
            required
            autoComplete="email"
            className={`min-h-12 w-full rounded-md border border-[var(--color-text)]/50 bg-[var(--color-bg)] px-4 py-3 text-base focus:outline-none sm:flex-1 ${
              variant === "docs"
                ? "text-[var(--color-text)] placeholder:text-[var(--docs-text-muted)] focus:border-[var(--docs-accent)]"
                : "text-[var(--color-text)]/70 placeholder:opacity-50 focus:border-[var(--color-caramel)]"
            }`}
          />
          <button
            type="submit"
            className={`min-h-12 inline-flex items-center justify-center rounded-md border px-6 py-3 text-base font-display transition sm:w-auto ${accentBorderClass} ${accentBackgroundClass} ${accentClass}`}
          >
            {buttonLabel}
          </button>
        </div>
        {message && (
          <p className="text-sm text-red-400" role="alert">
            {message}
          </p>
        )}
      </form>
      <p className={`mt-3 text-base leading-snug ${mutedClass}`}>
        One more step on Substack. This signs you up for my personal devlog{" "}
        <a
          href="https://nedshed.dev"
          className={variant === "docs" ? LINK_CLASS : SITE_LINK_CLASS}
        >
          nedshed.dev
        </a>{" "}
        on Substack. I’ll announce {announcement} there; you can unsubscribe any time.
      </p>
    </>
  );
}
