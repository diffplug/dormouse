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
        Dormouse is just a terminal — it needs no server or hosting.
      </p>
      <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
        Push notifications and phone control are optional. They require a signalling
        server to connect your computer and phone and relay encrypted traffic. Until you
        configure one, Dormouse’s remote features make no network requests.
      </p>
      {planned ? (
        <>
          <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
            Paid hosting remains a design target pending independent review. A managed
            server would still see connection metadata.
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
        null
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
