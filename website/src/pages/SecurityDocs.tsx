/**
 * `/security` — docs/specs/security.md, every section of it.
 *
 * The file is canonical in `docs/specs/`: it is a spec, budgeted by
 * `scripts/spec-lint.mjs` and read by the nightly audit that runs against it.
 * The generator's delta withholds only the `#` title and the front matter; see
 * docs/specs/website-docs.md -> `/security` spec. The page renders
 * `pageBlocks`, so the guarantees table and the two lists carry the local
 * application's, the pipeline's, and remote control's entries — the
 * supply-chain ones are on `/supply-chain`, remote control's also on
 * `/self-host`, and the spec file on GitHub is where every entry appears
 * together. The page's own introduction and the canary recall come first.
 */
import { type MetaArgs } from "react-router";
import { siteMeta, sitePath } from "../lib/site-meta";
import security from "../data/docs.security.json";
import canaryRecall from "../data/canary-recall.json";
import CanaryRecall from "../components/CanaryRecall";
import DocsLayout from "../components/DocsLayout";
import { BODY_TEXT_CLASS, CODE_CLASS, LINK_CLASS, MUTED_TEXT_CLASS } from "../components/docs-tokens";
import MarkdownDocument, { type BlockNode } from "../components/MarkdownDocument";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Security — Dormouse",
    description:
      "What Dormouse guarantees, what it does not defend, and how every guarantee is checked: build-time lints, a nightly audit, and public failure issues.",
  });
}

const SPECS_URL = "https://github.com/diffplug/dormouse/tree/main/docs/specs";
const NOISE_URL = "https://en.wikipedia.org/wiki/Noise_Protocol_Framework";
const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;
/** The spec's own lists, rendered by `MarkdownDocument`, and their nested level. */
const LIST_CLASS = `space-y-2 pl-6 text-lg ${MUTED_TEXT_CLASS} list-disc`;
const SUBLIST_CLASS = "space-y-2 pl-6 list-[circle]";

export default function SecurityDocs() {
  return (
    <DocsLayout
      activePath="/security"
      title={security.title}
      toc={security.toc}
    >
      <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
        A modern terminal must have a conservative security stance. Dormouse won’t even check
        whether an update is available unless you give it permission to check. If you opt in to
        Dormouse’s push notifications and remote access, you can restrict their terminal traffic
        to networks you name, such as your VPN.
      </p>
      <p className={`mb-4 ${BODY_TEXT_CLASS}`}>The high-level security architecture is this:</p>
      <ul className={`mb-4 ${LIST_CLASS}`}>
        <li className="leading-relaxed">
          We host a coordinating Relay at <code className={CODE_CLASS}>relay.dormouse.sh</code>;
          you can{" "}
          <a href={sitePath("/self-host")} className={LINK_CLASS}>
            self-host
          </a>{" "}
          it if you prefer.
        </li>
        <li className="leading-relaxed">
          A <em>Burrow</em> is the app that runs terminal sessions and makes them available for
          Clients to connect to.
          <ul className={`mt-2 ${SUBLIST_CLASS}`}>
            <li className="leading-relaxed">
              Burrows: the Dormouse Standalone desktop terminal and the Dormouse VS Code extension.
            </li>
            <li className="leading-relaxed">
              Clients: Dormouse Pocket and the one-time connection page, with more on the way.
            </li>
          </ul>
        </li>
        <li className="leading-relaxed">
          Before a Client can reach a Burrow’s terminals, you approve it at the Burrow, in a
          one-to-one pairing ceremony: you type on the Burrow the two digits the Client shows. A
          one-time connection takes the same approval and lasts one session.
        </li>
        <li className="leading-relaxed">
          Each Burrow keeps its own access control and makes every access decision itself. It
          trusts neither the Client nor the Relay.
        </li>
        <li className="leading-relaxed">
          All communication between Burrow and Client is end-to-end encrypted with the{" "}
          <a href={NOISE_URL} className={LINK_CLASS} {...EXTERNAL}>
            Noise protocol
          </a>
          .
        </li>
        <li className="leading-relaxed">
          When the network allows it, terminal traffic between Burrow and Client goes directly
          over WebRTC, so no server in between sees its timing or volume.
        </li>
        <li className="leading-relaxed">
          When the network does not allow a direct connection:
          <ul className={`mt-2 ${SUBLIST_CLASS}`}>
            <li className="leading-relaxed">
              If the Burrow allows <strong className="font-semibold">Anywhere</strong>, a paired
              phone’s Noise-encrypted traffic falls back to passing through the Relay. A one-time
              connection fails instead. Cloudflare’s public STUN server, which helps the two ends
              find each other, sees this computer’s public address but carries none of the
              traffic.
            </li>
            <li className="leading-relaxed">
              If the Burrow allows only{" "}
              <strong className="font-semibold">Local networks</strong>, a set of networks you
              name, the connection fails.
            </li>
          </ul>
        </li>
      </ul>
      <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
        These security properties, and many others, are laid out in a series of security specs
        that are audited nightly. The audits in turn undergo weekly canary testing: security
        vulnerabilities are intentionally added to a copy of the application code, sometimes with
        justifying comments, to test that the audit actually catches them.
      </p>
      <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
        Here is the canary history over the past {canaryRecall.windowDays} days:
      </p>
      <CanaryRecall snapshot={canaryRecall} />
      <p className={`mb-8 ${BODY_TEXT_CLASS}`}>
        And here are the security specs. What follows is not maintained by hand:{" "}
        <a href={SPECS_URL} className={LINK_CLASS} {...EXTERNAL}>
          these are the actual specs the audit runs against
        </a>
        . This page shows the guarantees for the local application, remote control, and the
        release pipeline; what reaches your machine is in the{" "}
        <a href={sitePath("/supply-chain")} className={LINK_CLASS}>
          supply-chain disclosure
        </a>
        .
      </p>

      <MarkdownDocument blocks={security.pageBlocks as BlockNode[]} />
    </DocsLayout>
  );
}
