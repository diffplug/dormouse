-- Up Migration
CREATE SCHEMA preview;
CREATE TABLE preview.email_messages (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    captured_at timestamptz NOT NULL DEFAULT now(),
    message jsonb NOT NULL
);
CREATE INDEX email_messages_captured_at ON preview.email_messages (captured_at);

-- Down Migration
DROP TABLE preview.email_messages;
DROP SCHEMA preview;
