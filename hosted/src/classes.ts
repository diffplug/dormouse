import {
  ACTION_CLASS,
  FIELD_CLASS,
  FIELD_TEXT_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
  siteButton,
} from "dormouse-lib/site/docs-tokens";

/** Hosted's form pieces, composed from the docs pages' tokens. */
export const PRIMARY_CLASS = `${ACTION_CLASS} mt-5`;
/** A field label's face, also a term in an account's details. */
export const LABEL_TEXT_CLASS = `font-display text-sm ${MUTED_TEXT_CLASS}`;
export const LABEL_CLASS = `mt-5 mb-2 block ${LABEL_TEXT_CLASS}`;
export const INPUT_CLASS = `${FIELD_CLASS} ${FIELD_TEXT_CLASS} read-only:border-dashed`;
export const HELP_CLASS = `mb-4 ${MUTED_TEXT_CLASS}`;
export const BUTTON_CLASS = siteButton({ tone: "neutral", size: "fit" });
export const TEXT_BUTTON_CLASS = `inline-flex min-h-11 items-center disabled:opacity-50 ${LINK_CLASS}`;
export const HEADING_CLASS = "mb-2 font-display text-xl";
export const CHECK_CLASS = "mt-1 size-4 shrink-0 accent-[var(--docs-accent)]";
