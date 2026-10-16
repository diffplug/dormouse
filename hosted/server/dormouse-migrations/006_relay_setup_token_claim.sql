-- Up Migration
-- A setup token a `finish` holds (docs/specs/hosted.md -> "Relay"): claimed in
-- place rather than deleted, so a retire still finds and kills it, and the
-- finish's restore, which only clears the flag, then has nothing to put back.
ALTER TABLE dormouse_relay_setup_tokens
    ADD COLUMN claimed boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE dormouse_relay_setup_tokens DROP COLUMN claimed;
