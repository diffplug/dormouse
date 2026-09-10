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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CloudArrowUpIcon,
  CodeIcon,
  SpeakerHighIcon,
} from "@phosphor-icons/react";
import { type MetaArgs } from "react-router";
import DocsLayout from "../components/DocsLayout";
import { HostingRequirementNotice } from "../components/HostingRequirementNotice";
import { AnchoredHeading } from "../components/MarkdownDocument";
import { NotifySignupForm } from "../components/NotifySignupForm";
import {
  ACCENT_BORDER_CLASS,
  ACCENT_TEXT_CLASS,
  ACTION_TEXT_CLASS,
  BODY_TEXT_CLASS,
  CARD_CLASS,
  CARD_MUTED_TEXT_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
  NOTE_CLASS,
  NOTE_MUTED_TEXT_CLASS,
  TABLE_CLASS,
  TABLE_HEAD_ROW_CLASS,
  TABLE_ROW_CLASS,
  TABLE_WRAP_CLASS,
  TH_CLASS,
} from "../components/docs-tokens";
import { type TocEntry } from "../lib/docs-pages";
import { fetchCohortSeats, type CohortSeats } from "../lib/hosted-cohorts";
import {
  cohortSize,
  pricingJsonLd,
  tiersOnSale,
  type CohortId,
  type Tier,
} from "../lib/hosted-pricing";
import { canonicalUrl, siteMeta, sitePath } from "../lib/site-meta";

const PAGE_PATH = "/hosted";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Dormouse Hosted",
    description:
      "The terminal is free. Dormouse Hosted adds managed voices for spoken alarms and, "
      + "later, a managed Relay for Pocket — from $10 a month, with founding prices while they last.",
  });
}

export const HOSTED_TOC: TocEntry[] = [
  { id: "pricing", text: "What it costs", children: [] },
  { id: "voice", text: "Managed voices", children: [] },
  { id: "remote-control", text: "The managed Relay", children: [] },
  { id: "self-hosting", text: "Self-hosting stays free", children: [] },
  { id: "faq", text: "Questions", children: [] },
];

/**
 * Seats remaining in this tier's open cohort.
 *
 * The line is reserved at prerender and filled after hydration, so the count
 * landing does not shove the table — and an endpoint with nothing to say
 * leaves it empty rather than printing an error a buyer cannot act on.
 */
function SeatsLeft({ cohort, seats }: { cohort: CohortId | undefined; seats: CohortSeats | null }) {
  if (!cohort) return null;
  const left = seats?.[cohort];
  return (
    <p className={`mt-2 min-h-5 text-sm ${MUTED_TEXT_CLASS}`}>
      {left === undefined ? null : `${left} of ${cohortSize(cohort)} left at this price`}
    </p>
  );
}

/**
 * What a buy button does until checkout ships.
 *
 * Deliberately loud about being unfinished: the prices are real and the plan
 * is specified, but purchase, the licence, and activation are a later stage,
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

  // The panel spells its own surface rather than taking `CARD_CLASS`: a card's
  // translucent tint over a dimmed page left the table legible straight
  // through it.
  const panelClass =
    "max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-xl border "
    + "border-[var(--color-text)]/15 bg-[var(--color-bg)] p-5 text-[var(--color-text)] sm:p-6";

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
        className={panelClass}
        onClick={(event) => event.stopPropagation()}
      >
        <p className={`font-display text-sm tracking-wide ${ACCENT_TEXT_CLASS}`}>TODO</p>
        <h2 id="checkout-todo-title" className="mt-1 font-display text-2xl">
          Checkout is not wired up yet
        </h2>
        <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
          {tier.name} is priced and specified, but nothing here takes payment: purchase,
          the signed licence, and activation are the next stage of work. You have not been
          charged, and no seat has been taken.
        </p>
        <p className={`mt-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
          Want to hear when it opens? I announce Dormouse on my personal devlog. This is
          not a product-only waitlist; you’ll also receive other devlog posts.
        </p>
        <div className="mt-4">
          <NotifySignupForm
            buttonLabel="Continue to nedshed.dev"
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
  const tiers = tiersOnSale();
  const [seats, setSeats] = useState<CohortSeats | null>(null);
  const [checkoutTodo, setCheckoutTodo] = useState<Tier | null>(null);
  const closeTodo = useCallback(() => setCheckoutTodo(null), []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCohortSeats(controller.signal).then(setSeats);
    return () => controller.abort();
  }, []);

  return (
    <DocsLayout
      activePath={PAGE_PATH}
      title="Dormouse Hosted"
      intro={<HostingRequirementNotice mode="planned-hosted" />}
      toc={HOSTED_TOC}
    >
      {/* Prerendered with the prices it repeats, so an assistant fetching the
          page can quote them without running the counters. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: pricingJsonLd(canonicalUrl(PAGE_PATH)) }}
      />

      <section>
        <AnchoredHeading id="pricing" spacing="mt-0 mb-3">What it costs</AnchoredHeading>
        <p className={`mb-6 ${BODY_TEXT_CLASS}`}>
          The terminal is free and stays free. One plan — Individual — buys the two things
          I run for you: managed voices for spoken alarms today, and the managed Relay
          once it ships. One licence covers every machine you use.
        </p>

        <aside className={`${NOTE_CLASS} mb-6`}>
          <p className={`text-sm leading-relaxed ${NOTE_MUTED_TEXT_CLASS}`}>
            <span className="font-display">Checkout is not open yet.</span> The prices
            below are final, but the buy buttons only explain what is left to build.
            Nothing takes payment.
          </p>
        </aside>

        <div className={TABLE_WRAP_CLASS}>
          <table className={TABLE_CLASS}>
            <thead>
              <tr className={TABLE_HEAD_ROW_CLASS}>
                <th className={TH_CLASS}>Plan</th>
                <th className={TH_CLASS}>Price</th>
                <th className={TH_CLASS}>
                  <span className="sr-only">Buy</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier) => (
                <tr key={tier.id} className={TABLE_ROW_CLASS}>
                  <td className="py-5 pr-4 align-top">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-lg">{tier.name}</span>
                      {tier.recommended ? (
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs font-display ${ACCENT_BORDER_CLASS} ${ACCENT_TEXT_CLASS}`}
                        >
                          Recommended
                        </span>
                      ) : null}
                    </div>
                    <p className={`mt-1 max-w-sm text-sm ${MUTED_TEXT_CLASS}`}>{tier.blurb}</p>
                    <SeatsLeft cohort={tier.cohort} seats={seats} />
                  </td>
                  <td className="py-5 pr-4 align-top whitespace-nowrap">
                    <div className="font-display text-2xl">${tier.price}</div>
                    <div className={`text-sm ${MUTED_TEXT_CLASS}`}>{tier.cadence}</div>
                    {tier.listPrice ? (
                      <div className={`mt-1 text-sm ${MUTED_TEXT_CLASS}`}>
                        <s>${tier.listPrice}</s> list
                      </div>
                    ) : null}
                  </td>
                  <td className="py-5 align-top">
                    <button
                      type="button"
                      onClick={() => setCheckoutTodo(tier)}
                      className={`inline-flex min-h-12 items-center rounded-md border bg-[var(--docs-accent)]/10 px-5 py-3 font-display hover:bg-[var(--docs-accent)]/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--docs-accent)] ${ACCENT_BORDER_CLASS} ${ACTION_TEXT_CLASS}`}
                    >
                      Buy {tier.name}
                    </button>
                    <p className={`mt-2 text-sm ${MUTED_TEXT_CLASS}`}>30-day refund</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className={`mt-5 text-sm ${MUTED_TEXT_CLASS}`}>
          Founding prices are for people who paid before Hosted existed. The annual ladder
          rises $10 with each cohort of 100 and closes for good when it reaches the $100
          list price or the managed Relay ships, whichever comes first; permanent seats
          stop at 100. Team and enterprise plans are not sold here yet.
        </p>
      </section>

      <section className="mt-14 border-t border-[var(--color-text)]/15 pt-10">
        <SpeakerHighIcon
          size={28}
          weight="duotone"
          className={`mb-3 ${ACCENT_TEXT_CLASS}`}
          aria-hidden="true"
        />
        <AnchoredHeading id="voice" spacing="mt-0 mb-3">Managed voices</AnchoredHeading>
        <p className={`mb-3 font-display text-sm ${ACCENT_TEXT_CLASS}`}>Included with any plan</p>
        <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
          Dormouse speaks an unattended terminal’s name using your browser or system voice
          today, free and with no account. A plan swaps that for a natural ElevenLabs
          voice on every machine you activate, chosen per pane from a curated set with a
          default of your own. I hold the vendor key, so there is no second account to set
          up or pay for.
        </p>
        <p className={`mb-4 leading-relaxed ${MUTED_TEXT_CLASS}`}>
          What leaves your computer is exactly the short spoken label — the terminal’s
          name — and the id of the voice that should say it. Never terminal output, never
          a notification body, never a session id. The app discloses this before the first
          request, and clips are cached on your machine so a repeated label makes no
          second one.
        </p>
        <p className={`leading-relaxed ${MUTED_TEXT_CLASS}`}>
          The system voice stays, and stays the fallback: offline, past the daily fair-use
          cap, or if my endpoint fails, Dormouse speaks in the system voice rather than
          going silent.
        </p>
      </section>

      <section className="mt-14 border-t border-[var(--color-text)]/15 pt-10">
        <CloudArrowUpIcon
          size={28}
          weight="duotone"
          className={`mb-3 ${ACCENT_TEXT_CLASS}`}
          aria-hidden="true"
        />
        <AnchoredHeading id="remote-control" spacing="mt-0 mb-3">
          The managed Relay
        </AnchoredHeading>
        <p className={`mb-3 font-display text-sm ${ACCENT_TEXT_CLASS}`}>
          Ships after the self-host public beta and an independent review
        </p>
        <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
          Dormouse Pocket puts your terminals on your phone. It needs a Relay to connect
          the two, and today that means running one yourself. Hosted will run it for you:
          enrollment of your own computers, sealed push notifications, and Pocket without
          a tailnet. Your terminals still run on your own awake, online computer.
        </p>
        <p className={`leading-relaxed ${MUTED_TEXT_CLASS}`}>
          Members pay nothing extra when it ships — it joins the plan you already have. It
          is deliberately last: a Relay I operate is a Relay that sees connection metadata,
          so it waits on the self-hosted beta and an independent review of the trust model.
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
          <a href={sitePath("/docs/dor")} className={LINK_CLASS}>
            dor CLI
          </a>
          , browser panes, the notepad, alerts with your system voice, the Relay itself,
          and Pocket over a Relay you run.
        </p>
        <p className={`leading-relaxed ${CARD_MUTED_TEXT_CLASS}`}>
          The Relay stays in the repository under FSL-1.1-MIT and free for internal use.
          Hosted is the paid convenience, not the replacement — if you would rather
          operate it, the{" "}
          <a href={sitePath("/docs/self-host")} className={LINK_CLASS}>
            self-hosting guide
          </a>{" "}
          is ready now.
        </p>
      </section>

      <section className="mt-14">
        <AnchoredHeading id="faq" spacing="mt-0 mb-6">Questions</AnchoredHeading>
        <div className="grid gap-5">
          <FaqEntry question="What does “forever” mean on the permanent plan?">
            For as long as Dormouse Hosted operates. It grants everything the Individual
            plan ever contains, features added later included, and never expires while I
            run the service. It is personal and non-transferable, and it never grants team
            or enterprise capability. If I ever stop, the Relay is still source-available
            under FSL-1.1-MIT, so you can run it yourself.
          </FaqEntry>
          <FaqEntry question="Refunds and cancellation?">
            30 days, on every plan, permanent included. Monthly and annual auto-renew and
            you can cancel any time — access runs to the end of the period you paid for. A
            refund revokes the licence and returns the seat to its cohort.
          </FaqEntry>
          <FaqEntry question="What exactly does a founding price lock?">
            The price you paid, for as long as the subscription stays active. It survives
            every later price change; a failed renewal gets 30 days of grace before the
            lock is lost, and a lapsed founder re-subscribes at list. Founding badges are
            cosmetic — in the app and on the credits page, never a capability.
          </FaqEntry>
          <FaqEntry question="What if Dormouse Hosted shuts down?">
            The Relay is source-available and the{" "}
            <a href={sitePath("/docs/self-host")} className={LINK_CLASS}>
              self-hosting runbook
            </a>{" "}
            is published, so remote control survives me. Spoken alarms fall back to your
            system voice, which needs nothing from me at all.
          </FaqEntry>
          <FaqEntry question="Do you sell team or enterprise plans?">
            Not yet. Org accounts, SSO, and audit export are a separate piece of work and
            are not sold through this page. If you need them,{" "}
            <a
              href="https://github.com/diffplug/dormouse/issues"
              className={LINK_CLASS}
              target="_blank"
              rel="noopener noreferrer"
            >
              open an issue
            </a>{" "}
            and say so — that is how I will know what to build.
          </FaqEntry>
        </div>
      </section>

      {checkoutTodo ? <CheckoutTodo tier={checkoutTodo} onClose={closeTodo} /> : null}
    </DocsLayout>
  );
}
