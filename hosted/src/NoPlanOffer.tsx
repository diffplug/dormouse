import { ArrowSquareOutIcon, CheckIcon } from "@phosphor-icons/react";
import {
  ACCENT_TEXT_CLASS,
  ACTION_CLASS,
  CARD_ACCENT_CLASS,
  CARD_MUTED_TEXT_CLASS,
  DASHED_ROW_CLASS,
} from "dormouse-lib/site/docs-tokens";
import { foundingTier, LIST_MONTHLY } from "../../website/src/lib/hosted-pricing.ts";

/** The Hosted page's plan cards, in a new tab so this one keeps its code. */
export const HOSTED_PLANS_URL = "https://dormouse.sh/hosted/#pricing";

const VOICE = "A natural ElevenLabs voice for spoken alarms, on every computer you enroll";
const POCKET = "Dormouse Pocket on your phone through the managed Relay";
const PUSH = "Sealed push notifications when a terminal needs you";
const NO_LIMIT = "Every computer you use: no device limit, no per-device charge";

/**
 * What a plan would give the account that could not approve this computer,
 * leading with what Dormouse asked for. Coming back to this tab re-reads the
 * account, so a plan bought in the other one shows the digits here.
 */
export function NoPlanOffer({ purpose }: { purpose: "remote" | "voice" | undefined }) {
  const voice = purpose === "voice";
  const founding = foundingTier();
  return (
    <div className={CARD_ACCENT_CLASS}>
      <h2 className="font-display text-xl text-balance">
        {voice ? "Natural Voice" : "Remote control"} comes with Dormouse Hosted
      </h2>
      <ul className="mt-3 text-sm">
        {(voice ? [VOICE, POCKET, PUSH] : [POCKET, PUSH, NO_LIMIT, VOICE]).map((item) => (
          <li key={item} className={`flex gap-2.5 py-2 leading-snug ${DASHED_ROW_CLASS}`}>
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
      <p className="mt-5 flex flex-wrap items-baseline gap-x-2">
        <s className={`font-display text-xl ${CARD_MUTED_TEXT_CLASS}`}>${founding.listPrice}</s>
        <span className="font-display text-4xl">${founding.price}</span>
        <span className={`text-sm ${CARD_MUTED_TEXT_CLASS}`}>{founding.per}</span>
      </p>
      <p className={`mt-1 text-sm ${CARD_MUTED_TEXT_CLASS}`}>
        Founding price, locked while you stay subscribed. Or ${LIST_MONTHLY}/month.
      </p>
      <a
        className={`mt-5 gap-2 ${ACTION_CLASS}`}
        href={HOSTED_PLANS_URL}
        target="_blank"
        rel="noopener"
      >
        See Hosted plans
        <ArrowSquareOutIcon size={18} aria-hidden="true" />
      </a>
      <p className={`mt-2 text-center text-sm ${CARD_MUTED_TEXT_CLASS}`}>
        30-day refund. This code waits here while you look.
      </p>
    </div>
  );
}
