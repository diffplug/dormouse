import { LINK_CLASS, MUTED_TEXT_CLASS } from "./docs-tokens";

const SELF_HOSTED_SECURITY_MODEL_URL =
  "https://github.com/diffplug/dormouse/blob/main/docs/specs/remote-security-model.md";

export function HostingRequirementNotice({
  mode,
}: {
  mode: "self-hosted" | "planned-hosted";
}) {
  const planned = mode === "planned-hosted";

  return (
    <aside
      aria-label="When Dormouse needs a server"
      className="rounded-xl border border-[var(--docs-accent)] bg-[var(--color-text)]/[0.04] p-5 text-[var(--color-text)] sm:p-6"
    >
      <p className="text-balance font-display text-xl leading-snug sm:text-2xl">
        Dormouse is just a terminal! It does not need a server or hosting of any kind.
      </p>
      <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
        But push notifications and phone control are optional extras. To get an alert
        when an agent asks a question—or to control your terminal from your phone—you
        need a coordinating server. It helps your computer and phone establish the
        connection, then routes traffic between them.
      </p>
      {planned ? (
        <>
          <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
            The planned paid service targets that same end-to-end design: terminal data
            and notification text would reach the server only as ciphertext, while
            authorization would stay on your computer. These are design targets, not
            launched guarantees, until the cryptography and integration pass independent
            review.
          </p>
          <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
            A managed server would still see connection metadata such as IP addresses,
            online status, who is connected to whom, timing, ciphertext sizes, and traffic
            volume.
          </p>
          <p className="mt-4 text-sm">
            <a
              href={SELF_HOSTED_SECURITY_MODEL_URL}
              className={LINK_CLASS}
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the current self-hosted trust model →
            </a>
          </p>
        </>
      ) : (
        <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
          The phone-to-computer connection is encrypted end to end. Terminal data and
          notification text reach the server only as ciphertext. Your computer—not the
          server—authorizes each phone after you pair it at the computer. The server can
          still see connection metadata such as IP addresses, online status, who is
          connected to whom, timing, ciphertext sizes, and traffic volume.
        </p>
      )}
      {planned ? null : (
        <p className="mt-4 text-sm">
          Prefer not to run it?{" "}
          <a href="/hosted/#remote-control" className={LINK_CLASS}>
            See the planned paid option →
          </a>
        </p>
      )}
    </aside>
  );
}
