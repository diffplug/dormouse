// The EEA and UK withdrawal wording the Terms, the account app's checkout and
// billing pages, and the emailed confirmation and acknowledgement share, so a
// statement never differs between them.

export const SUPPORT_EMAIL = "support@dormouse.sh";

export const DIFFPLUG_POSTAL_ADDRESS = "DiffPlug LLC, 447 Sutter St Ste 405, San Francisco, CA 94108, United States";

/** The statement the online withdrawal function submits for the consumer. */
export const WITHDRAWAL_STATEMENT = "I give notice that I withdraw from my contract for Dormouse Hosted.";

/** The right as checkout discloses it before purchase and the purchase email repeats it. */
export const WITHDRAWAL_RIGHT = `In the EEA or UK, you can withdraw within 14 days of buying without giving a reason, and we refund every payment, including tax, with no deduction for the time you used. Use Withdraw from contract on your billing page, or email ${SUPPORT_EMAIL}, even if you can no longer sign in.`;

/** What introduces the model form. */
export const MODEL_FORM_INTRO = "You may copy this into an email or a letter. Using it is optional.";

/** The optional model withdrawal form, for email or post. */
export const MODEL_WITHDRAWAL_FORM = `To ${DIFFPLUG_POSTAL_ADDRESS}; ${SUPPORT_EMAIL}: ${WITHDRAWAL_STATEMENT} Ordered on: ____. Name: ____. Address: ____. Date: ____. Signature, only if sent on paper: ____.`;
