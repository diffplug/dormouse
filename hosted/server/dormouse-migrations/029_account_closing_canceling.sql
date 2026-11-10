-- Up Migration
-- The subscriptions a closure in progress is about to cancel, written before
-- its first Stripe cancel and kept across a failed attempt, so the retry
-- refunds one whose cancel landed in Stripe but was never recorded here
-- (docs/specs/hosted.md -> "Account closure").
ALTER TABLE dormouse_account_closing ADD COLUMN "canceling" text[] NOT NULL DEFAULT '{}';

-- Down Migration
ALTER TABLE dormouse_account_closing DROP COLUMN "canceling";
