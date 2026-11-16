/**
 * The plan cards: Free, then Hosted, then Founding, as `/hosted#pricing`
 * shows them and Hosted's `/enroll` sells them to an account with no plan.
 *
 * See docs/specs/pricing.md -> Plan cards.
 */
import { useState, type ReactNode } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import {
  ACCENT_TEXT_CLASS,
  ACTION_CLASS,
  CARD_ACCENT_CLASS,
  CARD_CLASS,
  CARD_MUTED_TEXT_CLASS,
  DASHED_ROW_CLASS,
  LINK_CLASS,
} from "dormouse-lib/site/docs-tokens";
import type { Cohort, Founder, Founders } from "../lib/hosted-cohorts";
import {
  FOUNDING_COHORT_SIZE,
  HOSTED_MONTHLY,
  HOSTED_YEARLY,
  YEARLY_SAVING,
  foundingTier,
  type Tier,
} from "../lib/hosted-pricing";
import { POCKET_PLAYGROUND_PATH } from "../lib/playground-routing";
import { sitePath } from "../lib/site-meta";

/** What a plan buys, one ticked line each. */
function Includes({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mt-4 text-sm">
      {items.map((item, i) => (
        <li
          key={i}
          className={`flex gap-2.5 py-2 leading-snug ${DASHED_ROW_CLASS}`}
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
  above?: ReactNode;
  price: ReactNode;
  below: ReactNode;
  children: ReactNode;
  action: ReactNode;
  footnote: string;
}) {
  return (
    <div className={`flex flex-col ${accent ? CARD_ACCENT_CLASS : CARD_CLASS}`}>
      <h3 className={`font-display text-sm tracking-widest uppercase ${ACCENT_TEXT_CLASS}`}>{name}</h3>
      <div className="mt-3 flex items-center @2xl:min-h-15">{above}</div>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2">{price}</p>
      <div className={`mt-1 text-sm @2xl:min-h-5 ${CARD_MUTED_TEXT_CLASS}`}>{below}</div>
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

/** What a buy button does: `onBuy` on the click, then on to `href`, where there is one. */
export type Buy = { onBuy: (tier: Tier) => void; href: (tier: Tier) => string | null };

/**
 * "Buy" plus what it buys on the label a screen reader reads, since it hears
 * the buttons out of their cards. A link once checkout is open.
 */
function BuyButton({ tier, label, buy }: { tier: Tier; label: string; buy: Buy }) {
  const href = buy.href(tier);
  return href ? (
    <a href={href} onClick={() => buy.onBuy(tier)} aria-label={`Buy ${tier.name}`} className={ACTION_CLASS}>
      {label}
    </a>
  ) : (
    <button
      type="button"
      onClick={() => buy.onBuy(tier)}
      aria-label={`Buy ${tier.name}`}
      className={ACTION_CLASS}
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

/** A link to a page of this site; from another origin (`site`), absolute and in a new tab. */
type SiteLink = (path: string) => { href: string; target?: string; rel?: string };

function FreeCard({ to, action, footnote }: { to: SiteLink; action: ReactNode; footnote: string }) {
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
      action={action}
      footnote={footnote}
    >
      <Includes
        items={[
          <>
            <a {...to(POCKET_PLAYGROUND_PATH)} className={LINK_CLASS}>Pocket</a> and push
            notifications on your phone with a{" "}
            <a {...to("/self-host")} className={LINK_CLASS}>self-hosted Relay</a>
          </>,
          "Spoken alarms in your system voice",
          "No network connection until you turn one on",
        ]}
      />
    </PlanCard>
  );
}

function HostedCard({ to, buy }: { to: SiteLink; buy: Buy }) {
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
      action={<BuyButton tier={tier} label="Get Hosted" buy={buy} />}
      footnote="30-day refund"
    >
      <Includes
        items={[
          <>
            <a {...to(POCKET_PLAYGROUND_PATH)} className={LINK_CLASS}>Pocket</a> and push
            notifications on your phone — we’ll run the server for you
          </>,
          "High-quality natural speech synthesis",
          "One account for your whole personal fleet of machines",
        ]}
      />
    </PlanCard>
  );
}

function FoundingCard({ tier, cohort, buy }: { tier: Tier; cohort: Cohort; buy: Buy }) {
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
      action={<BuyButton tier={tier} label="Become a founder" buy={buy} />}
      footnote="30-day refund"
    >
      <FoundersRow founders={cohort.founders} />
      <Includes
        items={[
          "Everything in Hosted",
          "An optional place in the founders row",
        ]}
      />
    </PlanCard>
  );
}

/**
 * Free, then Hosted, then Founding: side by side once their container is
 * `@2xl`, stacked in the same order below it.
 */
export function PlanCards({
  cohort,
  buy,
  founding = foundingTier(),
  free,
  site = "",
}: {
  cohort: Cohort;
  buy: Buy;
  /** Founding at the price it sells at; null leaves its card out. */
  founding?: Tier | null;
  /** The Free card's button, to a page of the site, and the line under it; the download by default. */
  free?: { label: string; path: string; footnote: string };
  /** The site's origin, for cards shown on another one. */
  site?: string;
}) {
  const to: SiteLink = (path) =>
    site ? { href: site + sitePath(path), target: "_blank", rel: "noopener" } : { href: sitePath(path) };
  return (
    <div className="@container">
      <div className={`grid gap-4 ${founding ? "@2xl:grid-cols-3" : "@2xl:grid-cols-2"}`}>
        <FreeCard
          to={to}
          action={
            free ? (
              <a {...to(free.path)} className={ACTION_CLASS}>{free.label}</a>
            ) : (
              <a href={`${sitePath("/")}#download`} className={ACTION_CLASS}>Download</a>
            )
          }
          footnote={free?.footnote ?? "Win/Mac/Linux or VS Code"}
        />
        <HostedCard to={to} buy={buy} />
        {founding && <FoundingCard tier={founding} cohort={cohort} buy={buy} />}
      </div>
    </div>
  );
}
