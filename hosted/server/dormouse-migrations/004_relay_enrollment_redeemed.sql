-- Up Migration
-- A redeemed device-code approval (docs/specs/hosted.md -> "Burrow enrollment"):
-- the first poll whose device code derives the user code enrolls a Burrow owned
-- by "userId" and marks the row redeemed, which it stays until it expires, so a
-- poll whose answer was lost learns it was spent. "redeemedBurrowId" names no
-- foreign key: removing that Burrow must never make the approval redeemable
-- again.
ALTER TABLE dormouse_relay_enrollment_approvals
    ADD COLUMN "redeemedBurrowId" text,
    ADD COLUMN "redeemedAt" timestamptz,
    ADD CONSTRAINT dormouse_relay_enrollment_approvals_redeemed
        CHECK (("redeemedBurrowId" IS NULL) = ("redeemedAt" IS NULL));

-- Down Migration
ALTER TABLE dormouse_relay_enrollment_approvals
    DROP CONSTRAINT dormouse_relay_enrollment_approvals_redeemed,
    DROP COLUMN "redeemedAt",
    DROP COLUMN "redeemedBurrowId";
