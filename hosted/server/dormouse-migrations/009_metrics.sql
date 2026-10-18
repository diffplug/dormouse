-- Up Migration
-- Launch metrics (docs/specs/hosted.md -> "Metrics"): aggregate daily counts,
-- one row per UTC day, event, and allowlisted label. No column can hold who.

CREATE TABLE dormouse_metrics_daily (
    day date NOT NULL,
    event text NOT NULL CHECK (event ~ '^[a-z_]+(\.[a-z_-]+)?$' AND char_length(event) <= 40),
    -- '' for an event without labels; otherwise lowercase words from a fixed list.
    label text NOT NULL CHECK (label ~ '^[a-z0-9:-]*$' AND char_length(label) <= 40),
    count bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (day, event, label)
);

-- The ref a checkout started under, until its completion is counted or it
-- expires: what lets `checkout.completed` count by ref.
CREATE TABLE dormouse_checkout_refs (
    "checkoutId" text PRIMARY KEY,
    ref text NOT NULL CHECK (ref ~ '^[a-z0-9-]*$' AND char_length(ref) <= 40),
    "startedAt" timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE dormouse_checkout_refs;
DROP TABLE dormouse_metrics_daily;
