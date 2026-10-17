import { CARD_ACCENT_CLASS, CARD_MUTED_TEXT_CLASS, LINK_CLASS } from "./docs-tokens";
import { sitePath } from "../lib/site-meta";

/**
 * The Relay boundary `/self-host` opens with: Dormouse needs no server, and
 * the remote features that do need one make no requests until it exists.
 * `/hosted` opens with its plan cards instead, and its managed Relay section
 * carries the hosted half (docs/specs/website-docs.md -> `/hosted`).
 */
export function HostingRequirementNotice() {
  return (
    <aside
      aria-label="When Dormouse needs a Relay"
      className={`${CARD_ACCENT_CLASS} text-[var(--color-text)]`}
    >
      <p className="text-balance font-display text-xl leading-snug sm:text-2xl">
        Dormouse is just a terminal — it needs no server or hosting.
      </p>
      <p className={`mt-4 leading-relaxed ${CARD_MUTED_TEXT_CLASS}`}>
        Push notifications and phone control are optional. A new install opens no
        connection on its own until you choose where terminal data may travel in
        Settings → Network. Push and a paired phone need a Relay to connect your computer
        and phone and pass encrypted traffic between them. A one-time connection needs
        none: Dormouse’s servers pass only its encrypted handshake, and the phone
        connects directly.
      </p>
      <p className="mt-4 text-sm">
        Prefer not to run it?{" "}
        <a href={`${sitePath("/hosted")}#remote-control`} className={LINK_CLASS}>
          See Dormouse Hosted →
        </a>
      </p>
    </aside>
  );
}
