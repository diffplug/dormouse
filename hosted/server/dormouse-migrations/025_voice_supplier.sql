-- Up Migration
-- The ElevenLabs plan the voice Worker last read: one row, replaced by each
-- daily read (docs/specs/hosted.md -> "Supplier plan").
CREATE TABLE dormouse_voice_supplier (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    tier text NOT NULL CHECK (char_length(tier) <= 64),
    status text NOT NULL CHECK (char_length(status) <= 64),
    used bigint NOT NULL,
    "limit" bigint NOT NULL,
    "resetsAt" timestamptz,
    "changeTo" text CHECK (char_length("changeTo") <= 64),
    "changeAt" timestamptz,
    "checkedAt" timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE dormouse_voice_supplier;
