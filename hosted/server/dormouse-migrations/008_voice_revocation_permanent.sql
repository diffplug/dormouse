-- Up Migration
-- Revocation is permanent (docs/specs/hosted.md -> "Managed voice"), now that
-- the relay and voice roles may write "revokedAt": a revoked token's stays.
CREATE FUNCTION dormouse_voice_tokens_keep_revoked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
        RAISE EXCEPTION 'a revoked voice token stays revoked' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;
-- A trigger fires without EXECUTE, so no role needs to call it.
REVOKE ALL ON FUNCTION dormouse_voice_tokens_keep_revoked() FROM PUBLIC;
CREATE TRIGGER dormouse_voice_tokens_keep_revoked
    BEFORE UPDATE OF "revokedAt" ON dormouse_voice_tokens
    FOR EACH ROW EXECUTE FUNCTION dormouse_voice_tokens_keep_revoked();

-- Down Migration
DROP TRIGGER dormouse_voice_tokens_keep_revoked ON dormouse_voice_tokens;
DROP FUNCTION dormouse_voice_tokens_keep_revoked();
