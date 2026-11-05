-- Up Migration
-- What the billing cron's failure alert last mailed (docs/specs/hosted.md ->
-- "Billing alert"): one row per distinct error line, by its SHA-256, so a
-- persistent failure mails once a day. It keeps no error text.
CREATE TABLE dormouse_billing_alerts (
    fingerprint text PRIMARY KEY CHECK (char_length(fingerprint) = 64),
    -- A send in progress holds the line until a lease past this expires.
    "attemptedAt" timestamptz NOT NULL,
    -- When the mail service last accepted a mail carrying it.
    "sentAt" timestamptz
);

-- Down Migration
DROP TABLE dormouse_billing_alerts;
