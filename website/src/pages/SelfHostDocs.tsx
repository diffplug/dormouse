/**
 * `/docs/self-host` — the runbook half of SELF_HOST.md.
 *
 * The file is canonical in the repository: an assistant reads it there to walk
 * someone through the install, and `scripts/deploy-lint.mjs` audits the
 * Installer contract at the end of it against `deploy/local/`. The generator's
 * delta withholds that contract and the assistant-directed sections; see
 * docs/specs/website-docs.md -> `/docs/self-host` runbook.
 */
import { type MetaArgs } from "react-router";
import { siteMeta } from "../lib/site-meta";
import selfhost from "../data/docs.selfhost.json";
import DocsLayout from "../components/DocsLayout";
import { CODE_CLASS, LINK_CLASS } from "../components/docs-tokens";
import MarkdownDocument, { AnchoredHeading, type BlockNode } from "../components/MarkdownDocument";
import { type TocEntry } from "../lib/docs-pages";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Self-host — Dormouse",
    description:
      "Run the Dormouse coordinating server on your own machine, reachable only from your tailnet. One installer, no database, no account.",
  });
}

const REPO_URL = "https://github.com/diffplug/dormouse";

export const SELF_HOST_TOC: TocEntry[] = [
  { id: "security-model", text: "Security model", children: [] },
  ...(selfhost.toc as TocEntry[]),
];

export default function SelfHostDocs() {
  return (
    <DocsLayout
      activePath="/docs/self-host"
      title={selfhost.title}
      intro="Everything Dormouse needs for phone notifications and remote control runs on hardware you own. This is the runbook."
      toc={SELF_HOST_TOC}
    >
      <AnchoredHeading id="security-model">Security model</AnchoredHeading>
      <p className="mb-4 text-lg leading-relaxed opacity-80">
        The coordinating server is a rendezvous and ciphertext relay, not a trusted
        terminal gateway. The complete guarantees, accepted risks, and known gaps live
        in the{" "}
        <a href="/docs/security" className={LINK_CLASS}>
          security spec
        </a>
        ; these are the consequences that matter while operating it:
      </p>
      <ul className="mb-4 list-disc space-y-2 pl-6 text-lg opacity-80">
        <li className="leading-relaxed">
          <strong className="font-semibold">Payloads are end-to-end protected.</strong>{" "}
          After the Host&apos;s QR code bootstraps a one-use invitation, pairing messages,
          every later terminal session, and notification text are encrypted between
          Pocket and the terminal Host. The Server holds no decryption key and has no
          plaintext relay path.
        </li>
        <li className="leading-relaxed">
          <strong className="font-semibold">Only the Host grants access.</strong> Scanning
          the QR code does not authorize the phone. The phone proves fresh passkey presence
          inside the encrypted ceremony, then the person types into the Host the two digits
          displayed by the phone. Only the Host can write its local, per-phone ACL; a
          passkey or Server account alone cannot add an entry.
        </li>
        <li className="leading-relaxed">
          <strong className="font-semibold">The Server sees metadata, not content.</strong>{" "}
          It observes account and passkey authentication data, IP addresses, Host IDs and
          online state, routing relationships, reauthentication, push endpoints, and
          ciphertext timing, sizes, and volume. That exposes traffic relationships and
          inter-keystroke or display-update timing, never the keystrokes, terminal output,
          Host label, pairing decision, or notification text.
        </li>
        <li className="leading-relaxed">
          <strong className="font-semibold">An authorized phone has full terminal power.</strong>{" "}
          Remote control is raw keyboard access to a live shell, not a restricted or
          read-only session.
        </li>
      </ul>
      <p className="mb-4 text-lg leading-relaxed opacity-80">
        The trusted endpoints are the Host binaries and the exact Pocket application this
        origin serves; a compromised browser or operating system, active XSS, or modified
        Pocket build is outside the model. The relay can deny availability, and today there
        is no revocation UI or activity audit trail. The deployment also assumes a
        tailnet-only origin, a loopback-only plaintext backend, and no Tailscale Funnel—the
        setup password is not hardened for public exposure. See{" "}
        <a href="/docs/security#what-is-not-defended" className={LINK_CLASS}>
          what is not defended
        </a>
        {" "}and the{" "}
        <a href="/docs/security#known-gaps" className={LINK_CLASS}>
          known gaps
        </a>
        .
      </p>
      <p className="mb-8 text-lg leading-relaxed opacity-80">
        The exact runtime and server dependencies installed by this runbook are listed in
        the{" "}
        <a href="/supply-chain" className={LINK_CLASS}>
          supply-chain disclosure
        </a>
        .
      </p>

      <p className="mb-8 rounded-lg border border-[var(--color-caramel)]/30 bg-[var(--color-caramel)]/[0.06] p-4 leading-relaxed opacity-80">
        You do not have to follow this by hand. Clone{" "}
        <a href={REPO_URL} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">
          the repository
        </a>
        , start Claude Code in it, and say{" "}
        <code className={CODE_CLASS}>
          read @SELF_HOST.md and walk me through it
        </code>
        . It will run the checkpoints below with you, one at a time.
      </p>

      <MarkdownDocument blocks={selfhost.blocks as BlockNode[]} />
    </DocsLayout>
  );
}
