// Policy values more than one bundle needs: the account Worker and its
// frontend, or the account and relay Workers. This module imports nothing, for
// the reason `./providers.js` does not either: `./policy` reaches the OAuth
// client secrets through `providerBindings`, and docs/specs/security-hosted.md
// -> "Origin boundary" has an auditor inspect the frontend import graph. The
// account screen takes its constants from here so that graph never walks back
// to the module holding the secrets.

// How long after signing in a login still counts as recent enough to connect a
// provider. The packed adapter enforces it as Better Auth's `session.freshAge`
// and the account screen gates its buttons on the same window, so the two would
// desync silently on a pgstencil bump: a UI that offers "connect" for a login
// the server has already stopped accepting 302s to /login?error=. One value,
// and `hosted/server/tests/policy.test.ts` pins it to what the adapter builds.
export const LOGIN_FRESH_AGE_MS = 10 * 60 * 1000;

// The recent-login window as the account screen and its errors spell it.
export const RECENT_LOGIN_WINDOW = `${LOGIN_FRESH_AGE_MS / 60_000} minutes`;

// How long an enrollment's device code lives (the relay mints it) and how long
// an approval waits for its poll (the account writes it).
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

// Seconds a Burrow waits between enrollment polls (the relay answers it from
// begin): inside `MIN_ENROLL_POLL_INTERVAL_S`–`MAX_ENROLL_POLL_INTERVAL_S`, or
// every shipped Burrow refuses the begin. The account screen re-reads an
// approval's result at the same pace.
export const ENROLLMENT_POLL_INTERVAL_S = 5;

// The Hosted terms version the sign-in notice names and an account accepts by
// continuing: the revision date both policy pages print
// (`website/src/components/HostedPolicyLayout.tsx`), which
// `hosted/server/tests/policy.test.ts` pins this to. A new version is a new
// acceptance row, never an edit of an old one.
export const TERMS_VERSION = "2026-10-28";

// Where Stripe returns the browser from Checkout and the customer portal: an
// account page on the account origin.
export const BILLING_RETURN_PATH = "/billing";

// Speaks one account may make per UTC day (the voice Worker's cap), which
// checkout discloses before purchase.
export const VOICE_DAILY_CAP = 500;

// Every billing route's answer while billing is closed, which the account page
// reads as closed rather than as an outage.
export const CHECKOUT_CLOSED = "Checkout is not open yet.";

// Checkout's answer when the price the page showed is no longer the one it
// would charge: the page reloads the price and asks for agreement again.
export const PRICE_CHANGED = "The price has changed. Check the new price and agree again.";

// The plans checkout sells, by the names a checkout request, `status()`, and
// the billing metrics use.
export const BILLING_PLANS = ["monthly", "yearly", "founding"] as const;
export type Plan = (typeof BILLING_PLANS)[number];
export const isPlan = (plan: unknown): plan is Plan => (BILLING_PLANS as readonly unknown[]).includes(plan);

// A name the founders row shows: 1–64 code points, none a control, format, or
// line or paragraph separator, without padding. The account page checks it
// before sending; the founder route and dormouse_founders' CHECK refuse
// anything else.
const FOUNDER_NAME = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,64}$/u;
export const isFounderName = (name: unknown): name is string =>
  typeof name === "string" && FOUNDER_NAME.test(name) && name === name.trim();
