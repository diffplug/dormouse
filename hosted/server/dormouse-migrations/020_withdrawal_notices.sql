-- Up Migration
-- A withdrawal's emailed acknowledgement is a billing notice like the others
-- (docs/specs/hosted.md -> "Billing notices"): recorded in the statement that
-- records its withdrawal, then leased, sent, and retried with them, one per
-- withdrawal.
ALTER TABLE dormouse_billing_notices ADD COLUMN "withdrawalId" text REFERENCES dormouse_withdrawals (id);
ALTER TABLE dormouse_billing_notices DROP CONSTRAINT dormouse_billing_notices_kind_check;
ALTER TABLE dormouse_billing_notices ADD CONSTRAINT dormouse_billing_notices_kind_check
    CHECK (kind IN ('renewal', 'annual', 'price_change', 'dispute_suspended', 'dispute_restored', 'withdrawal'));
ALTER TABLE dormouse_billing_notices ADD CONSTRAINT dormouse_billing_notices_withdrawal_check
    CHECK ((kind = 'withdrawal') = ("withdrawalId" IS NOT NULL));
CREATE UNIQUE INDEX dormouse_billing_notices_withdrawal
    ON dormouse_billing_notices ("withdrawalId") WHERE "withdrawalId" IS NOT NULL;

-- Each recorded withdrawal's acknowledgement, sent when `acknowledgedAt` says;
-- one sent before this migration kept no address, so its email is empty.
INSERT INTO dormouse_billing_notices (id, "userId", kind, "withdrawalId", "createdAt", "sentAt", email)
SELECT gen_random_uuid()::text, "userId", 'withdrawal', id, "submittedAt", "acknowledgedAt",
    CASE WHEN "acknowledgedAt" IS NOT NULL THEN '' END
FROM dormouse_withdrawals;
ALTER TABLE dormouse_withdrawals DROP COLUMN "acknowledgedAt";

-- Down Migration
ALTER TABLE dormouse_withdrawals ADD COLUMN "acknowledgedAt" timestamptz;
UPDATE dormouse_withdrawals w SET "acknowledgedAt" = n."sentAt"
FROM dormouse_billing_notices n WHERE n."withdrawalId" = w.id;
DELETE FROM dormouse_billing_notices WHERE kind = 'withdrawal';
DROP INDEX dormouse_billing_notices_withdrawal;
ALTER TABLE dormouse_billing_notices DROP CONSTRAINT dormouse_billing_notices_withdrawal_check;
ALTER TABLE dormouse_billing_notices DROP CONSTRAINT dormouse_billing_notices_kind_check;
ALTER TABLE dormouse_billing_notices ADD CONSTRAINT dormouse_billing_notices_kind_check
    CHECK (kind IN ('renewal', 'annual', 'price_change', 'dispute_suspended', 'dispute_restored'));
ALTER TABLE dormouse_billing_notices DROP COLUMN "withdrawalId";
