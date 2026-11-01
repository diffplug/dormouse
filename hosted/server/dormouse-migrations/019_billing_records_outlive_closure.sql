-- Up Migration
-- A payment dispute's suspension is a billing record like the others
-- (docs/specs/hosted.md -> "Billing"): no foreign key, so a dispute on a
-- closed account still records, and a lost one still ends its subscription.
ALTER TABLE dormouse_billing_disputes DROP CONSTRAINT "dormouse_billing_disputes_userId_fkey";
-- When the cron last read the dispute's status from Stripe; it reads the
-- least recently checked first, so a missed close event cannot suspend an
-- account for good.
ALTER TABLE dormouse_billing_disputes ADD COLUMN "checkedAt" timestamptz;

-- When every payment the closure refunds had been refunded in full, or the
-- closure was found to refund none; the cron retries until it is set. A
-- closure recorded before closures refunded refunds nothing.
ALTER TABLE dormouse_account_closures ADD COLUMN "settledAt" timestamptz;
UPDATE dormouse_account_closures SET "settledAt" = "closedAt";

-- Down Migration
ALTER TABLE dormouse_account_closures DROP COLUMN "settledAt";
ALTER TABLE dormouse_billing_disputes DROP COLUMN "checkedAt";
DELETE FROM dormouse_billing_disputes d WHERE NOT EXISTS (SELECT FROM "user" u WHERE u.id = d."userId");
ALTER TABLE dormouse_billing_disputes
    ADD CONSTRAINT "dormouse_billing_disputes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" (id) ON DELETE CASCADE;
