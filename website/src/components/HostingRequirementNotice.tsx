import { CARD_ACCENT_CLASS, CARD_MUTED_TEXT_CLASS, LINK_CLASS } from "./docs-tokens";
import { sitePath } from "../lib/site-meta";

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
      aria-label="When Dormouse needs a Relay"
      className={`${CARD_ACCENT_CLASS} text-[var(--color-text)]`}
    >
      <p className="text-balance font-display text-xl leading-snug sm:text-2xl">
        Dormouse is just a terminal — it needs no server or hosting.
      </p>
      <p className={`mt-4 leading-relaxed ${CARD_MUTED_TEXT_CLASS}`}>
        Push notifications and phone control are optional. They require a Relay to
        connect your computer and phone and pass encrypted traffic between them. Until you
        configure one, Dormouse’s remote features make no network requests.
      </p>
      {planned ? (
        <>
          <p className={`mt-4 leading-relaxed ${CARD_MUTED_TEXT_CLASS}`}>
            Paid hosting remains a design target pending independent review. A managed
            Relay would still see connection metadata.
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
        <p className="mt-4 text-sm">
          Prefer not to run it?{" "}
          <a href={`${sitePath("/hosted")}#remote-control`} className={LINK_CLASS}>
            See the planned paid option →
          </a>
        </p>
      )}
    </aside>
  );
}
