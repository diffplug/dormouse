-- Up Migration
-- The Hosted Relay's account-scoped state (docs/specs/hosted.md -> "Relay").
-- Every bearer secret is stored only as its SHA-256 (hex): session tokens,
-- Burrow tokens, and setup tokens. An enrollment device code is stored not at
-- all. An account's rows die with it.

-- Burrows an account enrolled. `burrowId` is the 16-byte base64url routing id
-- every e2e envelope carries; removal deletes the row, and its setup tokens
-- and setup challenges with it.
CREATE TABLE dormouse_relay_burrows (
    "burrowId" text PRIMARY KEY CHECK ("burrowId" ~ '^[A-Za-z0-9_-]{22}$'),
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    "tokenHash" text NOT NULL UNIQUE,
    "enrolledAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dormouse_relay_burrows_user ON dormouse_relay_burrows ("userId");

-- Passkeys registered off a setup code an account's own Burrow minted.
CREATE TABLE dormouse_relay_passkeys (
    "credentialId" text PRIMARY KEY,
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    "publicKey" text NOT NULL,
    label text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dormouse_relay_passkeys_user ON dormouse_relay_passkeys ("userId");

-- Pocket sign-in sessions: the bearer for session-gated routes.
CREATE TABLE dormouse_relay_sessions (
    "tokenHash" text PRIMARY KEY,
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    "expiresAt" timestamptz NOT NULL
);
CREATE INDEX dormouse_relay_sessions_user ON dormouse_relay_sessions ("userId");
CREATE INDEX dormouse_relay_sessions_expiry ON dormouse_relay_sessions ("expiresAt");

-- Single-use WebAuthn challenges. A setup challenge names the Burrow whose
-- setup token began it, so only that Burrow's tokens can finish it; a sign-in
-- challenge is the one with no Burrow.
CREATE TABLE dormouse_relay_challenges (
    challenge text PRIMARY KEY,
    "burrowId" text REFERENCES dormouse_relay_burrows ("burrowId") ON DELETE CASCADE,
    "expiresAt" timestamptz NOT NULL
);
CREATE INDEX dormouse_relay_challenges_expiry ON dormouse_relay_challenges ("expiresAt");
CREATE INDEX dormouse_relay_challenges_burrow ON dormouse_relay_challenges ("burrowId");

-- Presence nonces: each holds the binding its challenge is recomputed from.
CREATE TABLE dormouse_relay_presence_nonces (
    nonce text PRIMARY KEY,
    "sessionTokenHash" text NOT NULL REFERENCES dormouse_relay_sessions ("tokenHash") ON DELETE CASCADE,
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    binding jsonb NOT NULL,
    "expiresAt" timestamptz NOT NULL
);
CREATE INDEX dormouse_relay_presence_nonces_session ON dormouse_relay_presence_nonces ("sessionTokenHash");
CREATE INDEX dormouse_relay_presence_nonces_expiry ON dormouse_relay_presence_nonces ("expiresAt");

-- The single-use credential behind a Burrow's pairing QR.
CREATE TABLE dormouse_relay_setup_tokens (
    "tokenHash" text PRIMARY KEY,
    "burrowId" text NOT NULL REFERENCES dormouse_relay_burrows ("burrowId") ON DELETE CASCADE,
    "expiresAt" timestamptz NOT NULL
);
CREATE INDEX dormouse_relay_setup_tokens_burrow ON dormouse_relay_setup_tokens ("burrowId");
CREATE INDEX dormouse_relay_setup_tokens_expiry ON dormouse_relay_setup_tokens ("expiresAt");

-- Device-code enrollment approvals: the account approved this user code, and
-- the first poll whose device code derives it enrolls a Burrow owned by
-- "userId" and deletes the row. Begin writes nothing.
CREATE TABLE dormouse_relay_enrollment_approvals (
    "userCode" text PRIMARY KEY CHECK ("userCode" ~ '^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$'),
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    "expiresAt" timestamptz NOT NULL
);
CREATE INDEX dormouse_relay_enrollment_approvals_user ON dormouse_relay_enrollment_approvals ("userId");
CREATE INDEX dormouse_relay_enrollment_approvals_expiry ON dormouse_relay_enrollment_approvals ("expiresAt");

-- Down Migration
DROP TABLE dormouse_relay_enrollment_approvals;
DROP TABLE dormouse_relay_setup_tokens;
DROP TABLE dormouse_relay_presence_nonces;
DROP TABLE dormouse_relay_challenges;
DROP TABLE dormouse_relay_sessions;
DROP TABLE dormouse_relay_passkeys;
DROP TABLE dormouse_relay_burrows;
