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
  {
    id: "security-model",
    text: "Security model",
    children: [{ id: "security-boundaries", text: "Boundaries and current gaps", children: [] }],
  },
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
        terminal gateway. Its access-control and confidentiality guarantees are:
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
          <strong className="font-semibold">A stolen or synced passkey is not terminal access.</strong>{" "}
          Every connection also needs the phone&apos;s paired key and a fresh presence proof
          bound to that connection. Clearing the phone browser&apos;s site data loses that key
          and requires pairing again; it grants nobody access.
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
          <strong className="font-semibold">Push notifications are sealed to one phone.</strong>{" "}
          The Server relays an encrypted envelope and never receives notification plaintext.
          Push endpoints must be public HTTPS URLs and cannot be aimed into the tailnet.
        </li>
        <li className="leading-relaxed">
          <strong className="font-semibold">A hostile Server has bounded leverage.</strong>{" "}
          It cannot authorize a phone or make rejected frames consume unbounded Host work.
          The Host connects only to the relay origin built into it and refuses a different
          origin before sending credentials.
        </li>
        <li className="leading-relaxed">
          <strong className="font-semibold">The deployment keeps plaintext off the network.</strong>{" "}
          The backend listens on loopback behind the tailnet, the installer rejects Tailscale
          Funnel, and credential files are restricted to the account that installed them.
        </li>
        <li className="leading-relaxed">
          <strong className="font-semibold">An authorized phone has full terminal power.</strong>{" "}
          Remote control is raw keyboard access to a live shell, not a restricted or
          read-only session.
        </li>
      </ul>
      <AnchoredHeading id="security-boundaries" depth={3}>
        Boundaries and current gaps
      </AnchoredHeading>
      <ul className="mb-4 list-disc space-y-2 pl-6 text-lg opacity-80">
        <li className="leading-relaxed">
          The trusted endpoints are the Host binaries and the exact Pocket application this
          origin serves. A compromised browser or operating system, active XSS, or a modified
          Pocket build is outside the model.
        </li>
        <li className="leading-relaxed">
          Encrypted notifications can be replayed, and one push endpoint per browser lets the
          Server associate that phone with each Host it registers.
        </li>
        <li className="leading-relaxed">
          The relay can deny service, and it is unavailable whenever the machine running it
          sleeps. There is no revocation UI or activity audit trail; revoking a lost phone
          currently means editing the Host ACL file and restarting the Host.
        </li>
        <li className="leading-relaxed">
          Installer verification is uneven: Linux checks credential mode and owner, macOS
          checks modes only, and Windows checks the DACL but not the owner.
        </li>
        <li className="leading-relaxed">
          The setup password has a fixed delay but no rate limit or lockout. The analyzed
          deployment is tailnet-only; exposing its origin to the public internet is a
          different security model.
        </li>
      </ul>
      <p className="mb-4 text-lg leading-relaxed opacity-80">
        The CI checks and nightly and pre-release audit that hold these claims to the code
        are described in{" "}
        <a href="/docs/security#how-the-guarantees-are-checked" className={LINK_CLASS}>
          how the guarantees are checked
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
