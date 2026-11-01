-- Up Migration
-- When the cron last tried to settle a withdrawal, or to finish a closure's
-- refunds (docs/specs/hosted.md -> "Billing"): it retries every unsettled
-- one however old, the least recently tried first, so one that keeps failing
-- never starves the rest.
ALTER TABLE dormouse_withdrawals ADD COLUMN "attemptedAt" timestamptz;
ALTER TABLE dormouse_account_closures ADD COLUMN "attemptedAt" timestamptz;
CREATE INDEX dormouse_withdrawals_unsettled ON dormouse_withdrawals ("attemptedAt") WHERE "settledAt" IS NULL;
CREATE INDEX dormouse_account_closures_unsettled ON dormouse_account_closures ("attemptedAt") WHERE "settledAt" IS NULL;

-- Down Migration
DROP INDEX dormouse_account_closures_unsettled;
DROP INDEX dormouse_withdrawals_unsettled;
ALTER TABLE dormouse_account_closures DROP COLUMN "attemptedAt";
ALTER TABLE dormouse_withdrawals DROP COLUMN "attemptedAt";
