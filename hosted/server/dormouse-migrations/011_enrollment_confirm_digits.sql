-- Up Migration
-- The two digits the approver typed (docs/specs/hosted.md -> "Burrow
-- enrollment"): a poll redeems an approval only where they are its user
-- code's confirmation digits, and marks one where they are not, for its
-- approver's page. An approval from before them, which no desktop could have
-- confirmed, is dropped.
DELETE FROM dormouse_relay_enrollment_approvals;
ALTER TABLE dormouse_relay_enrollment_approvals
    ADD COLUMN "confirmDigits" text NOT NULL CHECK ("confirmDigits" ~ '^[0-9]{2}$'),
    ADD COLUMN "mismatchedAt" timestamptz;

-- Down Migration
ALTER TABLE dormouse_relay_enrollment_approvals DROP COLUMN "mismatchedAt", DROP COLUMN "confirmDigits";
