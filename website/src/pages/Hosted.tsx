/**
 * Dormouse Hosted: what the Individual plan grants, what it costs, and the
 * questions a buyer asks before paying.
 *
 * `/pricing` redirects here (website/public/_redirects) rather than splitting
 * the two: the tool is free and open source, so the price belongs to the one
 * optional service that has one. Prices, inclusions, and the FAQ are
 * prerendered; only the cohort counters load after hydration.
 *
 * See docs/specs/pricing.md -> The Hosted page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CloudArrowUpIcon,
  CodeIcon,
  SpeakerHighIcon,
} from "@phosphor-icons/react";
import { type MetaArgs } from "react-router";
import DocsLayout from "../components/DocsLayout";
import { AnchoredHeading } from "../components/MarkdownDocument";
import { NotifySignupForm } from "../components/NotifySignupForm";
import { PlanCards, type Buy } from "../components/PlanCards";
import {
  ACCENT_BORDER_CLASS,
  ACCENT_TEXT_CLASS,
  BODY_TEXT_CLASS,
  CARD_CLASS,
  CARD_MUTED_TEXT_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
  PANEL_CLASS,
  SCROLL_MT_CLASS,
  SECTION_CLASS,
} from "dormouse-lib/site/docs-tokens";
import { type TocEntry } from "../lib/docs-pages";
import { useCohort } from "../lib/hosted-cohorts";
import {
  CHECKOUT_OPEN,
  FOUNDING_COHORT_SIZE,
  LIST_ANNUAL,
  LIST_MONTHLY,
  checkoutUrl,
  pricingJsonLd,
  type Tier,
} from "../lib/hosted-pricing";
import { canonicalUrl, siteMeta, sitePath } from "../lib/site-meta";
import { takeVisitRef } from "../lib/hosted-ref";
import type { HostedRef } from "dormouse-lib/lib/hosted-links";
import { trackEvent, trackPageview, type SiteRouteHandle } from "../lib/site-analytics";
// The cap the voice Worker enforces and checkout discloses; the Terms point here for it.
import { VOICE_DAILY_CAP } from "../../../hosted/server/policy-constants";

const PAGE_PATH = "/hosted";

/** This page sends its own pageview, so it can carry the visit's `ref`. */
export const handle: SiteRouteHandle = { ownPageview: true };

const SECURITY_MODEL_URL =
  "https://github.com/diffplug/dormouse/blob/main/docs/specs/remote-security-model.md";

/** Where team and enterprise inquiries go; nothing on this page sells them. */
const SUPPORT_EMAIL = "support@dormouse.sh";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Dormouse Hosted",
    description:
      "The terminal is free. Dormouse Hosted adds the Hosted Relay for Pocket and Natural Voice "
      + `for spoken alarms — from $${LIST_MONTHLY} a month, with founding prices while they last.`,
  });
}

export const HOSTED_TOC: TocEntry[] = [
  { id: "voice", text: "Natural Voice", children: [] },
  { id: "remote-control", text: "The Hosted Relay", children: [] },
  { id: "self-hosting", text: "Self-hosting stays free", children: [] },
  { id: "account", text: "Your Hosted account", children: [] },
  { id: "faq", text: "Questions", children: [] },
];

/**
 * What a buy button does while checkout is closed (`CHECKOUT_OPEN`).
 *
 * Deliberately loud about being unfinished: the prices are real and the plan
 * is specified, but purchase is a later stage,
 * and a button that quietly did nothing would read as a bug.
 */
function CheckoutTodo({ tier, onClose }: { tier: Tier; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-todo-title"
        tabIndex={-1}
        className={PANEL_CLASS}
        onClick={(event) => event.stopPropagation()}
      >
        <p className={`font-display text-sm tracking-wide ${ACCENT_TEXT_CLASS}`}>TODO</p>
        <h2 id="checkout-todo-title" className="mt-1 font-display text-2xl">
          Checkout is not wired up yet
        </h2>
        <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
          {tier.name} is priced and specified, but nothing here takes payment: purchase
          is the next stage of work. You have not been
          charged, and no seat has been taken.
        </p>
        <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
          Want to hear when it opens? Join Dormouse’s email list and I’ll tell you.
        </p>
        <div className="mt-4">
          <NotifySignupForm
            buttonLabel="Email me when it opens"
            emailId="hosted-notify-email"
            announcement="Dormouse Hosted checkout"
            variant="docs"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`mt-6 inline-flex min-h-12 items-center rounded-md border px-5 py-3 font-display focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--docs-accent)] ${ACCENT_BORDER_CLASS} ${ACCENT_TEXT_CLASS}`}
        >
          Close
        </button>
      </div>
    </div>
  );
}

function FaqEntry({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-[var(--color-text)]/15 pt-5">
      <h3 className="mb-2 font-display text-lg">{question}</h3>
      <div className={`leading-relaxed ${MUTED_TEXT_CLASS}`}>{children}</div>
    </div>
  );
}

export default function Hosted() {
  const cohort = useCohort();
  const [checkoutTodo, setCheckoutTodo] = useState<Tier | null>(null);
  // The visit's ref, which checkout carries on to Stripe.
  const [ref, setRef] = useState<HostedRef | "other" | null>(null);
  const closeTodo = useCallback(() => setCheckoutTodo(null), []);
  const buy = useMemo<Buy>(
    () => ({
      onBuy: (tier) => {
        trackEvent({ name: "hosted plan clicked", plan: tier.id });
        if (!CHECKOUT_OPEN) setCheckoutTodo(tier);
      },
      href: (tier) => (CHECKOUT_OPEN ? checkoutUrl(tier, ref) : null),
    }),
    [ref],
  );

  // Off the address bar on arrival, and onto this visit's pageview and checkout links.
  useEffect(() => {
    const visitRef = takeVisitRef();
    setRef(visitRef);
    trackPageview(visitRef);
  }, []);

  return (
    <DocsLayout
      activePath={PAGE_PATH}
      title="Dormouse Hosted"
      toc={HOSTED_TOC}
    >
      {/* Prerendered with the prices it repeats, so an assistant fetching the
          page can quote them without running the counters. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: pricingJsonLd(canonicalUrl(PAGE_PATH), CHECKOUT_OPEN) }}
      />

      {/* The cards open the page: no heading of their own, but `#pricing`
          stays an anchor, since the JSON-LD offers point at it. */}
      <section id="pricing" aria-label="Plans and prices" className={SCROLL_MT_CLASS}>
        <PlanCards cohort={cohort} buy={buy} />

        <p className={`mt-5 text-sm ${MUTED_TEXT_CLASS}`}>
          The founding price rises as each cohort of {FOUNDING_COHORT_SIZE} sells out, and founding
          closes for good at the ${LIST_ANNUAL} list price. Whatever you paid stays locked. For team and enterprise
          plans, email <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK_CLASS}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>

      <section className={SECTION_CLASS}>
        <SpeakerHighIcon
          size={28}
          weight="duotone"
          className={`mb-3 ${ACCENT_TEXT_CLASS}`}
          aria-hidden="true"
        />
        <AnchoredHeading id="voice" spacing="mt-0 mb-3">Natural Voice</AnchoredHeading>
        <p className={`mb-3 font-display text-sm ${ACCENT_TEXT_CLASS}`}>Included with any plan</p>
        <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
          Free and with no account, Dormouse speaks an unattended terminal’s name in your
          browser or system voice. A plan swaps that for a natural
          voice on every machine you enroll, chosen from a curated set. I hold the vendor key, so there is no second account to set
          up or pay for.
        </p>
        <p className={`mb-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
          Natural Voice sends a shortened displayed label, voice id, and authentication
          credential to our service; ElevenLabs receives the label and voice id. Labels
          can contain program-supplied titles, command labels, or directory names.
          Filtering cannot remove every secret. The terminal screen and output stream
          are not uploaded for speech. The app explains this before the first request.
          See the{" "}
          <a href={sitePath("/privacy") + "#voice"} className={LINK_CLASS}>voice privacy details</a>.
        </p>
        <p className={`leading-relaxed ${MUTED_TEXT_CLASS}`}>
          The system voice stays, and stays the fallback: offline, past the daily fair-use
          cap, or if my endpoint fails, Dormouse speaks in the system voice rather than
          going silent. Natural Voice allows {VOICE_DAILY_CAP} requests per subscriber per UTC day;
          each alarm spoken is one request, and provider failures count.
        </p>
      </section>

      <section className={SECTION_CLASS}>
        <CloudArrowUpIcon
          size={28}
          weight="duotone"
          className={`mb-3 ${ACCENT_TEXT_CLASS}`}
          aria-hidden="true"
        />
        <AnchoredHeading id="remote-control" spacing="mt-0 mb-3">
          The Hosted Relay
        </AnchoredHeading>
        <p className={`mb-3 font-display text-sm ${ACCENT_TEXT_CLASS}`}>Included with any plan</p>
        <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
          Dormouse Pocket puts your terminals on your phone. It needs a Relay to connect
          the two, and Hosted runs it for you: enrollment of your own computers, sealed
          push notifications, and Pocket without a tailnet. Your terminals still run on
          your own awake, online computer. Enroll every computer you use: there is no
          device limit and no per-device charge.
        </p>
        <p className={`leading-relaxed ${MUTED_TEXT_CLASS}`}>
          Terminal traffic is end-to-end encrypted between your computer and your phone,
          so the Relay I operate carries it without reading it. What it does see is
          connection metadata, and the{" "}
          <a
            href={SECURITY_MODEL_URL}
            className={LINK_CLASS}
            target="_blank"
            rel="noopener noreferrer"
          >
            trust model
          </a>{" "}
          lists exactly which.
        </p>
      </section>

      <section className={`${CARD_CLASS} mt-10`}>
        <CodeIcon
          size={28}
          weight="duotone"
          className={`mb-3 ${ACCENT_TEXT_CLASS}`}
          aria-hidden="true"
        />
        <AnchoredHeading id="self-hosting" spacing="mt-0 mb-4">
          Self-hosting stays free
        </AnchoredHeading>
        <p className="mb-4 text-lg leading-relaxed">
          Nothing that ships free is ever moved behind this page: the terminal, the{" "}
          <a href={sitePath("/dor")} className={LINK_CLASS}>
            dor CLI
          </a>
          , browser panes, alerts with your system voice, the Relay itself,
          and Pocket over a Relay you run.
        </p>
        <p className={`leading-relaxed ${CARD_MUTED_TEXT_CLASS}`}>
          The Relay stays in the repository under FSL-1.1-MIT and free for internal use.
          Hosted is the paid convenience, not the replacement — if you would rather
          operate it, the{" "}
          <a href={sitePath("/self-host")} className={LINK_CLASS}>
            self-hosting guide
          </a>{" "}
          is ready now.
        </p>
      </section>

      <section className="mt-14">
        <AnchoredHeading id="account" spacing="mt-0 mb-3">Your Hosted account</AnchoredHeading>
        <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
          Dormouse Hosted, operated by DiffPlug LLC, provides an account where you can
          manage your sign-in methods. Use an email code or a supported identity
          provider, and explicitly connect additional methods from your account.
          Creating an account does not upload your terminal contents or subscribe
          you to the email list.
        </p>
        <p className={BODY_TEXT_CLASS}>
          <a href="https://hosted.dormouse.sh" className={LINK_CLASS}>Manage your Hosted account</a>.
          Read the <a href={sitePath("/privacy")} className={LINK_CLASS}>privacy policy</a> and{" "}
          <a href={sitePath("/terms")} className={LINK_CLASS}>terms of service</a>.
        </p>
      </section>

      <section className="mt-14">
        <AnchoredHeading id="faq" spacing="mt-0 mb-6">Questions</AnchoredHeading>
        <div className="grid gap-5">
          <FaqEntry question="Refunds and cancellation?">
            Ask within 30 days of your first Hosted payment or any yearly renewal for
            a full refund. Monthly renewals are outside that voluntary guarantee.
            All plans auto-renew; cancel any time to stop renewal and keep access through
            the paid period. A full refund ends access. Legal rights still apply; see the{" "}
            <a href={sitePath("/terms") + "#cancellation"} className={LINK_CLASS}>refund terms</a>.
          </FaqEntry>
          <FaqEntry question="What exactly does a founding price lock?">
            Your base yearly price in US dollars, for as long as the subscription stays
            active; taxes may change. A failed renewal gives you 30 days to restore
            payment and keep the price, but paid features pause until payment succeeds.
            A failure caused by us or a billing-provider migration does not forfeit the
            lock. A lapsed founder re-subscribes at list. The founders row is
            cosmetic, never a capability.
          </FaqEntry>
          <FaqEntry question="Who appears in the founders row?">
            Only founders who tick the box at checkout; it starts unticked, and you can
            take yourself out from your account at any time. Everyone else counts toward
            the number at the end of the row. The pictures are served from this site, so
            loading the page never asks GitHub or Google for them.
          </FaqEntry>
          <FaqEntry question="What if Dormouse Hosted shuts down?">
            We will stop renewals and refund the unused portion of prepaid subscriptions,
            with at least 30 days’ notice unless an urgent legal or security requirement
            prevents it. The Relay is source-available and the{" "}
            <a href={sitePath("/self-host")} className={LINK_CLASS}>
              self-hosting runbook
            </a>{" "}
            is published if you want to run your own Relay. Spoken alarms fall back to
            your system voice. Self-hosting does not replace your refund.
          </FaqEntry>
          <FaqEntry question="Do you sell team or enterprise plans?">
            Not on this page. Org accounts, SSO, and audit export are a separate piece of work. If
            you need them, email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK_CLASS}>{SUPPORT_EMAIL}</a> and say
            what you need — that is how I will know what to build.
          </FaqEntry>
        </div>
      </section>

      {checkoutTodo ? <CheckoutTodo tier={checkoutTodo} onClose={closeTodo} /> : null}
    </DocsLayout>
  );
}
