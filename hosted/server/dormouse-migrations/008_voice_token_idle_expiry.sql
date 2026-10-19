-- Up Migration
-- A voice token lives until a year passes without a speak, or until its
-- computer disconnects or the account turns Hosted Voice off, both of which
-- delete it (docs/specs/hosted.md -> "Managed voice"). Nothing reads a
-- revocation any more.
DELETE FROM dormouse_voice_tokens WHERE "revokedAt" IS NOT NULL;
ALTER TABLE dormouse_voice_tokens DROP COLUMN "revokedAt";

-- Down Migration
ALTER TABLE dormouse_voice_tokens ADD COLUMN "revokedAt" timestamptz;
