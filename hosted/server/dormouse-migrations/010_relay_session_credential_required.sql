-- Up Migration
-- Every session names the passkey that signed it in, so removing that passkey
-- ends it (docs/specs/hosted.md -> "Burrow enrollment"). A session minted
-- before 009 names none and is deleted here; its holder signs in again.
DELETE FROM dormouse_relay_sessions WHERE "credentialId" IS NULL;
ALTER TABLE dormouse_relay_sessions ALTER COLUMN "credentialId" SET NOT NULL;

-- Down Migration
ALTER TABLE dormouse_relay_sessions ALTER COLUMN "credentialId" DROP NOT NULL;
