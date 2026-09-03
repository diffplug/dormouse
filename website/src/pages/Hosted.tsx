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
import { LINK_CLASS } from "../components/docs-tokens";
import { type TocEntry } from "../lib/docs-pages";
import { siteMeta } from "../lib/site-meta";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Dormouse Hosted — managed remote control and voice",
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

export default function Hosted() {
  return (
    <DocsLayout
      activePath="/hosted"
      title="Dormouse Hosted"
      intro="Optional managed services for people who want Dormouse without another server to run—or want a more natural voice when a terminal needs them."
      toc={HOSTED_TOC}
    >
      <div className="mb-10 rounded-xl border border-[var(--docs-accent)]/35 bg-[var(--docs-accent)]/[0.07] p-5">
        <p className="font-display text-lg text-[var(--docs-accent)]">Coming soon</p>
        <p className="mt-1 leading-relaxed opacity-75">
          There is nothing to buy yet. Join the mailing list below and I’ll tell you when
          the first hosted service is ready.
        </p>
      </div>

      <section className={CARD_CLASS}>
        <div className="grid items-center gap-7 sm:grid-cols-[1fr_10rem]">
          <div>
            <CloudArrowUpIcon
              size={28}
              weight="duotone"
              className="mb-3 text-[var(--docs-accent)]"
              aria-hidden="true"
            />
            <AnchoredHeading id="remote-control">
              Remote control, without running the server
            </AnchoredHeading>
            <p className="mb-4 text-lg leading-relaxed opacity-80">
              Dormouse Pocket needs a coordinating server to introduce your phone to
              your computer and relay encrypted traffic when a direct connection is not
              available. Dormouse Hosted will operate that server for you.
            </p>
            <p className="leading-relaxed opacity-70">
              Your terminals still run on your computer, and it still needs to be awake
              and online. Hosted removes the deployment and maintenance work; it does not
              move your terminal into the cloud.
            </p>
          </div>
          <img
            src={phoneMockupUrl}
            alt="Dormouse Pocket showing terminal sessions on a phone"
            className="mx-auto w-32 drop-shadow-xl sm:w-40"
          />
        </div>
      </section>

      <section className={`${CARD_CLASS} mt-6`}>
        <SpeakerHighIcon
          size={28}
          weight="duotone"
          className="mb-3 text-[var(--docs-accent)]"
          aria-hidden="true"
        />
        <AnchoredHeading id="voice">A better voice for spoken alerts</AnchoredHeading>
        <p className="mb-4 text-lg leading-relaxed opacity-80">
          Dormouse can speak an unattended terminal’s name using your browser or system
          voice today. A hosted ElevenLabs option will add a more natural voice without
          making you set up or manage an ElevenLabs account.
        </p>
        <p className="leading-relaxed opacity-70">
          Browser speech will stay available. ElevenLabs voice will be optional, and the
          app will explain what text leaves your computer before you turn it on.
        </p>
      </section>

      <section className={`${CARD_CLASS} mt-6`}>
        <CodeIcon
          size={28}
          weight="duotone"
          className="mb-3 text-[var(--docs-accent)]"
          aria-hidden="true"
        />
        <AnchoredHeading id="self-hosting">Free self-hosting stays</AnchoredHeading>
        <p className="text-lg leading-relaxed opacity-80">
          The coordinating server remains open source and free to run yourself. Hosted is
          the paid convenience option, not a replacement. If you would rather operate it,
          the{" "}
          <a href="/docs/self-host" className={LINK_CLASS}>
            self-hosting guide
          </a>{" "}
          is ready now.
        </p>
      </section>

      <section id="updates" className="mt-10 scroll-mt-28 md:scroll-mt-32 lg:scroll-mt-24">
        <h2 className="mb-3 font-display text-2xl">Hear when it’s ready</h2>
        <p className="mb-5 max-w-2xl text-lg leading-relaxed opacity-75">
          Pricing and launch dates are not set yet. Leave your email and I’ll send the
          announcement when Dormouse Hosted opens.
        </p>
        <NotifySignupForm
          buttonLabel="Tell me when Hosted launches"
          emailId="hosted-notify-email"
          announcement="Dormouse Hosted"
          variant="docs"
        />
      </section>
    </DocsLayout>
  );
}
