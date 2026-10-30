// The EEA and UK withdrawal wording the Terms, the account app's checkout and
// billing pages, and the emailed acknowledgement share, so a statement never
// differs between them.

export const SUPPORT_EMAIL = "support@dormouse.sh";

export const DIFFPLUG_POSTAL_ADDRESS = "DiffPlug LLC, 447 Sutter St Ste 405, San Francisco, CA 94108, United States";

/** The statement the online withdrawal function submits for the consumer. */
export const WITHDRAWAL_STATEMENT = "I give notice that I withdraw from my contract for Dormouse Hosted.";

/** The optional model withdrawal form, for email or post. */
export const MODEL_WITHDRAWAL_FORM = `To ${DIFFPLUG_POSTAL_ADDRESS}; ${SUPPORT_EMAIL}: ${WITHDRAWAL_STATEMENT} Ordered on: ____. Name: ____. Address: ____. Date: ____. Signature, only if sent on paper: ____.`;
