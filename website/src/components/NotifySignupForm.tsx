import { useEffect, useState } from "react";
import { ACCENT_BORDER_CLASS, ACTION_TEXT_CLASS, LINK_CLASS, MUTED_TEXT_CLASS } from "./docs-tokens";
import { SITE_LINK_CLASS } from "./site-tokens";

const EMAIL_STORAGE_PREFIX = "dormouse:notify-email:";
const SUBSCRIBE_URL = "https://nedshed.dev/subscribe";

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
    input: "text-[var(--color-text)] placeholder:text-[var(--docs-text-muted)] focus:border-[var(--docs-accent)]",
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
  const palette = PALETTE[variant];
  const storageKey = `${EMAIL_STORAGE_PREFIX}${emailId}`;

  useEffect(() => {
    try {
      setEmail(sessionStorage.getItem(storageKey) ?? "");
    } catch {
      // Storage can be disabled; the ordinary form remains fully functional.
    }
  }, [storageKey]);

  return (
    <>
      <form
        action={SUBSCRIBE_URL}
        method="get"
        className="flex flex-col gap-2"
      >
        <label htmlFor={emailId} className={`font-display text-sm ${palette.muted}`}>
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
                sessionStorage.setItem(storageKey, next);
              } catch {
                // Storage can be disabled; React state still owns this visit.
              }
            }}
            placeholder="you@example.com"
            required
            autoComplete="email"
            className={`min-h-12 w-full rounded-md border border-[var(--color-text)]/50 bg-[var(--color-bg)] px-4 py-3 text-base focus:outline-none sm:flex-1 ${palette.input}`}
          />
          <button
            type="submit"
            className={`min-h-12 inline-flex items-center justify-center rounded-md border px-6 py-3 text-base font-display transition sm:w-auto ${palette.border} ${palette.background} ${palette.accent}`}
          >
            {buttonLabel}
          </button>
        </div>
      </form>
      <p className={`mt-3 text-base leading-snug ${palette.muted}`}>
        One more step on Substack. This signs you up for my personal devlog{" "}
        <a
          href="https://nedshed.dev"
          className={palette.link}
        >
          nedshed.dev
        </a>{" "}
        and I’ll announce {announcement} there; you can unsubscribe any time.
      </p>
    </>
  );
}
