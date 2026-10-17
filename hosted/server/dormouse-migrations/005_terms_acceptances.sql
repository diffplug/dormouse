-- Up Migration
-- Each version of the Hosted terms an account agreed to by continuing past the
-- sign-in notice (docs/specs/hosted.md -> "Terms acceptance"), first time only.
CREATE TABLE dormouse_terms_acceptances (
    "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    version text NOT NULL,
    "acceptedAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("userId", version)
);

-- Down Migration
DROP TABLE dormouse_terms_acceptances;
