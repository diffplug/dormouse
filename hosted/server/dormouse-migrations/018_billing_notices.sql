-- Up Migration
-- A list price change the operator schedules (hosted/README.md -> "Change a
-- price"): subscriptions on `fromPriceId` move to `toPriceId` from their first
-- renewal on or after `effectiveAt` whose notice went out in time
-- (docs/specs/hosted.md -> "Billing notices"). The amounts are whole US
-- dollars per interval, checked against Stripe before any notice names them.
CREATE TABLE dormouse_price_changes (
    id text PRIMARY KEY,
    plan text NOT NULL CHECK (plan IN ('monthly', 'yearly')),
    "fromPriceId" text NOT NULL UNIQUE CHECK ("fromPriceId" ~ '^price_[A-Za-z0-9_]{1,200}$'),
    "toPriceId" text NOT NULL CHECK ("toPriceId" ~ '^price_[A-Za-z0-9_]{1,200}$'),
    "fromUsd" integer NOT NULL CHECK ("fromUsd" > 0),
    "toUsd" integer NOT NULL CHECK ("toUsd" > 0),
    "effectiveAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    CHECK ("fromPriceId" <> "toPriceId")
);

-- Each subscription notice, recorded before it is sent and stamped once the
-- mail service accepted it: a renewal notice or annual reminder per
-- subscription and renewal, a price-change notice per subscription and the
-- renewal it applies at, a dispute's suspension and restoration per dispute.
-- The unique indexes make each one once, however often the cron or a
-- webhook redelivery asks. No foreign key to the account: like the
-- withdrawals, it is a billing record kept after the account is deleted.
CREATE TABLE dormouse_billing_notices (
    id text PRIMARY KEY,
    "userId" text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('renewal', 'annual', 'price_change', 'dispute_suspended', 'dispute_restored')),
    "subscriptionId" text,
    -- The renewal the notice precedes.
    "renewsAt" timestamptz,
    "priceChangeId" text REFERENCES dormouse_price_changes (id),
    "disputeId" text,
    "createdAt" timestamptz NOT NULL,
    -- A send in progress holds the notice until a lease past this expires.
    "attemptedAt" timestamptz,
    -- The billing email it went to, and when the mail service accepted it.
    email text,
    "sentAt" timestamptz,
    -- When its subscription moved to the change's new Price.
    "appliedAt" timestamptz,
    CHECK ((kind IN ('renewal', 'annual', 'price_change')) = ("subscriptionId" IS NOT NULL AND "renewsAt" IS NOT NULL)),
    CHECK ((kind = 'price_change') = ("priceChangeId" IS NOT NULL)),
    CHECK ((kind IN ('dispute_suspended', 'dispute_restored')) = ("disputeId" IS NOT NULL)),
    CHECK (("sentAt" IS NULL) = (email IS NULL)),
    -- PRICE_NOTICE_MIN_DAYS in hosted/server/notices.ts: a price change applies
    -- only after a notice sent at least that long before its renewal.
    CHECK ("appliedAt" IS NULL OR "sentAt" <= "renewsAt" - interval '7 days')
);
CREATE UNIQUE INDEX dormouse_billing_notices_renewal
    ON dormouse_billing_notices (kind, "subscriptionId", "renewsAt") WHERE "subscriptionId" IS NOT NULL;
CREATE UNIQUE INDEX dormouse_billing_notices_dispute
    ON dormouse_billing_notices (kind, "disputeId") WHERE "disputeId" IS NOT NULL;
CREATE INDEX dormouse_billing_notices_unsent ON dormouse_billing_notices ("createdAt") WHERE "sentAt" IS NULL;

-- Down Migration
DROP TABLE dormouse_billing_notices;
DROP TABLE dormouse_price_changes;
