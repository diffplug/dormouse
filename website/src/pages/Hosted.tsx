import {
  CloudArrowUpIcon,
  CodeIcon,
  SpeakerHighIcon,
} from "@phosphor-icons/react";
import { type MetaArgs } from "react-router";
import phoneMockupUrl from "../assets/phone-mockup.webp";
import DocsLayout from "../components/DocsLayout";
import { AnchoredHeading } from "../components/MarkdownDocument";
import { NotifySignupForm } from "../components/NotifySignupForm";
import { LINK_CLASS, MUTED_TEXT_CLASS } from "../components/docs-tokens";
import { type TocEntry } from "../lib/docs-pages";
import { siteMeta } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Pay us to host — Dormouse",
    description:
      "Coming soon: a managed Dormouse coordinating server and optional ElevenLabs voice, without giving up free self-hosting.",
  });
}

export const HOSTED_TOC: TocEntry[] = [
  { id: "remote-control", text: "Remote control", children: [] },
  { id: "voice", text: "ElevenLabs voice", children: [] },
  { id: "self-hosting", text: "Self-hosting stays", children: [] },
  { id: "updates", text: "Get updates", children: [] },
];

const CARD_CLASS =
  "rounded-xl border border-[var(--color-text)]/15 bg-[var(--color-text)]/[0.035] p-5 sm:p-6";
const SELF_HOSTED_SECURITY_MODEL_URL =
  "https://github.com/diffplug/dormouse/blob/main/docs/specs/remote-security-model.md";

export default function Hosted() {
  return (
    <DocsLayout
      activePath="/hosted"
      title="Pay us to host"
      intro="Use Dormouse Pocket without deploying a coordinating server. Hosted remote control is planned as a paid convenience; your terminals stay on your computer, and free self-hosting stays available."
      toc={HOSTED_TOC}
    >
      <section>
        <div className="grid items-center gap-8 sm:grid-cols-[minmax(0,1fr)_12rem] lg:gap-12">
          <div>
            <CloudArrowUpIcon
              size={28}
              weight="duotone"
              className="mb-4 text-[var(--docs-accent)]"
              aria-hidden="true"
            />
            <AnchoredHeading id="remote-control" spacing="mt-0 mb-3">
              Remote control, without running the server
            </AnchoredHeading>
            <p className="mb-4 font-display text-sm text-[var(--docs-accent)]">
              Coming soon · paid convenience
            </p>
            <p className="mb-5 text-xl leading-relaxed">
              Use Dormouse Pocket without deploying or maintaining a coordinating server.
              Hosted will run the coordinator that connects your phone to your computer.
            </p>
            <a
              href="#updates"
              className="inline-flex min-h-12 items-center rounded-md border border-[var(--docs-accent)] px-5 py-3 font-display text-[var(--docs-accent)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--docs-accent)]"
            >
              Follow the hosted launch →
            </a>

            <dl className="mt-8 grid gap-4 border-t border-[var(--color-text)]/15 pt-5 text-sm sm:grid-cols-3">
              <div>
                <dt className="font-display">Hosted runs</dt>
                <dd className={`mt-1 ${MUTED_TEXT_CLASS}`}>The coordinating server</dd>
              </div>
              <div>
                <dt className="font-display">You keep</dt>
                <dd className={`mt-1 ${MUTED_TEXT_CLASS}`}>Terminals on your computer</dd>
              </div>
              <div>
                <dt className="font-display">Still required</dt>
                <dd className={`mt-1 ${MUTED_TEXT_CLASS}`}>Your computer awake and online</dd>
              </div>
            </dl>
            <div className="mt-6 border-t border-[var(--color-text)]/15 pt-5">
              <h3 className="font-display text-lg">Security before launch</h3>
              <p className={`mt-2 leading-relaxed ${MUTED_TEXT_CLASS}`}>
                Hosted is being designed around Dormouse’s existing end-to-end protocol. The
                target is for the coordinator to route encrypted traffic without terminal keys,
                while your computer—not the coordinator—authorizes each paired phone.
              </p>
              <p className={`mt-3 leading-relaxed ${MUTED_TEXT_CLASS}`}>
                A managed relay would still see connection metadata such as IP addresses, online
                state, timing, ciphertext sizes, and traffic volume. These are design targets,
                not launched guarantees: Dormouse will not claim the self-hosted security model
                for a paid service until the cryptography and its integration pass independent
                review.
              </p>
              <p className="mt-3 text-sm">
                <a
                  href={SELF_HOSTED_SECURITY_MODEL_URL}
                  className={LINK_CLASS}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Read the current self-hosted trust model →
                </a>
              </p>
            </div>
            <p className="mt-3 text-sm">
              Prefer to operate the server yourself?{" "}
              <a href="#self-hosting" className={LINK_CLASS}>
                Self-hosting stays free
              </a>
            </p>
          </div>
          <img
            src={phoneMockupUrl}
            alt="Dormouse Pocket showing terminal sessions on a phone"
            className="mx-auto w-44 drop-shadow-xl sm:w-48"
          />
        </div>
      </section>

      <section className="mt-14 border-t border-[var(--color-text)]/15 pt-10">
        <SpeakerHighIcon
          size={28}
          weight="duotone"
          className="mb-3 text-[var(--docs-accent)]"
          aria-hidden="true"
        />
        <AnchoredHeading id="voice" spacing="mt-0 mb-3">A more natural voice, optionally</AnchoredHeading>
        <p className="mb-3 font-display text-sm text-[var(--docs-accent)]">
          Planned after remote control · optional paid add-on
        </p>
        <p className={`mb-4 text-lg leading-relaxed ${MUTED_TEXT_CLASS}`}>
          Dormouse can speak an unattended terminal’s name using your browser or system
          voice today. A hosted ElevenLabs option will add a more natural voice without
          making you set up or manage an ElevenLabs account.
        </p>
        <p className={`leading-relaxed ${MUTED_TEXT_CLASS}`}>
          Browser speech will stay available. ElevenLabs voice will be optional, and the
          app will explain what text leaves your computer before you turn it on.
        </p>
      </section>

      <section className={`${CARD_CLASS} mt-10`}>
        <CodeIcon
          size={28}
          weight="duotone"
          className="mb-3 text-[var(--docs-accent)]"
          aria-hidden="true"
        />
        <AnchoredHeading id="self-hosting" spacing="mt-0 mb-4">Self-hosting stays</AnchoredHeading>
        <p className="text-lg leading-relaxed">
          The coordinating server remains available in the repository under
          FSL-1.1-MIT and free for internal use. Hosted will be a paid convenience option,
          not a replacement. If you would rather operate it, the{" "}
          <a href="/docs/self-host" className={LINK_CLASS}>
            self-hosting guide
          </a>{" "}
          is ready now.
        </p>
      </section>

      <section id="updates" className="mt-10 scroll-mt-28 md:scroll-mt-32 lg:scroll-mt-24">
        <h2 className="mb-3 font-display text-2xl">Follow the launch</h2>
        <p className={`mb-5 max-w-2xl text-lg leading-relaxed ${MUTED_TEXT_CLASS}`}>
          Pricing and dates are not set. Subscribe to my personal devlog on Substack and
          I’ll announce managed remote control and ElevenLabs voice there. This is not a
          product-only waitlist; you’ll also receive other devlog posts.
        </p>
        <NotifySignupForm
          buttonLabel="Continue to nedshed.dev"
          emailId="hosted-notify-email"
          announcement="Dormouse Hosted"
          variant="docs"
        />
      </section>
    </DocsLayout>
  );
}
