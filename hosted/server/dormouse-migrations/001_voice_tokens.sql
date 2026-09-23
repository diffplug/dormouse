-- Up Migration
-- Managed voice test slice (docs/specs/hosted.md -> "Managed voice").
-- Only the SHA-256 of a voice token is stored; the plaintext is shown once at mint.
CREATE TABLE dormouse_voice_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    hash text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "lastUsedAt" timestamptz,
    "revokedAt" timestamptz
);
CREATE INDEX dormouse_voice_tokens_user ON dormouse_voice_tokens ("userId");

-- Speak requests per user per UTC day, incremented atomically before each upstream call.
CREATE TABLE dormouse_voice_usage (
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    day date NOT NULL,
    count integer NOT NULL,
    PRIMARY KEY ("userId", day)
);

-- Down Migration
DROP TABLE dormouse_voice_usage;
DROP TABLE dormouse_voice_tokens;
