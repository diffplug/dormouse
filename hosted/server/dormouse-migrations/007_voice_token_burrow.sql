-- Up Migration
-- A signed-in desktop's voice token (docs/specs/hosted.md -> "Managed voice"):
-- the device-code redemption that enrolls a Burrow mints one, owned by the same
-- account and gone with that Burrow, so removing a computer from the account
-- revokes its voice too. A token minted on the account page names no Burrow.
ALTER TABLE dormouse_voice_tokens
    ADD COLUMN "burrowId" text UNIQUE
        REFERENCES dormouse_relay_burrows ("burrowId") ON DELETE CASCADE;

-- Down Migration
ALTER TABLE dormouse_voice_tokens DROP COLUMN "burrowId";
