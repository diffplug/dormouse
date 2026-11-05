-- Up Migration
-- What a checkout's consent was given to (docs/specs/hosted.md -> "Billing"):
-- the whole-dollar USD price the page showed, the daily Natural Voice cap it
-- offered, and the text of what it stated, the terms themselves being archived
-- by `termsVersion`. A row from before this migration has none: billing never
-- opened, so none is a purchase. NOT VALID holds every later row to them.
ALTER TABLE dormouse_checkout_consents
    ADD COLUMN "shownUsd" integer,
    ADD COLUMN "voiceDailyCap" integer,
    ADD COLUMN "presentedText" text,
    ADD CONSTRAINT dormouse_checkout_consents_evidence_check
        CHECK ("shownUsd" IS NOT NULL AND "voiceDailyCap" IS NOT NULL AND "presentedText" IS NOT NULL) NOT VALID;

-- Down Migration
ALTER TABLE dormouse_checkout_consents
    DROP CONSTRAINT dormouse_checkout_consents_evidence_check,
    DROP COLUMN "presentedText",
    DROP COLUMN "voiceDailyCap",
    DROP COLUMN "shownUsd";
