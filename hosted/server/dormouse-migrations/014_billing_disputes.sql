-- Up Migration
-- An open payment dispute suspends its account's subscription without ending
-- it (docs/specs/hosted.md -> "Billing"): one row per dispute Stripe holds
-- open, deleted when it closes. The entitlement refuses an account with any.
CREATE TABLE dormouse_billing_disputes (
    "disputeId" text PRIMARY KEY,
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    "openedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dormouse_billing_disputes_user ON dormouse_billing_disputes ("userId");

-- Down Migration
DROP TABLE dormouse_billing_disputes;
