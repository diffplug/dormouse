-- Up Migration
-- The consent an account gave when it started a checkout (docs/specs/hosted.md
-- -> "Billing"): a row exists only for a checkout started after agreeing to
-- the terms version it names and to automatic renewal, for the plan and Price
-- that checkout offered. One row per checkout and terms version, never edited.
-- No foreign key: like pgstencil_billing's rows, it is a billing record kept
-- after the account is deleted.
CREATE TABLE dormouse_checkout_consents (
    "checkoutId" text NOT NULL,
    "termsVersion" text NOT NULL,
    "userId" text NOT NULL,
    plan text NOT NULL,
    "priceId" text NOT NULL,
    "consentedAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("checkoutId", "termsVersion")
);
CREATE INDEX dormouse_checkout_consents_user ON dormouse_checkout_consents ("userId");

-- Down Migration
DROP TABLE dormouse_checkout_consents;
