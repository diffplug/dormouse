import {
  CloudArrowUpIcon,
  CodeIcon,
  SpeakerHighIcon,
} from "@phosphor-icons/react";
import { type MetaArgs } from "react-router";
import phoneMockupUrl from "../assets/phone-mockup.webp";
import DocsLayout from "../components/DocsLayout";
import { HostingRequirementNotice } from "../components/HostingRequirementNotice";
import { AnchoredHeading } from "../components/MarkdownDocument";
import { NotifySignupForm } from "../components/NotifySignupForm";
import {
  ACCENT_BORDER_CLASS,
  ACCENT_TEXT_CLASS,
  BODY_TEXT_CLASS,
  CARD_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
} from "../components/docs-tokens";
import { type TocEntry } from "../lib/docs-pages";
import { siteMeta, sitePath } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Pay us to host — Dormouse",
    description:
      "Coming soon: a managed Dormouse Relay and optional ElevenLabs voice, without giving up free self-hosting.",
  });
}

export const HOSTED_TOC: TocEntry[] = [
  { id: "remote-control", text: "Remote control", children: [] },
  { id: "voice", text: "ElevenLabs voice", children: [] },
  { id: "self-hosting", text: "Self-hosting stays", children: [] },
  { id: "updates", text: "Get updates", children: [] },
];

export default function Hosted() {
  return (
    <DocsLayout
      activePath="/hosted"
      title="Pay us to host"
      intro={<HostingRequirementNotice mode="planned-hosted" />}
      toc={HOSTED_TOC}
    >
      <section>
        <div className="grid items-center gap-8 sm:grid-cols-[minmax(0,1fr)_12rem] lg:gap-12">
          <div>
            <CloudArrowUpIcon
              size={28}
              weight="duotone"
              className={`mb-4 ${ACCENT_TEXT_CLASS}`}
              aria-hidden="true"
            />
            <AnchoredHeading id="remote-control" spacing="mt-0 mb-3">
              Remote control, without running the Relay
            </AnchoredHeading>
            <p className={`mb-4 font-display text-sm ${ACCENT_TEXT_CLASS}`}>
              Coming soon · paid convenience
            </p>
            <p className="mb-5 text-xl leading-relaxed">
              Use Dormouse Pocket without deploying or maintaining a Relay. Hosted operates
              the Relay that connects your phone to your computer.
            </p>
            <a
              href="#updates"
              className={`inline-flex min-h-12 items-center rounded-md border px-5 py-3 font-display hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--docs-accent)] ${ACCENT_BORDER_CLASS} ${ACCENT_TEXT_CLASS}`}
            >
              Follow the hosted launch →
            </a>

            <dl className="mt-8 grid gap-4 border-t border-[var(--color-text)]/15 pt-5 text-sm sm:grid-cols-3">
              <div>
                <dt className="font-display">Hosted runs</dt>
                <dd className={`mt-1 ${MUTED_TEXT_CLASS}`}>The Relay</dd>
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
            <p className="mt-3 text-sm">
              Prefer to run your own Relay?{" "}
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
          className={`mb-3 ${ACCENT_TEXT_CLASS}`}
          aria-hidden="true"
        />
        <AnchoredHeading id="voice" spacing="mt-0 mb-3">A more natural voice, optionally</AnchoredHeading>
        <p className={`mb-3 font-display text-sm ${ACCENT_TEXT_CLASS}`}>
          Planned after remote control · optional paid add-on
        </p>
        <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
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
          className={`mb-3 ${ACCENT_TEXT_CLASS}`}
          aria-hidden="true"
        />
        <AnchoredHeading id="self-hosting" spacing="mt-0 mb-4">Self-hosting stays</AnchoredHeading>
        <p className="text-lg leading-relaxed">
          The Relay remains available in the repository under
          FSL-1.1-MIT and free for internal use. Hosted will be a paid convenience option,
          not a replacement. If you would rather operate it, the{" "}
          <a href={sitePath("/docs/self-host")} className={LINK_CLASS}>
            self-hosting guide
          </a>{" "}
          is ready now.
        </p>
      </section>

      <section className="mt-10">
        <AnchoredHeading id="updates" spacing="mt-0 mb-3">Follow the launch</AnchoredHeading>
        <p className={`mb-5 max-w-2xl ${BODY_TEXT_CLASS}`}>
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
