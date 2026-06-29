import { useState, type FormEvent } from "react";
import { CircleNotchIcon } from "@phosphor-icons/react";

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function NotifySignupForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [redirecting, setRedirecting] = useState(false);

  const redirectUrl = `https://nedshed.dev/subscribe?email=${encodeURIComponent(email)}`;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!EMAIL_REGEX.test(email)) {
      setMessage("Please enter a valid email");
      return;
    }
    setRedirecting(true);
    window.setTimeout(() => {
      window.location.href = redirectUrl;
    }, 3000);
  }

  if (redirecting) {
    return (
      <div className="flex items-center gap-3 text-lg leading-relaxed text-[var(--color-caramel)]">
        <CircleNotchIcon className="shrink-0 animate-spin" size={28} weight="bold" />
        <p>
          Just one more click! Hit <span className="text-[var(--color-text)]/70">subscribe</span> after{" "}
          <a
            href={redirectUrl}
            className="underline underline-offset-2 hover:opacity-80"
          >
            the redirect
          </a>
          ...
        </p>
      </div>
    );
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <label htmlFor="notify-email" className="font-display text-sm opacity-50">
          Email
        </label>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <input
            id="notify-email"
            type="email"
            name="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (message) setMessage("");
            }}
            placeholder="you@example.com"
            required
            autoComplete="email"
            className="min-h-12 w-full rounded-md border border-[var(--color-text)]/50 bg-[var(--color-bg)] px-4 py-3 text-base text-[var(--color-text)]/70 placeholder:opacity-50 focus:border-[var(--color-caramel)] focus:outline-none sm:flex-1"
          />
          <button
            type="submit"
            className="min-h-12 inline-flex items-center justify-center rounded-md border border-[var(--color-caramel)] bg-[var(--color-caramel)]/15 px-6 py-3 text-base font-display text-[var(--color-caramel)] transition hover:bg-[var(--color-caramel)]/25 sm:w-auto"
          >
            Notify me when Pocket ships
          </button>
        </div>
        {message && (
          <p className="text-sm text-red-400" role="alert">
            {message}
          </p>
        )}
      </form>
      <p className="mt-3 text-base leading-snug opacity-50">
        This signs you up for my personal devlog{" "}
        <a
          href="https://nedshed.dev"
          className="text-[var(--color-caramel)] underline-offset-2 hover:underline"
        >
          nedshed.dev
        </a>{" "}
        on Substack. The next post will be the launch post, you can unsubscribe any time.
      </p>
    </>
  );
}
