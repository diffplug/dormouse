-- Up Migration
-- An account closure in progress, written before its Stripe calls and
-- deleted with the account (docs/specs/hosted.md -> "Account closure"):
-- while it stands, checkout opens nothing for the account.
CREATE TABLE dormouse_account_closing (
    "userId" text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
    "startedAt" timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE dormouse_account_closing;
