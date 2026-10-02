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
  CheckIcon,
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
  BODY_TEXT_CLASS,
  CARD_ACCENT_CLASS,
  CARD_CLASS,
  CARD_MUTED_TEXT_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
} from "../components/docs-tokens";
import { type TocEntry } from "../lib/docs-pages";
import { POCKET_PLAYGROUND_PATH } from "../lib/playground-routing";
import {
  fetchCohort,
  type Cohort,
  type Founder,
  type Founders,
} from "../lib/hosted-cohorts";
import {
  FOUNDING_COHORT_SIZE,
  HOSTED_MONTHLY,
  HOSTED_YEARLY,
  YEARLY_SAVING,
  foundingTier,
  pricingJsonLd,
  type Tier,
} from "../lib/hosted-pricing";
import { canonicalUrl, siteMeta, sitePath } from "../lib/site-meta";

const PAGE_PATH = "/hosted";

/** Where team and enterprise inquiries go; nothing on this page sells them. */
const TEAMS_EMAIL = "teams@dormouse.sh";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Dormouse Hosted",
    description:
      "The terminal is free. Dormouse Hosted adds a managed Relay for Pocket and managed voices "
      + "for spoken alarms — from $10 a month, with founding prices while they last.",
  });
}

export const HOSTED_TOC: TocEntry[] = [
  { id: "pricing", text: "What it costs", children: [] },
  { id: "voice", text: "Managed voices", children: [] },
  { id: "remote-control", text: "The managed Relay", children: [] },
  { id: "self-hosting", text: "Self-hosting stays free", children: [] },
  { id: "account", text: "Your Hosted account", children: [] },
  { id: "faq", text: "Questions", children: [] },
];

/** What a plan buys, one ticked line each. */
function Includes({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="mt-4 text-sm">
      {items.map((item, i) => (
        <li
          key={i}
          className="flex gap-2.5 border-b border-dashed border-[var(--color-text)]/15 py-2 leading-snug"
        >
          <CheckIcon
            size={16}
            weight="bold"
            className={`mt-0.5 shrink-0 ${ACCENT_TEXT_CLASS}`}
            aria-hidden="true"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

const CARD_ACTION_CLASS =
  "inline-flex min-h-12 w-full items-center justify-center rounded-md border px-4 py-3 "
  + "font-display hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 "
  + `focus-visible:outline-[var(--docs-accent)] ${ACCENT_BORDER_CLASS} ${ACCENT_TEXT_CLASS}`;

/**
 * One plan, as a card in the row.
 *
 * The slots above and below the price are reserved on every card, but only
 * while the cards are a row: side by side, the three prices and the three
 * buttons each sit on one line; stacked, a reserve would be a blank gap.
 */
function PlanCard({
  name,
  accent = false,
  above,
  price,
  below,
  children,
  action,
  footnote,
}: {
  name: string;
  accent?: boolean;
  above?: React.ReactNode;
  price: React.ReactNode;
  below: React.ReactNode;
  children: React.ReactNode;
  action: React.ReactNode;
  footnote: string;
}) {
  return (
    <div className={`flex flex-col ${accent ? CARD_ACCENT_CLASS : CARD_CLASS}`}>
      <h3 className={`font-display text-sm tracking-widest uppercase ${ACCENT_TEXT_CLASS}`}>{name}</h3>
      <div className="mt-3 flex items-center md:min-h-15">{above}</div>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2">{price}</p>
      <div className={`mt-1 text-sm md:min-h-5 ${CARD_MUTED_TEXT_CLASS}`}>{below}</div>
      {children}
      {/* `mt-auto` lines the three buttons up however tall the cards run. */}
      <div className="mt-auto pt-5">
        {action}
        <p className={`mt-2 text-center text-sm ${CARD_MUTED_TEXT_CLASS}`}>{footnote}</p>
      </div>
    </div>
  );
}

function Price({ tier }: { tier: Pick<Tier, "price" | "per" | "listPrice"> }) {
  return (
    <>
      {tier.listPrice ? (
        <s className={`font-display text-xl ${CARD_MUTED_TEXT_CLASS}`}>${tier.listPrice}</s>
      ) : null}
      <span className="font-display text-4xl">${tier.price}</span>
      {tier.per ? <span className={`text-sm ${CARD_MUTED_TEXT_CLASS}`}>{tier.per}</span> : null}
    </>
  );
}

/**
 * "Buy" plus what it buys on the label a screen reader reads, since it hears
 * the buttons out of their cards.
 */
function BuyButton({ tier, label, onBuy }: { tier: Tier; label: string; onBuy: (tier: Tier) => void }) {
  return (
    <button
      type="button"
      onClick={() => onBuy(tier)}
      aria-label={`Buy ${tier.name}`}
      className={CARD_ACTION_CLASS}
    >
      {label}
    </button>
  );
}

function BillingToggle({ yearly, onChange }: { yearly: boolean; onChange: (yearly: boolean) => void }) {
  const options = [
    { label: "Monthly", value: false },
    { label: "Yearly", value: true },
  ];
  return (
    <div
      role="group"
      aria-label="Billing period"
      className="inline-flex rounded-lg border border-[var(--color-text)]/15 p-0.5 text-sm"
    >
      {options.map(({ label, value }) => (
        <button
          key={label}
          type="button"
          aria-pressed={yearly === value}
          onClick={() => onChange(value)}
          className={`min-h-9 rounded-md px-4 font-display focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--docs-accent)] ${
            yearly === value ? "bg-[var(--color-text)]/15" : CARD_MUTED_TEXT_CLASS
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const AVATAR_CLASS = "-ml-1.5 size-7 shrink-0 rounded-full ring-2 ring-[var(--color-bg)]";

function FounderAvatar({ founder }: { founder: Founder }) {
  // A proxied image can still 404 after its founder opts out; the initial
  // keeps their place in the row rather than leaving a broken-image glyph.
  const [broken, setBroken] = useState(false);
  if (founder.avatar && !broken) {
    return (
      <img
        src={founder.avatar}
        alt=""
        title={founder.name}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={`${AVATAR_CLASS} bg-[var(--color-text)]/10 object-cover`}
      />
    );
  }
  return (
    <span
      title={founder.name}
      aria-hidden="true"
      className={`${AVATAR_CLASS} inline-flex items-center justify-center bg-[var(--color-text)]/15 font-display text-xs`}
    >
      {founder.name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * The founders who opted in at checkout, then `+N` for everyone else.
 *
 * Absent until the endpoint answers, and absent for good when it cannot: an
 * empty row would read as "nobody has bought", which is a claim, not a gap.
 */
function FoundersRow({ founders }: { founders: Founders | null }) {
  if (!founders) return null;
  const rest = founders.total - founders.shown.length;
  return (
    <div
      role="img"
      aria-label={`${founders.total} ${founders.total === 1 ? "founder" : "founders"} so far`}
      className="mt-4 flex flex-wrap gap-y-1.5 pl-1.5"
    >
      {founders.shown.map((founder, i) => (
        <FounderAvatar key={i} founder={founder} />
      ))}
      {rest > 0 ? (
        <span
          className={`${AVATAR_CLASS} inline-flex w-auto min-w-7 items-center justify-center bg-[var(--color-text)] px-1.5 font-display text-[11px] text-[var(--color-bg)]`}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}

function FreeCard() {
  return (
    <PlanCard
      name="Free"
      above={
        <p className="text-sm leading-snug">
          The whole terminal is <span className="whitespace-nowrap">FSL-1.1-MIT</span>,{" "}
          <a
            href="https://github.com/diffplug/dormouse"
            className={LINK_CLASS}
            target="_blank"
            rel="noopener noreferrer"
          >
            easy to fork
          </a>
        </p>
      }
      price={<span className="font-display text-4xl">$0</span>}
      below="Forever. No account, no card."
      action={
        <a href={`${sitePath("/")}#download`} className={CARD_ACTION_CLASS}>
          Download
        </a>
      }
      footnote="Win/Mac/Linux or VS Code"
    >
      <Includes
        items={[
          <>
            <a href={sitePath(POCKET_PLAYGROUND_PATH)} className={LINK_CLASS}>Pocket</a> and push
            notifications on your phone with a{" "}
            <a href={sitePath("/self-host")} className={LINK_CLASS}>self-hosted Relay</a>
          </>,
          "Spoken alarms in your system voice",
          "Zero network requests unless you enroll with a Relay",
        ]}
      />
    </PlanCard>
  );
}

function HostedCard({ onBuy }: { onBuy: (tier: Tier) => void }) {
  // Monthly is the prerendered default: it is the reference price every other
  // number on the page is read against.
  const [yearly, setYearly] = useState(false);
  const tier = yearly ? HOSTED_YEARLY : HOSTED_MONTHLY;
  return (
    <PlanCard
      name="Hosted"
      accent
      above={<BillingToggle yearly={yearly} onChange={setYearly} />}
      price={<Price tier={tier} />}
      below={
        yearly
          ? "Two months free against monthly"
          : `Save $${YEARLY_SAVING} by paying yearly`
      }
      action={<BuyButton tier={tier} label="Get Hosted" onBuy={onBuy} />}
      footnote="30-day refund"
    >
      <Includes
        items={[
          <>
            <a href={sitePath(POCKET_PLAYGROUND_PATH)} className={LINK_CLASS}>Pocket</a> and push
            notifications on your phone — we’ll run the server for you
          </>,
          "High-quality ElevenLabs speech synthesis",
          "One license for your whole personal fleet of machines",
        ]}
      />
    </PlanCard>
  );
}

function FoundingCard({ cohort, onBuy }: { cohort: Cohort; onBuy: (tier: Tier) => void }) {
  const tier = foundingTier();
  return (
    <PlanCard
      name="Founding"
      above={<p className="font-display text-lg leading-snug">Your price, locked</p>}
      price={<Price tier={tier} />}
      below={
        cohort.seatsLeft !== null
          ? `${cohort.seatsLeft} of ${FOUNDING_COHORT_SIZE} seats left at $${tier.price}`
          : null
      }
      action={<BuyButton tier={tier} label="Become a founder" onBuy={onBuy} />}
      footnote="30-day refund"
    >
      <FoundersRow founders={cohort.founders} />
      <Includes
        items={[
          "Everything in Hosted",
          "A founding badge and an optional avatar here",
        ]}
      />
    </PlanCard>
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
          the signed license, and activation are the next stage of work. You have not been
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
  const [cohort, setCohort] = useState<Cohort>({ seatsLeft: null, founders: null });
  const [checkoutTodo, setCheckoutTodo] = useState<Tier | null>(null);
  const closeTodo = useCallback(() => setCheckoutTodo(null), []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCohort(controller.signal).then(setCohort);
    return () => controller.abort();
  }, []);

  return (
    <DocsLayout
      activePath={PAGE_PATH}
      title="Dormouse Hosted"
      intro={<HostingRequirementNotice mode="hosted" />}
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
          The terminal is free and stays free. Hosted is for when you walk away: a terminal
          needs you, your phone buzzes, and you answer with your thumb, with no server of
          your own to run.
        </p>

        {/* Free, then Hosted, then Founding: side by side from `md`, stacked
            in the same order on a phone. */}
        <div className="grid gap-4 md:grid-cols-3">
          <FreeCard />
          <HostedCard onBuy={setCheckoutTodo} />
          <FoundingCard cohort={cohort} onBuy={setCheckoutTodo} />
        </div>

        <p className={`mt-5 text-sm ${MUTED_TEXT_CLASS}`}>
          The founding price rises as each cohort of 100 sells out, and founding closes for
          good at the $100 list price. Whatever you paid stays locked. For team and enterprise
          plans, email <a href={`mailto:${TEAMS_EMAIL}`} className={LINK_CLASS}>{TEAMS_EMAIL}</a>.
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
          Free and with no account, Dormouse speaks an unattended terminal’s name in your
          browser or system voice. A plan swaps that for a natural ElevenLabs
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
        <p className={`mb-3 font-display text-sm ${ACCENT_TEXT_CLASS}`}>Included with any plan</p>
        <p className={`mb-4 ${BODY_TEXT_CLASS}`}>
          Dormouse Pocket puts your terminals on your phone. It needs a Relay to connect
          the two, and Hosted runs it for you: enrollment of your own computers, sealed
          push notifications, and Pocket without a tailnet. Your terminals still run on
          your own awake, online computer.
        </p>
        <p className={`leading-relaxed ${MUTED_TEXT_CLASS}`}>
          Terminal traffic is end-to-end encrypted between your computer and your phone,
          so the Relay I operate carries it without reading it. What it does see is
          connection metadata, and the trust model linked at the top of this page lists
          exactly which.
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
          , browser panes, the notepad, alerts with your system voice, the Relay itself,
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
          you to the devlog.
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
            30 days, on every plan. Monthly, yearly, and founding all auto-renew and
            you can cancel any time — access runs to the end of the period you paid for. A
            refund revokes the license and returns the seat to its cohort.
          </FaqEntry>
          <FaqEntry question="What exactly does a founding price lock?">
            The price you paid, for as long as the subscription stays active. It survives
            every later price change; a failed renewal gets 30 days of grace before the
            lock is lost, and a lapsed founder re-subscribes at list. Founding badges are
            cosmetic — in the app and on the credits page, never a capability.
          </FaqEntry>
          <FaqEntry question="Who appears in the founders row?">
            Only founders who tick the box at checkout; it starts unticked, and you can
            take yourself out from your account at any time. Everyone else counts toward
            the number at the end of the row. The pictures are served from this site, so
            loading the page never tells GitHub or Google you visited.
          </FaqEntry>
          <FaqEntry question="What if Dormouse Hosted shuts down?">
            The Relay is source-available and the{" "}
            <a href={sitePath("/self-host")} className={LINK_CLASS}>
              self-hosting runbook
            </a>{" "}
            is published, so remote control survives me. Spoken alarms fall back to your
            system voice, which needs nothing from me at all.
          </FaqEntry>
          <FaqEntry question="Do you sell team or enterprise plans?">
            Not on this page. Org accounts, SSO, and audit export are a separate piece of work. If
            you need them, email{" "}
            <a href={`mailto:${TEAMS_EMAIL}`} className={LINK_CLASS}>{TEAMS_EMAIL}</a> and say
            what you need — that is how I will know what to build.
          </FaqEntry>
        </div>
      </section>

      {checkoutTodo ? <CheckoutTodo tier={checkoutTodo} onClose={closeTodo} /> : null}
    </DocsLayout>
  );
}
