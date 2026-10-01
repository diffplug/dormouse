-- Up Migration
-- The Hosted Relay's Web Push subscriptions (docs/specs/hosted.md -> "Relay";
-- the shared rules are docs/specs/relay.md -> "Web Push" and "State files").
-- Keyed on the pair (burrowId, deliveryId); the account is the Burrow's
-- owner, so removing a Burrow, or its account, drops its subscriptions. Every
-- field is bounded as the self-host Relay bounds it.
CREATE TABLE dormouse_relay_push_subscriptions (
    "burrowId" text NOT NULL REFERENCES dormouse_relay_burrows ("burrowId") ON DELETE CASCADE,
    "deliveryId" text NOT NULL CHECK ("deliveryId" ~ '^[A-Za-z0-9_-]{43}$'),
    endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 1024),
    p256dh text NOT NULL CHECK (length(p256dh) BETWEEN 1 AND 88),
    auth text NOT NULL CHECK (length(auth) BETWEEN 1 AND 24),
    -- The VAPID public key the row was registered under: a rotation reads as
    -- stale rather than working.
    "vapidPublicKey" text NOT NULL CHECK ("vapidPublicKey" ~ '^[A-Za-z0-9_-]{87}$'),
    "subscribedAt" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("burrowId", "deliveryId")
);
CREATE INDEX dormouse_relay_push_subscriptions_delivery ON dormouse_relay_push_subscriptions ("deliveryId");
CREATE INDEX dormouse_relay_push_subscriptions_endpoint ON dormouse_relay_push_subscriptions (endpoint);

-- Down Migration
DROP TABLE dormouse_relay_push_subscriptions;
