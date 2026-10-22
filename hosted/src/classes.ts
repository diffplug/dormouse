import {
  ACTION_CLASS,
  FIELD_CLASS,
  FIELD_TEXT_CLASS,
  MUTED_TEXT_CLASS,
} from "dormouse-lib/site/docs-tokens";

/** Hosted's form pieces, composed from the docs pages' tokens. */
export const PRIMARY_CLASS = `${ACTION_CLASS} mt-5`;
/** A field label's face, also a term in an account's details. */
export const LABEL_TEXT_CLASS = `font-display text-sm ${MUTED_TEXT_CLASS}`;
export const LABEL_CLASS = `mt-5 mb-2 block ${LABEL_TEXT_CLASS}`;
export const INPUT_CLASS = `${FIELD_CLASS} ${FIELD_TEXT_CLASS} read-only:border-dashed`;
export const HELP_CLASS = `mb-4 ${MUTED_TEXT_CLASS}`;
