-- Up Migration
-- An account removes a passkey from its account page (docs/specs/hosted.md ->
-- "Burrow enrollment"), and every session it signed in goes with it.
-- "burrowId" names the computer whose setup code registered the passkey, so
-- the page can say where it came from; removing that computer leaves the
-- passkey, unattributed, since a phone signs in to every computer of the
-- account with it. A passkey registered before this has none. A session
-- minted before this names no credential and lives out its 12 hours.
ALTER TABLE dormouse_relay_passkeys
    ADD COLUMN "burrowId" text REFERENCES dormouse_relay_burrows ("burrowId") ON DELETE SET NULL;
CREATE INDEX dormouse_relay_passkeys_burrow ON dormouse_relay_passkeys ("burrowId");
ALTER TABLE dormouse_relay_sessions
    ADD COLUMN "credentialId" text REFERENCES dormouse_relay_passkeys ("credentialId") ON DELETE CASCADE;
CREATE INDEX dormouse_relay_sessions_credential ON dormouse_relay_sessions ("credentialId");

-- Down Migration
DROP INDEX dormouse_relay_sessions_credential;
ALTER TABLE dormouse_relay_sessions DROP COLUMN "credentialId";
DROP INDEX dormouse_relay_passkeys_burrow;
ALTER TABLE dormouse_relay_passkeys DROP COLUMN "burrowId";
