-- Up Migration
ALTER TABLE dormouse_relay_enrollment_approvals
    ADD COLUMN purpose text NOT NULL DEFAULT 'remote' CHECK (purpose IN ('remote', 'voice')),
    DROP CONSTRAINT dormouse_relay_enrollment_approvals_redeemed,
    ADD CONSTRAINT dormouse_relay_enrollment_approvals_redeemed
        CHECK (CASE WHEN purpose = 'remote'
            THEN ("redeemedBurrowId" IS NULL) = ("redeemedAt" IS NULL)
            ELSE "redeemedBurrowId" IS NULL END);
-- Existing voice credentials become independent too. Keep the nullable legacy
-- column so rolling deployments can still read it.
UPDATE dormouse_voice_tokens SET "burrowId" = NULL;

-- Down Migration
DELETE FROM dormouse_relay_enrollment_approvals WHERE purpose = 'voice';
ALTER TABLE dormouse_relay_enrollment_approvals
    DROP CONSTRAINT dormouse_relay_enrollment_approvals_redeemed,
    DROP COLUMN purpose,
    ADD CONSTRAINT dormouse_relay_enrollment_approvals_redeemed
        CHECK (("redeemedBurrowId" IS NULL) = ("redeemedAt" IS NULL));
