-- Up Migration
-- An EEA or UK consumer's withdrawal from a subscription contract, submitted
-- online (docs/specs/hosted.md -> "Billing"): one row per contract, the
-- Stripe subscription it ends, written before the submission is answered.
-- `acknowledgedAt` is when the emailed acknowledgement went out, and
-- `settledAt` when the subscription had ended and every payment for it was
-- refunded; the cron retries either until it is set. No foreign key: like
-- the checkout consents, it is a billing record kept after the account is
-- deleted.
CREATE TABLE dormouse_withdrawals (
    id text PRIMARY KEY,
    "userId" text NOT NULL,
    "subscriptionId" text NOT NULL UNIQUE,
    plan text NOT NULL,
    "priceId" text NOT NULL,
    "contractStartedAt" timestamptz NOT NULL,
    -- The billing address's country Stripe held, or null when unknown.
    country text,
    "submittedAt" timestamptz NOT NULL,
    "acknowledgedAt" timestamptz,
    "settledAt" timestamptz
);
CREATE INDEX dormouse_withdrawals_user ON dormouse_withdrawals ("userId");

-- An account closed from its own page, and the subscriptions closing it
-- canceled in Stripe first. No foreign key, for the same reason.
CREATE TABLE dormouse_account_closures (
    "userId" text PRIMARY KEY,
    "canceledSubscriptions" text[] NOT NULL,
    "closedAt" timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE dormouse_account_closures;
DROP TABLE dormouse_withdrawals;
