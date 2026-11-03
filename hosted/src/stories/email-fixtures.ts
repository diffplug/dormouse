/** Who every Hosted email is from: `postmarkEmail` sends `EMAIL_FROM` (`hosted/wrangler.jsonc`), whatever a message names. */
export const EMAIL_FROM = "signin@dormouse.sh";

/** The sign-in email `@pgstencil/auth` writes; `hosted/server/tests/workers.test.ts` holds it to what is sent. */
export const signInEmail = (to: string, code: string) => ({
  from: EMAIL_FROM,
  to: [to],
  subject: "Your Dormouse Hosted sign-in code",
  text: `Your sign-in code is ${code}. It expires in 10 minutes.`,
  html: `<p>Your sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
});
