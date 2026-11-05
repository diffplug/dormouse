-- Up Migration
-- A completed checkout's emailed confirmation is a billing notice like the
-- others (docs/specs/hosted.md -> "Billing notices"): recorded in the webhook's
-- transaction, then leased, sent, and retried with them, one per subscription.
-- `checkoutId` finds the consent it repeats.
ALTER TABLE dormouse_billing_notices ADD COLUMN "checkoutId" text;
ALTER TABLE dormouse_billing_notices DROP CONSTRAINT dormouse_billing_notices_kind_check;
ALTER TABLE dormouse_billing_notices ADD CONSTRAINT dormouse_billing_notices_kind_check
    CHECK (kind IN ('renewal', 'annual', 'price_change', 'dispute_suspended', 'dispute_restored', 'withdrawal', 'purchase'));
ALTER TABLE dormouse_billing_notices ADD CONSTRAINT dormouse_billing_notices_purchase_check
    CHECK ((kind = 'purchase') = ("checkoutId" IS NOT NULL) AND (kind <> 'purchase' OR "subscriptionId" IS NOT NULL));
CREATE UNIQUE INDEX dormouse_billing_notices_purchase
    ON dormouse_billing_notices ("subscriptionId") WHERE kind = 'purchase';

-- Down Migration
DELETE FROM dormouse_billing_notices WHERE kind = 'purchase';
DROP INDEX dormouse_billing_notices_purchase;
ALTER TABLE dormouse_billing_notices DROP CONSTRAINT dormouse_billing_notices_purchase_check;
ALTER TABLE dormouse_billing_notices DROP CONSTRAINT dormouse_billing_notices_kind_check;
ALTER TABLE dormouse_billing_notices ADD CONSTRAINT dormouse_billing_notices_kind_check
    CHECK (kind IN ('renewal', 'annual', 'price_change', 'dispute_suspended', 'dispute_restored', 'withdrawal'));
ALTER TABLE dormouse_billing_notices DROP COLUMN "checkoutId";
