-- Up Migration
-- Hosted's aggregate daily counts (docs/specs/hosted.md -> "Metrics"): how
-- many times each event happened on a UTC day, under one of its event's
-- fixed labels ('' for none). A row describes no one, so rows are kept
-- forever. The CHECKs refuse what an identifier would need: an address's @
-- and dots, capitals, spaces, or more than 40 characters.
CREATE TABLE dormouse_metrics_daily (
    day date NOT NULL,
    event text NOT NULL CHECK (char_length(event) <= 40 AND event ~ '^[a-z_]+(\.[a-z_-]+)?$'),
    label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 40 AND label ~ '^[a-z0-9:-]*$'),
    count bigint NOT NULL CHECK (count >= 0),
    PRIMARY KEY (day, event, label)
);

-- Down Migration
DROP TABLE dormouse_metrics_daily;
